import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'

import execa from 'execa'
import SQLite from 'better-sqlite3'
import type { Database as SQLiteDatabase } from 'better-sqlite3'

import { Tool } from '@sdk/base-tool'
import { ToolkitConfig } from '@sdk/toolkit-config'

const QMD_INDEX_NAME = 'leon-memory'
const DEFAULT_TOP_K = 12
const DEFAULT_TOKEN_BUDGET = 320
const CONTEXT_FULL_CONTENT_CAP = 8_000

type MemoryScope = 'persistent' | 'daily' | 'discussion'
type MemoryKind =
  | 'fact'
  | 'preference'
  | 'event'
  | 'note'
  | 'summary'
  | 'knowledge'
  | 'task'
type MemorySourceType =
  | 'explicit_user'
  | 'inferred'
  | 'tool_output'
  | 'conversation'
  | 'system'
type KnowledgeNamespace =
  | 'memory_persistent'
  | 'memory_daily'
  | 'memory_discussion'
  | 'conversation_daily'
  | 'context'

interface MemoryReadOptions {
  namespaces?: string[]
  topK?: number
  tokenBudget?: number
  includeFacts?: boolean
  includeContext?: boolean
  contextFilenames?: string[]
}

interface MemoryWriteOptions {
  scope?: string
  kind?: string
  title?: string
  sourceType?: string
  sourceRef?: string
  importance?: number
  confidence?: number
  tags?: string[]
  dayKey?: string
  expiresAt?: number
  isPinned?: boolean
  metadata?: Record<string, unknown>
}

interface QMDHit {
  id: string
  path: string
  title: string
  content: string
  score: number
  namespace: KnowledgeNamespace
}

const ROOT_DIR = process.cwd()
const MEMORY_ROOT = path.join(ROOT_DIR, 'core', 'memory')
const MEMORY_DB_PATH = path.join(MEMORY_ROOT, 'index.sqlite')
const CONTEXT_PATH = path.join(ROOT_DIR, 'core', 'context')
const MEMORY_PERSISTENT_PATH = path.join(MEMORY_ROOT, 'persistent')
const MEMORY_DAILY_PATH = path.join(MEMORY_ROOT, 'daily')
const MEMORY_DISCUSSION_PATH = path.join(MEMORY_ROOT, 'discussion')
const MEMORY_SCHEMA_PATH = path.join(
  ROOT_DIR,
  'server',
  'src',
  'core',
  'memory-manager',
  'sql',
  'schema.sql'
)

const COLLECTIONS: Record<KnowledgeNamespace, { name: string, dir: string }> = {
  context: {
    name: 'context',
    dir: CONTEXT_PATH
  },
  memory_persistent: {
    name: 'memory-persistent',
    dir: MEMORY_PERSISTENT_PATH
  },
  memory_daily: {
    name: 'memory-daily',
    dir: MEMORY_DAILY_PATH
  },
  memory_discussion: {
    name: 'memory-discussion',
    dir: MEMORY_DISCUSSION_PATH
  },
  conversation_daily: {
    name: 'memory-daily',
    dir: MEMORY_DAILY_PATH
  }
}

function normalizeContent(content: string): string {
  return content.replace(/\r\n/g, '\n').trim()
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
    if (tokens.length >= 2) {
      variants.push(tokens.slice(-2).join(' '))
    }
    variants.push(tokens[tokens.length - 1] || '')
  }

  return [...new Set(variants.map((value) => value.trim()).filter(Boolean))]
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

function toDayKey(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10)
}

function clipWithTokenBudget(
  content: string,
  remainingTokens: number
): { content: string, tokens: number } | null {
  if (remainingTokens <= 0) {
    return null
  }

  const fullTokens = Math.max(1, Math.ceil(content.length / 4))
  if (fullTokens <= remainingTokens) {
    return { content, tokens: fullTokens }
  }

  const maxChars = Math.max(96, remainingTokens * 4)
  if (maxChars >= content.length) {
    return {
      content,
      tokens: Math.max(1, Math.ceil(content.length / 4))
    }
  }

  const clipped = `${content.slice(0, maxChars).trimEnd()}...`
  return {
    content: clipped,
    tokens: Math.max(1, Math.ceil(clipped.length / 4))
  }
}

export default class MemoryTool extends Tool {
  private static readonly TOOLKIT = 'structured_knowledge'
  private static db: SQLiteDatabase | null = null
  private static storageReady = false
  private static collectionsReady = false

  private readonly config: ReturnType<typeof ToolkitConfig.load>

  constructor() {
    super()
    this.config = ToolkitConfig.load(MemoryTool.TOOLKIT, this.toolName)
    this.settings = ToolkitConfig.loadToolSettings(
      MemoryTool.TOOLKIT,
      this.toolName,
      {}
    )
    this.requiredSettings = []
    this.checkRequiredSettings(this.toolName)
  }

  get toolName(): string {
    return 'memory'
  }

  get toolkit(): string {
    return MemoryTool.TOOLKIT
  }

  get description(): string {
    return this.config['description']
  }

  public async read(
    query: string,
    options: MemoryReadOptions = {}
  ): Promise<Record<string, unknown>> {
    const normalizedQuery = String(query || '').trim()
    if (!normalizedQuery) {
      return {
        success: false,
        error: 'Query is required.'
      }
    }

    await this.ensureStorage()
    await this.ensureCollections()
    await this.updateIndex()

    const includeContext = options.includeContext === true
    const namespaces = this.normalizeNamespaces(options.namespaces, includeContext)
    const topK = this.normalizePositiveInt(options.topK, DEFAULT_TOP_K)
    const tokenBudget = this.normalizePositiveInt(
      options.tokenBudget,
      DEFAULT_TOKEN_BUDGET
    )
    const includeFacts = options.includeFacts !== false

    const allowedContextFilenames = new Set(
      (options.contextFilenames || []).map((filename) =>
        normalizeFilename(filename)
      )
    )

    const rawHits: QMDHit[] = []
    const perNamespaceLimit = Math.max(topK * 3, topK)
    const queryVariants = buildQueryVariants(normalizedQuery)

    for (const namespace of namespaces) {
      const collection = COLLECTIONS[namespace]
      if (!collection) {
        continue
      }

      const namespaceHitsStart = rawHits.length
      for (const variant of queryVariants) {
        const rows = await this.runSearch(variant, collection.name, perNamespaceLimit)
        if (rows.length === 0) {
          continue
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
          const id =
            pickStringDeep(row, ['docid', 'id']) ||
            sourcePath ||
            title

          if (!id || !content) {
            continue
          }

          if (namespace === 'context' && allowedContextFilenames.size > 0) {
            const allowed =
              allowedContextFilenames.has(normalizeFilename(sourcePath)) ||
              allowedContextFilenames.has(normalizeFilename(title))
            if (!allowed) {
              continue
            }
          }

          rawHits.push({
            id,
            path: sourcePath,
            title,
            content,
            score: extractScore(row),
            namespace
          })
        }

        if (rawHits.length > namespaceHitsStart) {
          break
        }
      }
    }

    const deduped = new Map<string, QMDHit>()
    for (const hit of rawHits) {
      const key = `${hit.namespace}|${hit.path}|${hit.content}`
      const existing = deduped.get(key)
      if (!existing || hit.score > existing.score) {
        deduped.set(key, hit)
      }
    }

    const ordered = [...deduped.values()].sort((a, b) => b.score - a.score)
    const selected: Array<{
      namespace: KnowledgeNamespace
      title: string | null
      content: string
      score: number
      sourcePath: string | null
    }> = []
    let usedTokenEstimate = 0

    for (const hit of ordered) {
      if (selected.length >= topK || usedTokenEstimate >= tokenBudget) {
        break
      }

      const clipped = clipWithTokenBudget(
        normalizeContent(hit.content),
        tokenBudget - usedTokenEstimate
      )
      if (!clipped) {
        break
      }

      selected.push({
        namespace: hit.namespace,
        title: hit.title || null,
        content:
          hit.namespace === 'context'
            ? clipped.content.slice(0, CONTEXT_FULL_CONTENT_CAP)
            : clipped.content,
        score: hit.score,
        sourcePath: hit.path || null
      })
      usedTokenEstimate += clipped.tokens
    }

    const facts = includeFacts ? this.readFacts(8) : []

    return {
      success: true,
      data: {
        query: normalizedQuery,
        namespaces,
        topK,
        tokenBudget,
        usedTokenEstimate,
        hits: selected,
        facts
      }
    }
  }

  public async write(
    content: string,
    options: MemoryWriteOptions = {}
  ): Promise<Record<string, unknown>> {
    const normalizedContent = normalizeContent(String(content || ''))
    if (!normalizedContent) {
      return {
        success: false,
        error: 'Content is required.'
      }
    }

    await this.ensureStorage()

    const db = this.getDb()
    const now = Date.now()
    const scope = this.normalizeScope(options.scope)
    const kind = this.normalizeKind(options.kind)
    const sourceType = this.normalizeSourceType(options.sourceType)
    const dayKey = options.dayKey || toDayKey(now)
    const dedupeHash = createHash('sha256')
      .update(`${scope}|${kind}|${normalizedContent.toLowerCase()}`)
      .digest('hex')

    const existing = db
      .prepare(
        `SELECT * FROM memory_items
         WHERE scope = ? AND dedupe_hash = ? AND is_deleted = 0
         LIMIT 1`
      )
      .get(scope, dedupeHash) as Record<string, unknown> | undefined

    const itemId = existing && typeof existing['id'] === 'string'
      ? String(existing['id'])
      : randomUUID()

    if (existing) {
      db.prepare(
        `UPDATE memory_items
         SET title = ?,
             content_md = ?,
             content_text = ?,
             source_type = ?,
             source_ref = ?,
             importance = ?,
             confidence = ?,
             day_key = ?,
             updated_at = ?,
             expires_at = ?,
             is_pinned = ?,
             metadata_json = ?
         WHERE id = ?`
      ).run(
        options.title || null,
        normalizedContent,
        normalizedContent,
        sourceType,
        options.sourceRef || null,
        this.normalizeScore(options.importance, 0.5),
        this.normalizeScore(options.confidence, 0.7),
        dayKey,
        now,
        typeof options.expiresAt === 'number' ? options.expiresAt : null,
        options.isPinned ? 1 : 0,
        JSON.stringify(options.metadata || {}),
        itemId
      )
    } else {
      db.prepare(
        `INSERT INTO memory_items (
          id, scope, kind, title, content_md, content_text,
          source_type, source_ref, importance, confidence, day_key,
          created_at, updated_at, expires_at, is_pinned,
          supersedes_item_id, dedupe_hash, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        itemId,
        scope,
        kind,
        options.title || null,
        normalizedContent,
        normalizedContent,
        sourceType,
        options.sourceRef || null,
        this.normalizeScore(options.importance, 0.5),
        this.normalizeScore(options.confidence, 0.7),
        dayKey,
        now,
        now,
        typeof options.expiresAt === 'number' ? options.expiresAt : null,
        options.isPinned ? 1 : 0,
        null,
        dedupeHash,
        JSON.stringify(options.metadata || {})
      )
    }

    await this.writeMarkdownMirror({
      id: itemId,
      scope,
      kind,
      title: options.title || null,
      content: normalizedContent,
      dayKey,
      createdAt: existing && typeof existing['created_at'] === 'number'
        ? Number(existing['created_at'])
        : now
    })

    await this.ensureCollections()
    await this.updateIndex()

    return {
      success: true,
      data: {
        id: itemId,
        scope,
        kind,
        title: options.title || null,
        content: normalizedContent,
        createdAt: existing && typeof existing['created_at'] === 'number'
          ? Number(existing['created_at'])
          : now,
        updatedAt: now
      }
    }
  }

  private normalizePositiveInt(value: unknown, fallback: number): number {
    const parsed = Number(value)
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return fallback
    }
    return Math.floor(parsed)
  }

  private normalizeScope(value: unknown): MemoryScope {
    if (value === 'daily' || value === 'discussion' || value === 'persistent') {
      return value
    }
    return 'persistent'
  }

  private normalizeKind(value: unknown): MemoryKind {
    const allowed = new Set<MemoryKind>([
      'fact',
      'preference',
      'event',
      'note',
      'summary',
      'knowledge',
      'task'
    ])
    return allowed.has(value as MemoryKind) ? (value as MemoryKind) : 'note'
  }

  private normalizeSourceType(value: unknown): MemorySourceType {
    const allowed = new Set<MemorySourceType>([
      'explicit_user',
      'inferred',
      'tool_output',
      'conversation',
      'system'
    ])
    return allowed.has(value as MemorySourceType)
      ? (value as MemorySourceType)
      : 'explicit_user'
  }

  private normalizeScore(value: unknown, fallback: number): number {
    const parsed = Number(value)
    if (!Number.isFinite(parsed)) {
      return fallback
    }

    return Math.max(0, Math.min(1, parsed))
  }

  private normalizeNamespaces(
    value: unknown,
    includeContext: boolean
  ): KnowledgeNamespace[] {
    const allowed = new Set<KnowledgeNamespace>([
      'memory_persistent',
      'memory_daily',
      'memory_discussion',
      'conversation_daily',
      'context'
    ])
    const input = Array.isArray(value)
      ? value.filter((item): item is KnowledgeNamespace =>
          typeof item === 'string' && allowed.has(item as KnowledgeNamespace)
        )
      : []
    const namespaces =
      input.length > 0
        ? input
        : ['memory_persistent', 'memory_daily', 'memory_discussion']

    if (includeContext) {
      return [...new Set([...namespaces, 'context'])]
    }

    return namespaces.filter((namespace) => namespace !== 'context')
  }

  private getDb(): SQLiteDatabase {
    if (!MemoryTool.db) {
      throw new Error('Memory database is not initialized.')
    }

    return MemoryTool.db
  }

  private async ensureStorage(): Promise<void> {
    if (MemoryTool.storageReady) {
      return
    }

    await Promise.all([
      fs.promises.mkdir(MEMORY_ROOT, { recursive: true }),
      fs.promises.mkdir(MEMORY_PERSISTENT_PATH, { recursive: true }),
      fs.promises.mkdir(MEMORY_DAILY_PATH, { recursive: true }),
      fs.promises.mkdir(MEMORY_DISCUSSION_PATH, { recursive: true }),
      fs.promises.mkdir(CONTEXT_PATH, { recursive: true })
    ])

    if (!MemoryTool.db) {
      MemoryTool.db = new SQLite(MEMORY_DB_PATH)
      const schemaSQL = await fs.promises.readFile(MEMORY_SCHEMA_PATH, 'utf8')
      MemoryTool.db.exec(schemaSQL)
    }

    MemoryTool.storageReady = true
  }

  private async ensureCollections(): Promise<void> {
    if (MemoryTool.collectionsReady) {
      return
    }

    await this.ensureQmdAvailable()

    const collectionEntries = [
      COLLECTIONS.context,
      COLLECTIONS.memory_persistent,
      COLLECTIONS.memory_daily,
      COLLECTIONS.memory_discussion
    ]
    for (const collection of collectionEntries) {
      await fs.promises.mkdir(collection.dir, { recursive: true })
      try {
        await this.runQMD([
          '--index',
          QMD_INDEX_NAME,
          'collection',
          'add',
          collection.dir,
          '--name',
          collection.name,
          '--mask',
          '**/*.md'
        ])
      } catch (error) {
        const message = String(error).toLowerCase()
        if (!message.includes('already exists')) {
          throw error
        }
      }
    }

    MemoryTool.collectionsReady = true
  }

  private async ensureQmdAvailable(): Promise<void> {
    await this.runQMD(['--help'])
  }

  private async updateIndex(): Promise<void> {
    await this.runQMD(['--index', QMD_INDEX_NAME, 'update'])
  }

  private async runSearch(
    query: string,
    collectionName: string,
    limit: number
  ): Promise<Array<Record<string, unknown>>> {
    if (!query.trim()) {
      return []
    }

    const args = [
      'search',
      query,
      '--index',
      QMD_INDEX_NAME,
      '--json',
      '-n',
      String(limit),
      '-c',
      collectionName
    ]

    let payload = ''
    try {
      payload = await this.runQMD([...args, '--full'])
    } catch (error) {
      const message = String(error).toLowerCase()
      if (message.includes('unknown') && message.includes('full')) {
        payload = await this.runQMD(args)
      } else {
        return []
      }
    }

    return parseRows(payload)
  }

  private async runQMD(args: string[]): Promise<string> {
    const { stdout } = await execa('qmd', args, {
      reject: true,
      env: process.env,
      preferLocal: true,
      localDir: ROOT_DIR
    })
    return stdout || ''
  }

  private readFacts(limit: number): Array<{ key: string, text: string }> {
    const db = this.getDb()
    const rows = db
      .prepare(
        `SELECT fact_key, canonical_text
         FROM memory_facts
         WHERE is_deleted = 0
         ORDER BY priority DESC, updated_at DESC
         LIMIT ?`
      )
      .all(limit) as Array<Record<string, unknown>>

    return rows.map((row) => ({
      key: String(row['fact_key'] || ''),
      text: String(row['canonical_text'] || '')
    }))
  }

  private async writeMarkdownMirror(input: {
    id: string
    scope: MemoryScope
    kind: MemoryKind
    title: string | null
    content: string
    dayKey: string
    createdAt: number
  }): Promise<void> {
    if (input.scope === 'persistent') {
      const date = new Date(input.createdAt)
      const year = String(date.getUTCFullYear())
      const month = String(date.getUTCMonth() + 1).padStart(2, '0')
      const day = String(date.getUTCDate()).padStart(2, '0')
      const filePath = path.join(
        MEMORY_PERSISTENT_PATH,
        year,
        month,
        day,
        `${input.id}.md`
      )
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true })
      const markdown = `> Persistent memory entry (${input.kind})\n\n# ${
        input.title || input.kind
      }\n\nID: ${input.id}\nCreated At: ${new Date(
        input.createdAt
      ).toISOString()}\n\n${input.content}\n`
      await fs.promises.writeFile(filePath, markdown, 'utf8')
      return
    }

    if (input.scope === 'daily' && input.kind === 'summary') {
      const filePath = path.join(MEMORY_DAILY_PATH, `${input.dayKey}.md`)
      await fs.promises.writeFile(filePath, input.content, 'utf8')
      return
    }

    if (input.scope === 'discussion') {
      const filePath = path.join(MEMORY_DISCUSSION_PATH, `${input.dayKey}.md`)
      const line = `- ${new Date(input.createdAt).toISOString()} | ${input.content.replace(/\n/g, ' | ')}\n`
      if (!fs.existsSync(filePath)) {
        const header = `> Discussion memory for ${input.dayKey}. Short-term rolling conversation context.\n# ${input.dayKey}\n\n`
        await fs.promises.writeFile(filePath, `${header}${line}`, 'utf8')
      } else {
        await fs.promises.appendFile(filePath, line, 'utf8')
      }
    }
  }

  public static dispose(): void {
    try {
      MemoryTool.db?.close()
    } catch {
      // Ignore close errors.
    }
    MemoryTool.db = null
    MemoryTool.storageReady = false
    MemoryTool.collectionsReady = false
  }
}
