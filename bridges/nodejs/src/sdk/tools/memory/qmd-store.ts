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

const DEFAULT_PATTERN = '**/*.md'
const storePromises = new Map<string, Promise<QMDStore>>()

function getQMDDbPath(indexName: string): string {
  const cacheRoot = process.env['XDG_CACHE_HOME']
    ? path.join(process.env['XDG_CACHE_HOME'], 'qmd')
    : path.join(os.homedir(), '.cache', 'qmd')

  return path.join(cacheRoot, `${indexName}.sqlite`)
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
    await ensureCollectionDirectories(collections)

    return createStore({
      dbPath: getQMDDbPath(indexName),
      config: buildStoreConfig(collections)
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
  const updateOptions =
    params.collectionNames && params.collectionNames.length > 0
      ? { collections: params.collectionNames }
      : {}

  await store.update(updateOptions)
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
  return store.embed(
    typeof params.force === 'boolean'
      ? { force: params.force }
      : {}
  )
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
