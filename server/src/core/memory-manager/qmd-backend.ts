import fs from 'node:fs'
import path from 'node:path'

import execa from 'execa'

import {
  CONTEXT_PATH,
  MEMORY_PATH
} from '@/constants'
import { LogHelper } from '@/helpers/log-helper'

import type { KnowledgeNamespace } from './types'

const QMD_INDEX_NAME = 'leon-memory'
const QMD_UPDATE_MIN_INTERVAL_MS = 5_000

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
    if (!current || typeof current !== 'object') {
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
    if (!current || typeof current !== 'object') {
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
  return pickStringDeep(row, ['snippet', 'content', 'text', 'context', 'body'])
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

    LogHelper.title('Memory Manager')
    LogHelper.debug('QMD index refreshed')
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

    for (const namespace of uniqueNamespaces) {
      const collection = QMD_COLLECTIONS[namespace]
      if (!collection) {
        continue
      }

      const raw = await this.runQMD([
        '--index',
        QMD_INDEX_NAME,
        'query',
        input.query,
        '--json',
        '-n',
        String(perNamespaceLimit),
        '-c',
        collection.name
      ])

      for (const row of parseRows(raw)) {
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
        const score = extractScore(row)
        const id = pickStringDeep(row, ['docid', 'id']) || sourcePath || title

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
        name
      ])
    } catch (error) {
      const message = String(error).toLowerCase()
      if (message.includes('already exists')) {
        return
      }
      throw error
    }
  }

  private async runQMD(args: string[]): Promise<string> {
    const { stdout } = await execa('qmd', args, {
      reject: true,
      env: process.env,
      preferLocal: true,
      localDir: process.cwd()
    })
    return stdout || ''
  }
}
