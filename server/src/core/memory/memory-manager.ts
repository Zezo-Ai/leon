import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'

import {
  CONTEXT_PATH,
  MEMORY_DB_PATH,
  MEMORY_PATH,
  LEON_MEMORY_DISCUSSION_TTL_DAYS,
  LEON_MEMORY_ENABLE_EMBEDDINGS,
  LEON_MEMORY_EXECUTION_TOKEN_BUDGET,
  LEON_MEMORY_PLANNING_TOKEN_BUDGET,
  LEON_MEMORY_RECALL_TOP_K
} from '@/constants'
import { LogHelper } from '@/helpers/log-helper'

import { chunkText } from './chunker'
import { cosineSimilarity } from './embedding-provider'
import LlamaEmbeddingProvider from './llama-embedding-provider'
import MemoryRepository from './memory-repository'
import { buildDailyMarkdownSummary } from './summarizer'
import type {
  ContextChunkInput,
  ContextDocumentInput,
  EmbeddingProvider,
  KnowledgeNamespace,
  MemoryChunkInput,
  MemoryRecord,
  MemoryScope,
  MemoryWriteInput,
  RecallHit,
  RecallQuery,
  RecallResult,
  TurnObservationInput
} from './types'

const CONTEXT_SYNC_TTL_MS = 5 * 60 * 1_000
const DISCUSSION_TTL_MS = LEON_MEMORY_DISCUSSION_TTL_DAYS * 24 * 60 * 60 * 1_000

function normalizeFTSQuery(query: string): string {
  const terms = (query.toLowerCase().match(/[a-z0-9_]+/g) || [])
    .map((term) => term.trim())
    .filter((term) => term.length >= 2)

  if (terms.length === 0) {
    return ''
  }

  return terms.map((term) => `${term}*`).join(' OR ')
}

function normalizeContent(content: string): string {
  return content.replace(/\r\n/g, '\n').trim()
}

function computeHash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function toDayKey(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10)
}

function namespaceForScope(scope: MemoryScope): KnowledgeNamespace {
  switch (scope) {
    case 'persistent':
      return 'memory_persistent'
    case 'daily':
      return 'memory_daily'
    case 'discussion':
    default:
      return 'memory_discussion'
  }
}

function renderRecallPrompt(result: RecallResult): string {
  if (!result.hits.length && !result.facts.length) {
    return 'Memory: none'
  }

  const lines: string[] = ['Memory Recall:']

  if (result.facts.length > 0) {
    lines.push('Facts:')
    for (const fact of result.facts) {
      lines.push(`- ${fact.text}`)
    }
  }

  if (result.hits.length > 0) {
    lines.push('Relevant Memory Chunks:')
    for (const [index, hit] of result.hits.entries()) {
      const sourceLabel = hit.sourcePath
        ? path.basename(hit.sourcePath)
        : hit.title || hit.namespace
      lines.push(`${index + 1}. [${sourceLabel}] ${hit.content}`)
    }
  }

  return lines.join('\n')
}

function parseConversationPair(content: string): Array<{ who: 'owner' | 'leon', message: string }> {
  const lines = content.split('\n')
  const ownerLine = lines.find((line) => line.startsWith('Owner:'))
  const leonLine = lines.find((line) => line.startsWith('Leon:'))
  const records: Array<{ who: 'owner' | 'leon', message: string }> = []

  if (ownerLine) {
    records.push({
      who: 'owner',
      message: ownerLine.replace(/^Owner:\s*/i, '').trim()
    })
  }

  if (leonLine) {
    records.push({
      who: 'leon',
      message: leonLine.replace(/^Leon:\s*/i, '').trim()
    })
  }

  return records.filter((record) => record.message.length > 0)
}

export default class MemoryManager {
  private static instance: MemoryManager

  private _isLoaded = false
  private lastContextSyncAt = 0
  private readonly repository = new MemoryRepository()
  private readonly embeddingProvider: EmbeddingProvider = new LlamaEmbeddingProvider()
  private readonly persistentPath = path.join(MEMORY_PATH, 'persistent')
  private readonly dailyPath = path.join(MEMORY_PATH, 'daily')
  private readonly discussionPath = path.join(MEMORY_PATH, 'discussion')

  public constructor() {
    if (!MemoryManager.instance) {
      LogHelper.title('Memory Manager')
      LogHelper.success('New instance')
      MemoryManager.instance = this
    }
  }

  public get isLoaded(): boolean {
    return this._isLoaded
  }

  public async load(): Promise<void> {
    if (this._isLoaded) {
      return
    }

    try {
      await Promise.all([
        fs.promises.mkdir(this.persistentPath, { recursive: true }),
        fs.promises.mkdir(this.dailyPath, { recursive: true }),
        fs.promises.mkdir(this.discussionPath, { recursive: true })
      ])

      await this.repository.load(MEMORY_DB_PATH)

      if (LEON_MEMORY_ENABLE_EMBEDDINGS) {
        await this.embeddingProvider.load()
      }

      await this.syncContextFiles(true)

      this._isLoaded = true
      LogHelper.title('Memory Manager')
      LogHelper.success('Loaded')
    } catch (e) {
      LogHelper.title('Memory Manager')
      LogHelper.error(`Failed to load: ${e}`)
    }
  }

  public async remember(input: MemoryWriteInput): Promise<MemoryRecord> {
    if (!this._isLoaded) {
      await this.load()
    }

    const normalizedContent = normalizeContent(input.content)
    const now = Date.now()
    const dedupeHash = computeHash(
      `${input.scope}|${input.kind}|${normalizedContent.toLowerCase()}`
    )

    const saved = this.repository.upsertMemoryItem(
      {
        ...input,
        content: normalizedContent
      },
      dedupeHash,
      now,
      () => randomUUID()
    )

    const namespace = namespaceForScope(saved.scope)
    const chunks = chunkText(saved.content).map<MemoryChunkInput>((chunk) => ({
      id: randomUUID(),
      itemId: saved.id,
      namespace,
      chunkIndex: chunk.index,
      content: chunk.content,
      tokenEstimate: chunk.tokenEstimate,
      createdAt: now,
      updatedAt: now
    }))

    if (this.embeddingProvider.isReady) {
      for (const chunk of chunks) {
        const vector = await this.embeddingProvider.embedText(chunk.content)
        if (!vector || vector.length === 0) {
          continue
        }

        chunk.embeddingModel = this.embeddingProvider.modelName || 'embedding'
        chunk.embeddingVector = vector
      }
    }

    this.repository.replaceMemoryChunks(saved.id, chunks)

    if (saved.scope === 'persistent') {
      const filePath = path.join(this.persistentPath, `${saved.id}.md`)
      const markdown = `> Persistent memory entry (${saved.kind})\n\n# ${saved.title || saved.kind}\n\n${saved.content}\n`
      await fs.promises.writeFile(filePath, markdown, 'utf8')
    }

    if (saved.scope === 'daily' && saved.kind === 'summary' && saved.dayKey) {
      const filePath = path.join(this.dailyPath, `${saved.dayKey}.md`)
      await fs.promises.writeFile(filePath, saved.content, 'utf8')
    }

    return saved
  }

  public async rememberExplicit(
    text: string,
    metadata: Record<string, unknown> = {}
  ): Promise<MemoryRecord> {
    return this.remember({
      scope: 'persistent',
      kind: 'note',
      title: 'Explicit memory',
      content: text,
      sourceType: 'explicit_user',
      importance: 0.95,
      confidence: 0.95,
      metadata
    })
  }

  public async forgetById(id: string): Promise<boolean> {
    if (!this._isLoaded) {
      await this.load()
    }

    return this.repository.softDeleteById(id)
  }

  public async forgetByQuery(query: string): Promise<number> {
    if (!this._isLoaded) {
      await this.load()
    }

    const ftsQuery = normalizeFTSQuery(query)
    if (!ftsQuery) {
      return 0
    }

    return this.repository.softDeleteByQuery(ftsQuery)
  }

  public async recall(input: RecallQuery): Promise<RecallResult> {
    if (!this._isLoaded) {
      await this.load()
    }

    await this.syncContextFiles()

    const topK = input.topK || LEON_MEMORY_RECALL_TOP_K
    const tokenBudget = input.tokenBudget || LEON_MEMORY_EXECUTION_TOKEN_BUDGET
    const namespaces = input.namespaces || [
      'memory_persistent',
      'memory_daily',
      'memory_discussion',
      'context'
    ]

    const ftsQuery = normalizeFTSQuery(input.query || '')
    const memoryNamespaces = namespaces.filter((namespace) =>
      namespace !== 'context'
    )

    const hits: RecallHit[] = []

    if (ftsQuery) {
      if (memoryNamespaces.length > 0) {
        hits.push(
          ...this.repository.searchMemoryChunks({
            query: ftsQuery,
            namespaces: memoryNamespaces,
            topK: topK * 2
          })
        )
      }

      if (namespaces.includes('context')) {
        hits.push(
          ...this.repository.searchContextChunks({
            query: ftsQuery,
            namespaces: ['context'],
            topK: topK * 2
          })
        )
      }
    }

    if (hits.length > 1) {
      if (input.useEmbeddings && this.embeddingProvider.isReady) {
        const queryVector = await this.embeddingProvider.embedText(input.query)
        if (queryVector && queryVector.length > 0) {
          for (const hit of hits) {
            let chunkVector = this.repository.getChunkEmbeddingVector(hit.chunkId)
            if (!chunkVector) {
              chunkVector = await this.embeddingProvider.embedText(hit.content)
              if (chunkVector && chunkVector.length > 0) {
                this.repository.setChunkEmbeddingVector(
                  hit.chunkId,
                  chunkVector,
                  this.embeddingProvider.modelName || 'embedding'
                )
              }
            }

            if (chunkVector && chunkVector.length > 0) {
              hit.rerankScore = cosineSimilarity(queryVector, chunkVector)
            }
          }

          hits.sort((a, b) => {
            const aRerank = a.rerankScore ?? -1
            const bRerank = b.rerankScore ?? -1
            if (aRerank !== bRerank) {
              return bRerank - aRerank
            }

            return a.bm25Score - b.bm25Score
          })
        } else {
          hits.sort((a, b) => a.bm25Score - b.bm25Score)
        }
      } else {
        hits.sort((a, b) => a.bm25Score - b.bm25Score)
      }
    }

    const facts = input.includeFacts
      ? this.repository.getFactsTop(8)
      : []

    const selectedHits: RecallHit[] = []
    let usedTokenEstimate = 0

    for (const hit of hits) {
      const estimate = Math.max(1, Math.ceil(hit.content.length / 4))
      if (selectedHits.length >= topK) {
        break
      }
      if (usedTokenEstimate + estimate > tokenBudget) {
        break
      }

      selectedHits.push(hit)
      usedTokenEstimate += estimate
    }

    const result: RecallResult = {
      hits: selectedHits,
      facts,
      promptText: '',
      usedTokenEstimate
    }
    result.promptText = renderRecallPrompt(result)

    return result
  }

  public async buildPlanningMemoryPack(
    query: string,
    tokenBudget = LEON_MEMORY_PLANNING_TOKEN_BUDGET
  ): Promise<string> {
    const recalled = await this.recall({
      query,
      namespaces: [
        'memory_persistent',
        'memory_daily',
        'memory_discussion',
        'context'
      ],
      topK: LEON_MEMORY_RECALL_TOP_K,
      tokenBudget,
      includeFacts: true,
      useEmbeddings: true
    })

    return recalled.promptText
  }

  public async buildExecutionMemoryPack(
    query: string,
    _toolkitId: string,
    tokenBudget = LEON_MEMORY_EXECUTION_TOKEN_BUDGET
  ): Promise<string> {
    const recalled = await this.recall({
      query,
      namespaces: ['memory_persistent', 'memory_discussion', 'context'],
      topK: LEON_MEMORY_RECALL_TOP_K,
      tokenBudget,
      includeFacts: true,
      useEmbeddings: true
    })

    return recalled.promptText
  }

  public async observeTurn(input: TurnObservationInput): Promise<void> {
    if (!this._isLoaded) {
      await this.load()
    }

    const userMessage = normalizeContent(input.userMessage)
    const assistantMessage = normalizeContent(input.assistantMessage)
    if (!userMessage && !assistantMessage) {
      return
    }

    const now = input.sentAt || Date.now()
    const dayKey = toDayKey(now)
    const pairedContent = `Owner: ${userMessage}\nLeon: ${assistantMessage}`

    await this.remember({
      scope: 'daily',
      kind: 'event',
      title: 'Conversation event',
      content: pairedContent,
      sourceType: 'conversation',
      sourceRef: `turn:${now}`,
      dayKey,
      importance: 0.55,
      confidence: 0.85,
      metadata: {
        route: input.route
      }
    })

    await this.remember({
      scope: 'discussion',
      kind: 'note',
      title: 'Recent discussion',
      content: pairedContent,
      sourceType: 'conversation',
      sourceRef: `turn:${now}`,
      dayKey,
      expiresAt: now + DISCUSSION_TTL_MS,
      importance: 0.45,
      confidence: 0.75,
      metadata: {
        route: input.route
      }
    })

    if (/\b(remember that|remember this|don['’]t forget|save that|save this)\b/i.test(userMessage)) {
      await this.remember({
        scope: 'persistent',
        kind: 'note',
        title: 'User explicit memory',
        content: userMessage,
        sourceType: 'explicit_user',
        sourceRef: `turn:${now}`,
        importance: 0.95,
        confidence: 0.95
      })
    }

    await this.summarizeDay(dayKey)
    await this.pruneDiscussion(now)
  }

  public async summarizeDay(dayKey: string): Promise<void> {
    if (!this._isLoaded) {
      await this.load()
    }

    const entries = this.repository.getDailyConversationLogs(dayKey)
    const messageLogs = entries.flatMap((entry) =>
      parseConversationPair(entry.content).map((parsed) => ({
        who: parsed.who,
        message: parsed.message,
        sentAt: Date.now()
      }))
    )

    const summaryMarkdown = buildDailyMarkdownSummary(dayKey, messageLogs)
    const summaryPath = path.join(this.dailyPath, `${dayKey}.md`)
    await fs.promises.writeFile(summaryPath, summaryMarkdown, 'utf8')

    const existingSummary = this.repository.getDailySummaryItem(dayKey)
    const summaryInput: MemoryWriteInput = {
      scope: 'daily',
      kind: 'summary',
      title: `Daily summary ${dayKey}`,
      content: summaryMarkdown,
      sourceType: 'system',
      sourceRef: `daily-summary:${dayKey}`,
      dayKey,
      importance: 0.7,
      confidence: 0.85,
      metadata: {
        daily_summary: true
      }
    }

    if (existingSummary?.id) {
      summaryInput.supersedesItemId = existingSummary.id
    }

    await this.remember(summaryInput)
  }

  public async pruneDiscussion(nowTs = Date.now()): Promise<number> {
    if (!this._isLoaded) {
      await this.load()
    }

    return this.repository.markDiscussionExpired(nowTs)
  }

  public async syncContextFiles(force = false): Promise<void> {
    if (!this._isLoaded && !force) {
      await this.load()
      return
    }

    const now = Date.now()
    if (!force && now - this.lastContextSyncAt < CONTEXT_SYNC_TTL_MS) {
      return
    }

    try {
      await fs.promises.mkdir(CONTEXT_PATH, { recursive: true })
      const entries = await fs.promises.readdir(CONTEXT_PATH, {
        withFileTypes: true
      })

      const markdownFiles = entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
        .map((entry) => path.join(CONTEXT_PATH, entry.name))

      const livePaths = new Set(markdownFiles)

      for (const filePath of markdownFiles) {
        const filename = path.basename(filePath)
        const content = normalizeContent(await fs.promises.readFile(filePath, 'utf8'))
        if (!content) {
          continue
        }

        const checksum = computeHash(content)
        const currentDocument = this.repository.getContextDocumentByPath(filePath)
        if (currentDocument && String(currentDocument['checksum'] || '') === checksum) {
          continue
        }

        const nowTs = Date.now()
        const documentId = currentDocument?.['id']
          ? String(currentDocument['id'])
          : randomUUID()

        const documentInput: ContextDocumentInput = {
          id: documentId,
          filename,
          filePath,
          checksum,
          title: filename,
          createdAt: currentDocument?.['created_at']
            ? Number(currentDocument['created_at'])
            : nowTs,
          updatedAt: nowTs,
          lastIndexedAt: nowTs
        }
        this.repository.upsertContextDocument(documentInput)

        const chunks = chunkText(content).map<ContextChunkInput>((chunk) => ({
          id: randomUUID(),
          documentId,
          chunkIndex: chunk.index,
          content: chunk.content,
          tokenEstimate: chunk.tokenEstimate,
          createdAt: nowTs,
          updatedAt: nowTs
        }))

        if (this.embeddingProvider.isReady) {
          for (const chunk of chunks) {
            const vector = await this.embeddingProvider.embedText(chunk.content)
            if (!vector || vector.length === 0) {
              continue
            }

            chunk.embeddingModel = this.embeddingProvider.modelName || 'embedding'
            chunk.embeddingVector = vector
          }
        }

        this.repository.replaceContextChunks(documentId, chunks)
      }

      const indexedPaths = this.repository.listContextDocumentPaths()
      for (const indexedPath of indexedPaths) {
        if (!livePaths.has(indexedPath)) {
          this.repository.markContextDocumentDeleted(indexedPath)
        }
      }

      this.lastContextSyncAt = now
    } catch (e) {
      LogHelper.title('Memory Manager')
      LogHelper.warning(`Failed to sync context files: ${e}`)
    }
  }
}
