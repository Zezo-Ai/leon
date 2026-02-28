import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

import { LogHelper } from '@/helpers/log-helper'

import type {
  ContextChunkInput,
  ContextDocumentInput,
  MemoryChunkInput,
  MemoryRecord,
  MemoryScope,
  MemoryWriteInput,
  RecallHit
} from './types'

interface SQLiteStatement {
  run(...args: unknown[]): {
    changes?: number
    lastInsertRowid?: number | bigint
  }
  get(...args: unknown[]): Record<string, unknown> | undefined
  all(...args: unknown[]): Array<Record<string, unknown>>
}

interface SQLiteDatabase {
  exec(sql: string): void
  prepare(sql: string): SQLiteStatement
}

interface SearchParams {
  query: string
  namespaces: string[]
  topK: number
}

const fileName = fileURLToPath(import.meta.url)
const dirName = path.dirname(fileName)

function parseJSONValue(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') {
    return {}
  }

  try {
    const parsed = JSON.parse(value)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // Ignore malformed JSON and fallback to {}
  }

  return {}
}

function mapMemoryRow(row: Record<string, unknown>): MemoryRecord {
  return {
    id: String(row['id'] || ''),
    scope: String(row['scope'] || 'discussion') as MemoryScope,
    kind: String(row['kind'] || 'note') as MemoryRecord['kind'],
    title: row['title'] ? String(row['title']) : null,
    content: String(row['content_md'] || ''),
    importance: Number(row['importance'] || 0.5),
    confidence: Number(row['confidence'] || 0.7),
    dayKey: row['day_key'] ? String(row['day_key']) : null,
    createdAt: Number(row['created_at'] || Date.now()),
    updatedAt: Number(row['updated_at'] || Date.now()),
    expiresAt:
      typeof row['expires_at'] === 'number'
        ? (row['expires_at'] as number)
        : row['expires_at'] != null
          ? Number(row['expires_at'])
          : null,
    isPinned: Number(row['is_pinned'] || 0) === 1,
    metadata: parseJSONValue(row['metadata_json'])
  }
}

export default class MemoryRepository {
  private db: SQLiteDatabase | null = null

  public get isReady(): boolean {
    return this.db !== null
  }

  public async load(dbPath: string): Promise<void> {
    if (this.db) {
      return
    }

    await fs.promises.mkdir(path.dirname(dbPath), { recursive: true })

    const sqliteModule = await Function('return import("node:sqlite")')() as {
      DatabaseSync: new (filename: string) => SQLiteDatabase
    }

    this.db = new sqliteModule.DatabaseSync(dbPath)
    const schemaPath = path.join(dirName, 'sql', 'schema.sql')
    const schemaSQL = await fs.promises.readFile(schemaPath, 'utf8')
    this.db.exec(schemaSQL)
  }

  private ensureDb(): SQLiteDatabase {
    if (!this.db) {
      throw new Error('Memory repository is not initialized')
    }

    return this.db
  }

  public upsertMemoryItem(
    input: MemoryWriteInput,
    dedupeHash: string,
    nowTs: number,
    idFactory: () => string
  ): MemoryRecord {
    const db = this.ensureDb()

    const findStmt = db.prepare(
      `SELECT * FROM memory_items
       WHERE scope = ? AND dedupe_hash = ? AND is_deleted = 0
       LIMIT 1`
    )
    const existing = findStmt.get(input.scope, dedupeHash)

    if (existing) {
      const updateStmt = db.prepare(
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
             supersedes_item_id = ?,
             metadata_json = ?
         WHERE id = ?`
      )

      updateStmt.run(
        input.title || null,
        input.content,
        input.content,
        input.sourceType,
        input.sourceRef || null,
        input.importance ?? 0.5,
        input.confidence ?? 0.7,
        input.dayKey || null,
        nowTs,
        input.expiresAt ?? null,
        input.isPinned ? 1 : 0,
        input.supersedesItemId || null,
        JSON.stringify(input.metadata || {}),
        existing['id']
      )

      const reloaded = db.prepare('SELECT * FROM memory_items WHERE id = ?').get(
        existing['id']
      )
      return mapMemoryRow(reloaded || existing)
    }

    const id = idFactory()
    const insertStmt = db.prepare(
      `INSERT INTO memory_items (
        id, scope, kind, title, content_md, content_text,
        source_type, source_ref, importance, confidence, day_key,
        created_at, updated_at, expires_at, is_pinned,
        supersedes_item_id, dedupe_hash, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )

    insertStmt.run(
      id,
      input.scope,
      input.kind,
      input.title || null,
      input.content,
      input.content,
      input.sourceType,
      input.sourceRef || null,
      input.importance ?? 0.5,
      input.confidence ?? 0.7,
      input.dayKey || null,
      nowTs,
      nowTs,
      input.expiresAt ?? null,
      input.isPinned ? 1 : 0,
      input.supersedesItemId || null,
      dedupeHash,
      JSON.stringify(input.metadata || {})
    )

    const row = db.prepare('SELECT * FROM memory_items WHERE id = ?').get(id)
    return mapMemoryRow(
      row || {
        id,
        scope: input.scope,
        kind: input.kind,
        title: input.title || null,
        content_md: input.content,
        importance: input.importance ?? 0.5,
        confidence: input.confidence ?? 0.7,
        day_key: input.dayKey || null,
        created_at: nowTs,
        updated_at: nowTs,
        expires_at: input.expiresAt ?? null,
        is_pinned: input.isPinned ? 1 : 0,
        metadata_json: JSON.stringify(input.metadata || {})
      }
    )
  }

  public replaceMemoryChunks(itemId: string, chunks: MemoryChunkInput[]): void {
    const db = this.ensureDb()
    db.prepare('DELETE FROM memory_chunks WHERE item_id = ?').run(itemId)

    if (chunks.length === 0) {
      return
    }

    const insertStmt = db.prepare(
      `INSERT INTO memory_chunks (
        id, item_id, namespace, chunk_index, content, token_estimate,
        created_at, updated_at, embedding_model, embedding_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )

    for (const chunk of chunks) {
      insertStmt.run(
        chunk.id,
        chunk.itemId,
        chunk.namespace,
        chunk.chunkIndex,
        chunk.content,
        chunk.tokenEstimate,
        chunk.createdAt,
        chunk.updatedAt,
        chunk.embeddingModel || null,
        chunk.embeddingVector ? JSON.stringify(chunk.embeddingVector) : null
      )
    }
  }

  public upsertContextDocument(input: ContextDocumentInput): void {
    const db = this.ensureDb()
    const existing = db
      .prepare('SELECT id FROM context_documents WHERE file_path = ? LIMIT 1')
      .get(input.filePath)

    if (existing?.['id']) {
      db.prepare(
        `UPDATE context_documents
         SET filename = ?, checksum = ?, title = ?, updated_at = ?, last_indexed_at = ?, is_deleted = 0
         WHERE id = ?`
      ).run(
        input.filename,
        input.checksum,
        input.title || null,
        input.updatedAt,
        input.lastIndexedAt,
        existing['id']
      )
      return
    }

    db.prepare(
      `INSERT INTO context_documents (
         id, filename, file_path, checksum, title,
         created_at, updated_at, last_indexed_at, is_deleted
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`
    ).run(
      input.id,
      input.filename,
      input.filePath,
      input.checksum,
      input.title || null,
      input.createdAt,
      input.updatedAt,
      input.lastIndexedAt
    )
  }

  public getContextDocumentByPath(
    filePath: string
  ): Record<string, unknown> | null {
    const db = this.ensureDb()
    const row = db
      .prepare('SELECT * FROM context_documents WHERE file_path = ? LIMIT 1')
      .get(filePath)

    return row || null
  }

  public replaceContextChunks(
    documentId: string,
    chunks: ContextChunkInput[]
  ): void {
    const db = this.ensureDb()
    db.prepare('DELETE FROM context_chunks WHERE document_id = ?').run(documentId)

    if (chunks.length === 0) {
      return
    }

    const insertStmt = db.prepare(
      `INSERT INTO context_chunks (
         id, document_id, chunk_index, content, token_estimate,
         created_at, updated_at, embedding_model, embedding_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )

    for (const chunk of chunks) {
      insertStmt.run(
        chunk.id,
        chunk.documentId,
        chunk.chunkIndex,
        chunk.content,
        chunk.tokenEstimate,
        chunk.createdAt,
        chunk.updatedAt,
        chunk.embeddingModel || null,
        chunk.embeddingVector ? JSON.stringify(chunk.embeddingVector) : null
      )
    }
  }

  public searchMemoryChunks(params: SearchParams): RecallHit[] {
    if (!params.namespaces.length) {
      return []
    }

    const db = this.ensureDb()
    const placeholders = params.namespaces.map(() => '?').join(',')
    const stmt = db.prepare(
      `SELECT
         memory_chunks.id AS chunk_id,
         memory_chunks.item_id AS item_id,
         memory_chunks.namespace AS namespace,
         memory_chunks.content AS content,
         memory_chunks.updated_at AS created_at,
         memory_items.scope AS scope,
         memory_items.kind AS kind,
         memory_items.title AS title,
         bm25(memory_chunks_fts) AS bm25_score
       FROM memory_chunks_fts
       JOIN memory_chunks ON memory_chunks.id = memory_chunks_fts.chunk_id
       JOIN memory_items ON memory_items.id = memory_chunks.item_id
       WHERE memory_chunks_fts MATCH ?
         AND memory_chunks.namespace IN (${placeholders})
         AND memory_items.is_deleted = 0
       ORDER BY bm25_score
       LIMIT ?`
    )

    const rows = stmt.all(
      params.query,
      ...params.namespaces,
      params.topK
    )

    return rows.map((row) => ({
      chunkId: String(row['chunk_id'] || ''),
      itemId: String(row['item_id'] || ''),
      namespace: String(row['namespace'] || 'memory_discussion') as RecallHit['namespace'],
      scope: row['scope'] ? (String(row['scope']) as RecallHit['scope']) : null,
      kind: row['kind'] ? (String(row['kind']) as RecallHit['kind']) : null,
      title: row['title'] ? String(row['title']) : null,
      content: String(row['content'] || ''),
      bm25Score: Number(row['bm25_score'] || 0),
      createdAt: Number(row['created_at'] || Date.now()),
      sourcePath: null
    }))
  }

  public searchContextChunks(params: SearchParams): RecallHit[] {
    const db = this.ensureDb()
    const stmt = db.prepare(
      `SELECT
         context_chunks.id AS chunk_id,
         context_chunks.document_id AS item_id,
         context_chunks.content AS content,
         context_chunks.updated_at AS created_at,
         context_documents.filename AS title,
         context_documents.file_path AS source_path,
         bm25(context_chunks_fts) AS bm25_score
       FROM context_chunks_fts
       JOIN context_chunks ON context_chunks.id = context_chunks_fts.chunk_id
       JOIN context_documents ON context_documents.id = context_chunks.document_id
       WHERE context_chunks_fts MATCH ?
         AND context_documents.is_deleted = 0
       ORDER BY bm25_score
       LIMIT ?`
    )

    const rows = stmt.all(params.query, params.topK)

    return rows.map((row) => ({
      chunkId: String(row['chunk_id'] || ''),
      itemId: String(row['item_id'] || ''),
      namespace: 'context',
      scope: null,
      kind: null,
      title: row['title'] ? String(row['title']) : null,
      content: String(row['content'] || ''),
      bm25Score: Number(row['bm25_score'] || 0),
      createdAt: Number(row['created_at'] || Date.now()),
      sourcePath: row['source_path'] ? String(row['source_path']) : null
    }))
  }

  public getChunkEmbeddingVector(chunkId: string): number[] | null {
    const db = this.ensureDb()
    const row = db
      .prepare(
        `SELECT embedding_json
         FROM memory_chunks
         WHERE id = ?
         UNION ALL
         SELECT embedding_json
         FROM context_chunks
         WHERE id = ?
         LIMIT 1`
      )
      .get(chunkId, chunkId)

    if (!row || typeof row['embedding_json'] !== 'string') {
      return null
    }

    try {
      const parsed = JSON.parse(String(row['embedding_json']))
      if (Array.isArray(parsed)) {
        return parsed
          .map((value) => Number(value))
          .filter((value) => Number.isFinite(value))
      }
    } catch {
      // Ignore malformed embeddings.
    }

    return null
  }

  public setChunkEmbeddingVector(
    chunkId: string,
    vector: number[],
    modelName: string
  ): void {
    const db = this.ensureDb()
    const payload = JSON.stringify(vector)

    const memoryResult = db
      .prepare(
        `UPDATE memory_chunks
         SET embedding_model = ?, embedding_json = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(modelName, payload, Date.now(), chunkId)

    if ((memoryResult.changes || 0) > 0) {
      return
    }

    db.prepare(
      `UPDATE context_chunks
       SET embedding_model = ?, embedding_json = ?, updated_at = ?
       WHERE id = ?`
    ).run(modelName, payload, Date.now(), chunkId)
  }

  public getDailyConversationLogs(dayKey: string): Array<{ content: string }> {
    const db = this.ensureDb()
    const rows = db
      .prepare(
        `SELECT content_md
         FROM memory_items
         WHERE day_key = ?
           AND scope = 'daily'
           AND source_type = 'conversation'
           AND is_deleted = 0
         ORDER BY created_at ASC
         LIMIT 200`
      )
      .all(dayKey)

    return rows.map((row) => ({
      content: String(row['content_md'] || '')
    }))
  }

  public getDailySummaryItem(dayKey: string): MemoryRecord | null {
    const db = this.ensureDb()
    const row = db
      .prepare(
        `SELECT *
         FROM memory_items
         WHERE scope = 'daily'
           AND kind = 'summary'
           AND day_key = ?
           AND is_deleted = 0
         ORDER BY updated_at DESC
         LIMIT 1`
      )
      .get(dayKey)

    return row ? mapMemoryRow(row) : null
  }

  public markDiscussionExpired(nowTs: number): number {
    const db = this.ensureDb()
    const result = db
      .prepare(
        `UPDATE memory_items
         SET is_deleted = 1, updated_at = ?
         WHERE scope = 'discussion'
           AND is_deleted = 0
           AND expires_at IS NOT NULL
           AND expires_at <= ?`
      )
      .run(nowTs, nowTs)

    return Number(result.changes || 0)
  }

  public softDeleteById(id: string): boolean {
    const db = this.ensureDb()
    const result = db
      .prepare(
        `UPDATE memory_items
         SET is_deleted = 1, updated_at = ?
         WHERE id = ? AND is_deleted = 0`
      )
      .run(Date.now(), id)

    return Number(result.changes || 0) > 0
  }

  public softDeleteByQuery(query: string): number {
    const db = this.ensureDb()

    const ids = db
      .prepare(
        `SELECT DISTINCT memory_items.id
         FROM memory_chunks_fts
         JOIN memory_chunks ON memory_chunks.id = memory_chunks_fts.chunk_id
         JOIN memory_items ON memory_items.id = memory_chunks.item_id
         WHERE memory_chunks_fts MATCH ?
           AND memory_items.is_deleted = 0`
      )
      .all(query)
      .map((row) => String(row['id'] || ''))
      .filter((id) => id.length > 0)

    if (!ids.length) {
      return 0
    }

    const placeholders = ids.map(() => '?').join(',')
    const result = db
      .prepare(
        `UPDATE memory_items
         SET is_deleted = 1, updated_at = ?
         WHERE id IN (${placeholders})`
      )
      .run(Date.now(), ...ids)

    return Number(result.changes || 0)
  }

  public getFactsTop(limit: number): Array<{
    key: string
    value: unknown
    text: string
    priority: number
  }> {
    const db = this.ensureDb()
    const rows = db
      .prepare(
        `SELECT fact_key, fact_value_json, canonical_text, priority
         FROM memory_facts
         WHERE is_deleted = 0
         ORDER BY priority DESC, updated_at DESC
         LIMIT ?`
      )
      .all(limit)

    return rows.map((row) => {
      let value: unknown = null
      try {
        value = JSON.parse(String(row['fact_value_json'] || 'null'))
      } catch {
        value = String(row['fact_value_json'] || '')
      }

      return {
        key: String(row['fact_key'] || ''),
        value,
        text: String(row['canonical_text'] || ''),
        priority: Number(row['priority'] || 0)
      }
    })
  }

  public upsertFact(
    key: string,
    value: unknown,
    text: string,
    sourceItemId: string,
    priority = 50
  ): void {
    const db = this.ensureDb()
    const now = Date.now()
    const existing = db
      .prepare(
        `SELECT id
         FROM memory_facts
         WHERE fact_key = ? AND is_deleted = 0
         LIMIT 1`
      )
      .get(key)

    if (existing?.['id']) {
      db.prepare(
        `UPDATE memory_facts
         SET fact_value_json = ?,
             canonical_text = ?,
             source_item_id = ?,
             priority = ?,
             updated_at = ?,
             last_seen_at = ?
         WHERE id = ?`
      ).run(
        JSON.stringify(value),
        text,
        sourceItemId,
        priority,
        now,
        now,
        existing['id']
      )
      return
    }

    db.prepare(
      `INSERT INTO memory_facts (
         id, fact_key, fact_value_json, canonical_text, priority,
         source_item_id, created_at, updated_at, last_seen_at, is_pinned, is_deleted
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)`
    ).run(
      randomUUID(),
      key,
      JSON.stringify(value),
      text,
      priority,
      sourceItemId,
      now,
      now,
      now
    )
  }

  public markContextDocumentDeleted(filePath: string): void {
    const db = this.ensureDb()
    db.prepare(
      `UPDATE context_documents
       SET is_deleted = 1, updated_at = ?
       WHERE file_path = ?`
    ).run(Date.now(), filePath)
  }

  public listContextDocumentPaths(): string[] {
    const db = this.ensureDb()
    return db
      .prepare('SELECT file_path FROM context_documents WHERE is_deleted = 0')
      .all()
      .map((row) => String(row['file_path'] || ''))
      .filter((value) => value.length > 0)
  }

  public debugHealthCheck(): void {
    if (!this.db) {
      LogHelper.title('Memory Manager')
      LogHelper.warning('Memory repository is not ready')
    }
  }
}
