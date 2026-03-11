import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  createStore,
  type CollectionConfig,
  type EmbedResult,
  type HybridQueryResult,
  type IndexStatus,
  type QMDStore,
  type SearchResult
} from '@tobilu/qmd'

export interface QMDCollectionDefinition {
  name: string
  dir: string
  pattern?: string
}

export type QMDSearchMode = 'query' | 'search'

export type QMDStoreRow = Record<string, unknown>

export class QMDWriteLockTimeoutError extends Error {
  public constructor(operation: string, lockPath: string) {
    super(`Timed out waiting for QMD ${operation} lock at ${lockPath}`)
    this.name = 'QMDWriteLockTimeoutError'
  }
}

const DEFAULT_PATTERN = '**/*.md'
const storePromises = new Map<string, Promise<QMDStore>>()
const writeChains = new Map<string, Promise<void>>()
const QMD_WRITE_LOCK_RETRY_MS = 250
const QMD_WRITE_LOCK_TIMEOUT_MS = 60_000
const QMD_WRITE_LOCK_STALE_MS = 15 * 60 * 1_000

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function getQMDDbPath(indexName: string): string {
  const cacheRoot = process.env['XDG_CACHE_HOME']
    ? path.join(process.env['XDG_CACHE_HOME'], 'qmd')
    : path.join(os.homedir(), '.cache', 'qmd')

  return path.join(cacheRoot, `${indexName}.sqlite`)
}

function getQMDWriteLockPath(indexName: string): string {
  return `${getQMDDbPath(indexName)}.write.lock`
}

function buildStoreConfig(
  collections: QMDCollectionDefinition[]
): CollectionConfig {
  return {
    collections: Object.fromEntries(
      collections.map((collection) => [
        collection.name,
        {
          path: collection.dir,
          pattern: collection.pattern || DEFAULT_PATTERN
        }
      ])
    )
  }
}

async function ensureCollectionDirectories(
  collections: QMDCollectionDefinition[]
): Promise<void> {
  const uniqueDirs = [...new Set(collections.map((collection) => collection.dir))]
  await Promise.all(
    uniqueDirs.map((dirPath) => fs.promises.mkdir(dirPath, { recursive: true }))
  )
}

async function ensureStoreRoot(indexName: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(getQMDDbPath(indexName)), {
    recursive: true
  })
}

function applyStoreDbPragmas(store: QMDStore): void {
  const db = store.internal?.db as { exec?: (sql: string) => unknown } | undefined
  if (!db?.exec) {
    return
  }

  try {
    db.exec('PRAGMA busy_timeout = 5000')
  } catch {
    // Ignore optional tuning failures. The store remains usable without this.
  }
}

async function storeHasRequiredCollections(
  store: QMDStore,
  collections: QMDCollectionDefinition[]
): Promise<boolean> {
  const requiredCollections = new Set(
    collections.map((collection) => collection.name).filter(Boolean)
  )
  if (requiredCollections.size === 0) {
    return true
  }

  const existingCollections = new Set(
    (await store.listCollections()).map((collection) => collection.name)
  )

  for (const collectionName of requiredCollections) {
    if (!existingCollections.has(collectionName)) {
      return false
    }
  }

  return true
}

async function closeStoreQuietly(store: QMDStore | null): Promise<void> {
  if (!store) {
    return
  }

  try {
    await store.close()
  } catch {
    // Ignore cleanup failures during fallback paths.
  }
}

async function maybeClearStaleWriteLock(lockPath: string): Promise<boolean> {
  try {
    const stats = await fs.promises.stat(lockPath)
    if (Date.now() - stats.mtimeMs <= QMD_WRITE_LOCK_STALE_MS) {
      return false
    }

    await fs.promises.unlink(lockPath)
    return true
  } catch {
    return false
  }
}

async function acquireQMDWriteLock(
  indexName: string,
  operation: string
): Promise<() => Promise<void>> {
  const lockPath = getQMDWriteLockPath(indexName)
  const startedAt = Date.now()

  while (true) {
    try {
      const handle = await fs.promises.open(lockPath, 'wx')
      try {
        await handle.writeFile(
          JSON.stringify({
            pid: process.pid,
            operation,
            createdAt: new Date().toISOString()
          }),
          'utf8'
        )
      } finally {
        await handle.close()
      }

      return async (): Promise<void> => {
        await fs.promises.unlink(lockPath).catch(() => undefined)
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EEXIST') {
        throw error
      }

      const clearedStaleLock = await maybeClearStaleWriteLock(lockPath)
      if (clearedStaleLock) {
        continue
      }

      if (Date.now() - startedAt >= QMD_WRITE_LOCK_TIMEOUT_MS) {
        throw new QMDWriteLockTimeoutError(operation, lockPath)
      }

      await wait(QMD_WRITE_LOCK_RETRY_MS)
    }
  }
}

async function withQMDWriteLock<T>(
  indexName: string,
  operation: string,
  task: () => Promise<T>
): Promise<T> {
  const previousWrite = writeChains.get(indexName) || Promise.resolve()
  const nextWrite = previousWrite
    .catch(() => undefined)
    .then(async () => {
      const releaseLock = await acquireQMDWriteLock(indexName, operation)
      try {
        return await task()
      } finally {
        await releaseLock()
      }
    })
  const settledWrite = nextWrite.then(() => undefined, () => undefined)
  writeChains.set(indexName, settledWrite)

  try {
    return await nextWrite
  } finally {
    if (writeChains.get(indexName) === settledWrite) {
      writeChains.delete(indexName)
    }
  }
}

async function openExistingStore(indexName: string): Promise<QMDStore> {
  const store = await createStore({
    dbPath: getQMDDbPath(indexName)
  })
  applyStoreDbPragmas(store)
  return store
}

async function openConfiguredStore(
  indexName: string,
  collections: QMDCollectionDefinition[]
): Promise<QMDStore> {
  const store = await createStore({
    dbPath: getQMDDbPath(indexName),
    config: buildStoreConfig(collections)
  })
  applyStoreDbPragmas(store)
  return store
}

function inferCollectionName(
  filepath: string,
  displayPath: string
): string {
  const qmdPathMatch = filepath.match(/^qmd:\/\/([^/]+)\//i)
  if (qmdPathMatch?.[1]) {
    return qmdPathMatch[1]
  }

  const [firstDisplaySegment] = displayPath.split('/')
  return firstDisplaySegment || ''
}

function toStoreRow(result: SearchResult | HybridQueryResult): QMDStoreRow {
  const filepath = 'filepath' in result ? result.filepath : result.file
  const collectionName =
    'collectionName' in result
      ? result.collectionName
      : inferCollectionName(filepath, result.displayPath)
  const content =
    'bestChunk' in result
      ? result.bestChunk || result.body
      : result.body || ''

  return {
    filepath,
    path: filepath,
    file: filepath,
    source: filepath,
    title: result.title,
    name: result.title,
    content,
    body: content,
    snippet: content,
    context: result.context || null,
    docid: result.docid,
    id: result.docid,
    collection: collectionName,
    collection_name: collectionName,
    collectionName,
    score: result.score
  }
}

export async function getQMDStore(
  indexName: string,
  collections: QMDCollectionDefinition[]
): Promise<QMDStore> {
  const existingStorePromise = storePromises.get(indexName)
  if (existingStorePromise) {
    return existingStorePromise
  }

  const storePromise = (async (): Promise<QMDStore> => {
    await ensureStoreRoot(indexName)
    await ensureCollectionDirectories(collections)
    const dbPath = getQMDDbPath(indexName)

    try {
      await fs.promises.access(dbPath, fs.constants.F_OK)
      const existingStore = await openExistingStore(indexName)
      if (await storeHasRequiredCollections(existingStore, collections)) {
        return existingStore
      }
      await closeStoreQuietly(existingStore)
    } catch {
      // Fall through to configured creation.
    }

    return withQMDWriteLock(indexName, 'configure', async () => {
      try {
        await fs.promises.access(dbPath, fs.constants.F_OK)
        const existingStore = await openExistingStore(indexName)
        if (await storeHasRequiredCollections(existingStore, collections)) {
          return existingStore
        }
        await closeStoreQuietly(existingStore)
      } catch {
        // Continue with configured creation when DB is missing or incomplete.
      }

      return openConfiguredStore(indexName, collections)
    })
  })()

  storePromises.set(indexName, storePromise)

  try {
    return await storePromise
  } catch (error) {
    storePromises.delete(indexName)
    throw error
  }
}

export async function runQMDStoreSearch(params: {
  indexName: string
  collections: QMDCollectionDefinition[]
  mode: QMDSearchMode
  query: string
  collectionNames: string[]
  limit: number
}): Promise<QMDStoreRow[]> {
  const normalizedQuery = params.query.trim()
  if (!normalizedQuery) {
    return []
  }

  const collectionNames = [...new Set(params.collectionNames)].filter(Boolean)
  if (collectionNames.length === 0) {
    return []
  }

  const store = await getQMDStore(params.indexName, params.collections)

  if (params.mode === 'query') {
    const results = await store.search({
      query: normalizedQuery,
      collections: collectionNames,
      limit: params.limit
    })

    return results.map((result) => toStoreRow(result))
  }

  const searchResults = await Promise.all(
    collectionNames.map((collectionName) =>
      store.searchLex(normalizedQuery, {
        collection: collectionName,
        limit: params.limit
      })
    )
  )

  return searchResults.flat().map((result) => toStoreRow(result))
}

export async function updateQMDStore(params: {
  indexName: string
  collections: QMDCollectionDefinition[]
  collectionNames?: string[]
}): Promise<void> {
  const store = await getQMDStore(params.indexName, params.collections)
  await withQMDWriteLock(params.indexName, 'update', async () => {
    const updateOptions =
      params.collectionNames && params.collectionNames.length > 0
        ? { collections: params.collectionNames }
        : {}

    await store.update(updateOptions)
  })
}

export async function getQMDStoreStatus(params: {
  indexName: string
  collections: QMDCollectionDefinition[]
}): Promise<IndexStatus> {
  const store = await getQMDStore(params.indexName, params.collections)
  return store.getStatus()
}

export async function embedQMDStore(params: {
  indexName: string
  collections: QMDCollectionDefinition[]
  force?: boolean
}): Promise<EmbedResult> {
  const store = await getQMDStore(params.indexName, params.collections)
  return withQMDWriteLock(params.indexName, 'embed', async () => {
    return store.embed(
      typeof params.force === 'boolean'
        ? { force: params.force }
        : {}
    )
  })
}

export async function closeQMDStore(indexName: string): Promise<void> {
  const storePromise = storePromises.get(indexName)
  if (!storePromise) {
    return
  }

  storePromises.delete(indexName)

  try {
    const store = await storePromise
    await store.close()
  } catch {
    // Ignore close failures during teardown.
  }
}
