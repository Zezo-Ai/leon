import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import Database from 'better-sqlite3'
import execa from 'execa'

import {
  CONTEXT_PATH,
  MEMORY_PATH
} from '@/constants'
import { LogHelper } from '@/helpers/log-helper'

import type { KnowledgeNamespace } from './types'

const QMD_INDEX_NAME = 'leon-memory'
const QMD_UPDATE_MIN_INTERVAL_MS = 5_000
const QMD_VSEARCH_DISABLE_ZERO_STREAK = 3
const QMD_VECTOR_AVAILABILITY_TTL_MS = 5 * 60 * 1_000

export interface QMDRecallHit {
  id: string
  path: string
  title: string
  content: string
  score: number
  namespace: KnowledgeNamespace
}

interface QMDQueryInput {
  query: string
  namespaces: KnowledgeNamespace[]
  topK: number
  contextFilenames?: string[]
}

type QMDSearchMode = 'query' | 'search' | 'vsearch'

const QMD_COLLECTIONS: Record<KnowledgeNamespace, { name: string, dir: string }> = {
  context: {
    name: 'context',
    dir: CONTEXT_PATH
  },
  memory_persistent: {
    name: 'memory-persistent',
    dir: path.join(MEMORY_PATH, 'persistent')
  },
  memory_daily: {
    name: 'memory-daily',
    dir: path.join(MEMORY_PATH, 'daily')
  },
  memory_discussion: {
    name: 'memory-discussion',
    dir: path.join(MEMORY_PATH, 'discussion')
  },
  conversation_daily: {
    name: 'memory-daily',
    dir: path.join(MEMORY_PATH, 'daily')
  }
}

function normalizeFilename(filePath: string): string {
  return path.basename(filePath).toUpperCase()
}

function normalizePath(value: string): string {
  if (!value) {
    return ''
  }

  if (!value.startsWith('file://')) {
    return value
  }

  try {
    return decodeURIComponent(new URL(value).pathname)
  } catch {
    return value
  }
}

function tokenizeQuery(value: string): string[] {
  return (value.toLowerCase().match(/[a-z0-9_]+/g) || [])
    .map((token) => token.trim())
    .filter((token) => token.length >= 2)
}

function buildQueryVariants(query: string): string[] {
  const variants: string[] = []
  const normalized = query.trim()
  if (normalized) {
    variants.push(normalized)
  }

  const tokens = tokenizeQuery(normalized)
  if (tokens.length > 0) {
    variants.push(tokens.join(' '))

    // Prefer suffix windows because personal questions often end with the target entity.
    const maxWindowSize = Math.min(3, tokens.length)
    for (let windowSize = maxWindowSize; windowSize >= 1; windowSize -= 1) {
      variants.push(tokens.slice(-windowSize).join(' '))
    }

    // Add strongest standalone terms (length-based, language-agnostic heuristic).
    const uniqueTokens = [...new Set(tokens)]
    const longestTokens = uniqueTokens
      .filter((token) => token.length >= 5)
      .sort((a, b) => b.length - a.length)
      .slice(0, 6)
    variants.push(...longestTokens)
  }

  return [...new Set(variants.map((value) => value.trim()).filter(Boolean))]
    .slice(0, 12)
}

function parseRows(raw: string): Array<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (Array.isArray(parsed)) {
      return parsed.filter(
        (item): item is Record<string, unknown> =>
          item !== null && typeof item === 'object' && !Array.isArray(item)
      )
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return []
    }

    const rows: Array<Record<string, unknown>> = []
    const queue: unknown[] = [parsed]

    while (queue.length > 0) {
      const current = queue.shift()
      if (!current || typeof current !== 'object') {
        continue
      }

      const objectValue = current as Record<string, unknown>
      for (const value of Object.values(objectValue)) {
        if (Array.isArray(value)) {
          for (const item of value) {
            if (item && typeof item === 'object' && !Array.isArray(item)) {
              rows.push(item as Record<string, unknown>)
            }
          }
        } else if (value && typeof value === 'object') {
          queue.push(value)
        }
      }
    }

    return rows.length > 0 ? rows : [parsed as Record<string, unknown>]
  } catch {
    return []
  }
}

function pickStringDeep(
  row: Record<string, unknown>,
  keys: string[]
): string {
  const queue: unknown[] = [row]

  while (queue.length > 0) {
    const current = queue.shift()
    if (!current) {
      continue
    }

    if (Array.isArray(current)) {
      for (const item of current) {
        queue.push(item)
      }
      continue
    }

    if (typeof current !== 'object') {
      continue
    }

    const objectValue = current as Record<string, unknown>
    for (const key of keys) {
      const value = objectValue[key]
      if (typeof value === 'string' && value.trim()) {
        return value.trim()
      }
    }

    for (const value of Object.values(objectValue)) {
      if (value && typeof value === 'object') {
        queue.push(value)
      }
    }
  }

  return ''
}

function pickNumberDeep(
  row: Record<string, unknown>,
  keys: string[]
): number {
  const queue: unknown[] = [row]

  while (queue.length > 0) {
    const current = queue.shift()
    if (!current) {
      continue
    }

    if (Array.isArray(current)) {
      for (const item of current) {
        queue.push(item)
      }
      continue
    }

    if (typeof current !== 'object') {
      continue
    }

    const objectValue = current as Record<string, unknown>
    for (const key of keys) {
      const value = objectValue[key]
      if (typeof value === 'number' && Number.isFinite(value)) {
        return value
      }
      if (typeof value === 'string' && value.trim()) {
        const parsed = Number(value)
        if (Number.isFinite(parsed)) {
          return parsed
        }
      }
    }

    for (const value of Object.values(objectValue)) {
      if (value && typeof value === 'object') {
        queue.push(value)
      }
    }
  }

  return 0
}

function extractContent(row: Record<string, unknown>): string {
  const direct = pickStringDeep(row, [
    'snippet',
    'content',
    'text',
    'context',
    'body'
  ])
  if (direct) {
    return direct
  }

  const listKeys = ['snippets', 'chunks', 'matches', 'contexts', 'passages']
  for (const key of listKeys) {
    const value = row[key]
    if (!Array.isArray(value)) {
      continue
    }

    const lines: string[] = []
    for (const item of value) {
      if (typeof item === 'string' && item.trim()) {
        lines.push(item.trim())
        continue
      }

      if (item && typeof item === 'object' && !Array.isArray(item)) {
        const nested = pickStringDeep(item as Record<string, unknown>, [
          'snippet',
          'content',
          'text',
          'context',
          'body'
        ])
        if (nested) {
          lines.push(nested)
        }
      }
    }

    if (lines.length > 0) {
      return lines.join('\n')
    }
  }

  return ''
}

function extractScore(row: Record<string, unknown>): number {
  const score = pickNumberDeep(row, [
    'score',
    'fused_score',
    'final_score',
    'rank_score'
  ])

  if (score !== 0) {
    return score
  }

  const distance = pickNumberDeep(row, ['distance', 'cosine_distance'])
  if (distance > 0) {
    return 1 / (1 + distance)
  }

  return 0
}

function isContextFilenameAllowed(
  allowedFilenames: Set<string>,
  sourcePath: string,
  title: string
): boolean {
  if (allowedFilenames.size === 0) {
    return true
  }

  return (
    allowedFilenames.has(normalizeFilename(sourcePath)) ||
    allowedFilenames.has(normalizeFilename(title))
  )
}

export default class QMDBackend {
  private loaded = false
  private lastUpdateAt = 0
  private readonly dirtyNamespaces = new Set<KnowledgeNamespace>()
  private vsearchState: 'unknown' | 'enabled' | 'disabled' = 'unknown'
  private vsearchZeroStreak = 0
  private lastVectorAvailabilityCheckAt = 0

  private get indexDbPath(): string {
    const cacheDirectory = process.env['XDG_CACHE_HOME']
      ? path.join(process.env['XDG_CACHE_HOME'], 'qmd')
      : path.join(os.homedir(), '.cache', 'qmd')

    return path.join(cacheDirectory, `${QMD_INDEX_NAME}.sqlite`)
  }

  public markDirty(namespace: KnowledgeNamespace): void {
    this.dirtyNamespaces.add(namespace)
  }

  public async load(): Promise<void> {
    if (this.loaded) {
      return
    }

    await this.ensureQmdAvailable()
    await this.ensureCollections()
    this.loaded = true

    LogHelper.title('Memory Manager')
    LogHelper.success(`QMD backend loaded (index=${QMD_INDEX_NAME})`)
  }

  public async refresh(force = false): Promise<void> {
    await this.load()

    const now = Date.now()
    if (!force && this.dirtyNamespaces.size === 0) {
      return
    }

    if (!force && now - this.lastUpdateAt < QMD_UPDATE_MIN_INTERVAL_MS) {
      return
    }

    await this.runQMD(['--index', QMD_INDEX_NAME, 'update'])
    this.lastUpdateAt = now
    this.dirtyNamespaces.clear()
    this.vsearchState = 'unknown'
    this.lastVectorAvailabilityCheckAt = 0

    LogHelper.title('Memory Manager')
    LogHelper.debug('QMD index refreshed')
  }

  private shouldRunVectorSearch(): boolean {
    if (this.vsearchState === 'enabled') {
      return true
    }

    if (this.vsearchState === 'disabled') {
      return false
    }

    const now = Date.now()
    if (
      this.lastVectorAvailabilityCheckAt > 0 &&
      now - this.lastVectorAvailabilityCheckAt < QMD_VECTOR_AVAILABILITY_TTL_MS
    ) {
      return true
    }

    this.lastVectorAvailabilityCheckAt = now

    interface ReadonlyQmdDb {
      prepare: (sql: string) => { get: () => unknown }
      close: () => void
    }

    let database: ReadonlyQmdDb | null = null
    try {
      if (!fs.existsSync(this.indexDbPath)) {
        this.vsearchState = 'disabled'
        return false
      }

      database = new Database(this.indexDbPath, {
        readonly: true,
        fileMustExist: true
      }) as unknown as ReadonlyQmdDb

      const row = database
        .prepare(
          'SELECT COUNT(*) as count FROM content_vectors'
        )
        .get() as { count?: number } | undefined

      const vectorCount =
        row && typeof row.count === 'number' ? row.count : 0
      this.vsearchState = vectorCount > 0 ? 'enabled' : 'disabled'

      LogHelper.title('Memory Manager')
      LogHelper.debug(
        `QMD vector availability: ${this.vsearchState} (vectors=${vectorCount})`
      )
      return this.vsearchState === 'enabled'
    } catch {
      this.vsearchState = 'disabled'
      return false
    } finally {
      try {
        database?.close()
      } catch {
        // Ignore close errors.
      }
    }
  }

  public async query(input: QMDQueryInput): Promise<QMDRecallHit[]> {
    await this.refresh()

    const uniqueNamespaces = [...new Set(input.namespaces)]
    if (uniqueNamespaces.length === 0) {
      return []
    }

    const perNamespaceLimit = Math.max(input.topK * 3, input.topK)
    const allowedContextFilenames = new Set(
      (input.contextFilenames || []).map((filename) => normalizeFilename(filename))
    )

    const hits: QMDRecallHit[] = []
    const runVectorSearch = this.shouldRunVectorSearch()

    for (const namespace of uniqueNamespaces) {
      const collection = QMD_COLLECTIONS[namespace]
      if (!collection) {
        continue
      }

      const modes: QMDSearchMode[] = runVectorSearch
        ? ['search', 'vsearch', 'query']
        : ['search', 'query']
      const queryVariants = buildQueryVariants(input.query)
      const namespaceHitsStart = hits.length
      for (const mode of modes) {
        const hasNamespaceHits = hits.length > namespaceHitsStart
        if (hasNamespaceHits) {
          LogHelper.title('Memory Manager')
          LogHelper.debug(
            `QMD ${mode} skipped for namespace=${namespace}, collection=${collection.name} because previous mode already returned hits`
          )
          continue
        }

        let rows: Array<Record<string, unknown>> = []
        let usedVariant = ''
        let lastError: unknown = null
        for (const queryVariant of queryVariants) {
          try {
            const payload = await this.runQMDSearchMode(
              mode,
              queryVariant,
              collection.name,
              perNamespaceLimit
            )
            const parsedRows = parseRows(payload)
            if (parsedRows.length > 0) {
              rows = parsedRows
              usedVariant = queryVariant
              break
            }
          } catch (error) {
            lastError = error
          }
        }

        if (rows.length === 0 && lastError) {
          const message = String(lastError)
          LogHelper.title('Memory Manager')
          LogHelper.warning(
            `QMD ${mode} skipped for namespace=${namespace}, collection=${collection.name}: ${message}`
          )
          continue
        }

        LogHelper.title('Memory Manager')
        LogHelper.debug(
          `QMD ${mode} namespace=${namespace} collection=${collection.name} rows=${rows.length}${usedVariant ? ` query=${JSON.stringify(usedVariant)}` : ''}`
        )

        if (mode === 'vsearch') {
          if (rows.length > 0) {
            this.vsearchState = 'enabled'
            this.vsearchZeroStreak = 0
          } else if (this.vsearchState === 'unknown') {
            this.vsearchZeroStreak += 1
            if (this.vsearchZeroStreak >= QMD_VSEARCH_DISABLE_ZERO_STREAK) {
              this.vsearchState = 'disabled'
              LogHelper.title('Memory Manager')
              LogHelper.debug(
                `QMD vsearch disabled for this session after ${this.vsearchZeroStreak} consecutive zero-result attempts`
              )
            }
          }
        }

        for (const row of rows) {
          const sourcePath = normalizePath(
            pickStringDeep(row, [
              'filepath',
              'path',
              'file',
              'source',
              'doc_path',
              'document_path',
              'docPath',
              'uri'
            ])
          )
          const title =
            pickStringDeep(row, ['title', 'name']) ||
            (sourcePath ? path.basename(sourcePath) : '')
          const content = extractContent(row)
          const score =
            extractScore(row) +
            (mode === 'search'
              ? 0.02
              : mode === 'vsearch'
                ? 0.01
                : 0)
          const id =
            pickStringDeep(row, ['docid', 'id']) ||
            sourcePath ||
            title

          if (!id || !content) {
            continue
          }

          if (
            namespace === 'context' &&
            !isContextFilenameAllowed(allowedContextFilenames, sourcePath, title)
          ) {
            continue
          }

          hits.push({
            id,
            path: sourcePath,
            title,
            content,
            score,
            namespace
          })
        }
      }
    }

    const deduped = new Map<string, QMDRecallHit>()
    for (const hit of hits) {
      const key = `${hit.namespace}|${hit.path}|${hit.content}`
      const existing = deduped.get(key)
      if (!existing || hit.score > existing.score) {
        deduped.set(key, hit)
      }
    }

    const output = [...deduped.values()].sort((a, b) => b.score - a.score)

    if (
      uniqueNamespaces.includes('context') &&
      !output.some((hit) => hit.namespace === 'context')
    ) {
      LogHelper.title('Memory Manager')
      LogHelper.debug(
        'QMD returned no context candidates for this query; planning may rely on memory-only hits'
      )
    }

    return output
  }

  private async ensureQmdAvailable(): Promise<void> {
    try {
      await this.runQMD(['--help'])
    } catch (error) {
      throw new Error(
        `QMD backend requires the "qmd" CLI. Install it as a project dependency (for example: "pnpm add @tobilu/qmd"). ${String(error)}`
      )
    }
  }

  private async ensureCollections(): Promise<void> {
    const namespaces = new Set<KnowledgeNamespace>([
      'context',
      'memory_persistent',
      'memory_daily',
      'memory_discussion'
    ])

    for (const namespace of namespaces) {
      const collection = QMD_COLLECTIONS[namespace]
      if (!collection) {
        continue
      }

      await fs.promises.mkdir(collection.dir, { recursive: true })
      await this.ensureCollection(collection.name, collection.dir)
      this.markDirty(namespace)
    }
  }

  private async ensureCollection(name: string, dirPath: string): Promise<void> {
    try {
      await this.runQMD([
        '--index',
        QMD_INDEX_NAME,
        'collection',
        'add',
        dirPath,
        '--name',
        name,
        '--mask',
        '**/*.md'
      ])
    } catch (error) {
      const message = String(error).toLowerCase()
      if (message.includes('already exists')) {
        return
      }
      throw error
    }
  }

  private async runQMDSearchMode(
    mode: QMDSearchMode,
    query: string,
    collectionName: string,
    limit: number
  ): Promise<string> {
    const baseArgs = [
      mode,
      query,
      '--index',
      QMD_INDEX_NAME,
      '--json',
      '-n',
      String(limit),
      '-c',
      collectionName
    ]

    try {
      return await this.runQMD([...baseArgs, '--full'])
    } catch (error) {
      const message = String(error).toLowerCase()
      if (
        message.includes('unknown') &&
        message.includes('full')
      ) {
        return this.runQMD(baseArgs)
      }

      if (mode === 'query' && message.includes('not found')) {
        return this.runQMD(['search', ...baseArgs.slice(1)])
      }

      throw error
    }
  }

  private async runQMD(args: string[]): Promise<string> {
    const command = ['qmd', ...args]
      .map((argument) =>
        /[\s"\\]/.test(argument)
          ? JSON.stringify(argument)
          : argument
      )
      .join(' ')

    LogHelper.title('Memory Manager')
    LogHelper.debug(`QMD command: ${command}`)

    const { stdout } = await execa('qmd', args, {
      reject: true,
      env: process.env,
      preferLocal: true,
      localDir: process.cwd()
    })
    return stdout || ''
  }
}
