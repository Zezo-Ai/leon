import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'

import {
  CONTEXT_PATH,
  MEMORY_DB_PATH,
  MEMORY_PATH
} from '@/constants'
import { LLMDuties } from '@/core/llm-manager/types'
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
const LEON_MEMORY_DISCUSSION_TTL_DAYS = 5
const LEON_MEMORY_RECALL_TOP_K = 12
const LEON_MEMORY_PLANNING_TOKEN_BUDGET = 220
const LEON_MEMORY_EXECUTION_TOKEN_BUDGET = 320
const PERSISTENT_EXTRACTION_TIMEOUT_MS = 45_000
const PERSISTENT_EXTRACTION_MAX_RETRIES = 1
const PERSISTENT_EXTRACTION_MAX_TOKENS = 220
const PERSISTENT_EXTRACTION_MAX_USER_CHARS = 1_600
const PERSISTENT_EXTRACTION_MAX_ASSISTANT_CHARS = 1_200
const STORAGE_MAINTENANCE_INTERVAL_MS = 6 * 60 * 60 * 1_000
const SOFT_DELETED_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000
const DAILY_SUMMARY_QUEUE_STALE_MS = 2 * 60 * 1_000
const PERSISTENT_SIMILARITY_JACCARD_THRESHOLD = 0.84
const PERSISTENT_SIMILARITY_CONTAINMENT_MIN_CHARS = 40
const RECALL_MIN_QUERY_TERMS = 3
const MIN_TRUNCATED_RECALL_TOKENS = 48
const TRUNCATED_RECALL_BUDGET_RATIO = 0.6
const DISCUSSION_TTL_MS = LEON_MEMORY_DISCUSSION_TTL_DAYS * 24 * 60 * 60 * 1_000
const EXTRACT_PERSISTENT_MEMORY_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          content: { type: 'string' },
          confidence: { type: 'number' }
        },
        required: ['content'],
        additionalProperties: false
      }
    }
  },
  required: ['items'],
  additionalProperties: false
} as const

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

function tokenizeWords(content: string): string[] {
  return (content.toLowerCase().match(/[a-z0-9_]+/g) || [])
    .map((token) => token.trim())
    .filter((token) => token.length >= 2)
}

function namespaceRecallWeight(namespace: KnowledgeNamespace): number {
  switch (namespace) {
    case 'context':
      return 1
    case 'memory_persistent':
      return 0.85
    case 'memory_daily':
      return 0.6
    case 'memory_discussion':
      return 0.5
    case 'conversation_daily':
      return 0.55
    default:
      return 0.6
  }
}

function isConversationEchoChunk(content: string): boolean {
  const normalized = normalizeContent(content)
  return normalized.startsWith('Owner:') && normalized.includes('\nLeon:')
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

function truncateForExtraction(content: string, maxChars: number): string {
  if (content.length <= maxChars) {
    return content
  }

  return `${content.slice(0, maxChars).trimEnd()}...`
}

function shouldAttemptPersistentExtraction(
  userMessage: string,
  assistantMessage: string
): boolean {
  const userWordCount = userMessage.split(/\s+/).filter(Boolean).length
  const assistantWordCount = assistantMessage.split(/\s+/).filter(Boolean).length

  // Keep this generic (no keyword checks): skip only very short/low-signal turns.
  return userWordCount >= 4 || assistantWordCount >= 8
}

export default class MemoryManager {
  private static instance: MemoryManager

  private _isLoaded = false
  private lastContextSyncAt = 0
  private lastStorageMaintenanceAt = 0
  private readonly repository = new MemoryRepository()
  private readonly embeddingProvider: EmbeddingProvider = new LlamaEmbeddingProvider()
  private readonly persistentPath = path.join(MEMORY_PATH, 'persistent')
  private readonly dailyPath = path.join(MEMORY_PATH, 'daily')
  private readonly discussionPath = path.join(MEMORY_PATH, 'discussion')
  private readonly dailySummaryQueue = new Map<
    string,
    { promise: Promise<void>, startedAt: number }
  >()

  private getPersistentEntryFilePath(itemId: string, timestamp: number): string {
    const date = new Date(timestamp)
    const year = String(date.getUTCFullYear())
    const month = String(date.getUTCMonth() + 1).padStart(2, '0')
    const day = String(date.getUTCDate()).padStart(2, '0')

    return path.join(this.persistentPath, year, month, day, `${itemId}.md`)
  }

  private normalizeForSimilarity(text: string): string {
    return normalizeContent(text)
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  }

  private tokenizeForSimilarity(text: string): string[] {
    return this.normalizeForSimilarity(text)
      .split(' ')
      .map((token) => token.trim())
      .filter((token) => token.length >= 2)
  }

  private tokenJaccardSimilarity(tokensA: string[], tokensB: string[]): number {
    if (tokensA.length === 0 || tokensB.length === 0) {
      return 0
    }

    const setA = new Set(tokensA)
    const setB = new Set(tokensB)
    let intersectionSize = 0

    for (const token of setA) {
      if (setB.has(token)) {
        intersectionSize += 1
      }
    }

    const unionSize = setA.size + setB.size - intersectionSize
    if (unionSize <= 0) {
      return 0
    }

    return intersectionSize / unionSize
  }

  private isNearDuplicatePersistentContent(
    candidate: string,
    existing: string
  ): boolean {
    const normalizedCandidate = this.normalizeForSimilarity(candidate)
    const normalizedExisting = this.normalizeForSimilarity(existing)
    if (!normalizedCandidate || !normalizedExisting) {
      return false
    }

    if (normalizedCandidate === normalizedExisting) {
      return true
    }

    const shorter = normalizedCandidate.length <= normalizedExisting.length
      ? normalizedCandidate
      : normalizedExisting
    const longer = shorter === normalizedCandidate
      ? normalizedExisting
      : normalizedCandidate

    if (
      shorter.length >= PERSISTENT_SIMILARITY_CONTAINMENT_MIN_CHARS &&
      longer.includes(shorter)
    ) {
      return true
    }

    const candidateTokens = this.tokenizeForSimilarity(normalizedCandidate)
    const existingTokens = this.tokenizeForSimilarity(normalizedExisting)
    if (candidateTokens.length < 4 || existingTokens.length < 4) {
      return false
    }

    return (
      this.tokenJaccardSimilarity(candidateTokens, existingTokens) >=
      PERSISTENT_SIMILARITY_JACCARD_THRESHOLD
    )
  }

  private async shouldSkipSimilarPersistentCandidate(
    candidate: string
  ): Promise<boolean> {
    const ftsQuery = normalizeFTSQuery(candidate)
    if (!ftsQuery) {
      return false
    }

    const hits = this.repository.searchMemoryChunks({
      query: ftsQuery,
      namespaces: ['memory_persistent'],
      topK: 8
    })

    for (const hit of hits) {
      if (this.isNearDuplicatePersistentContent(candidate, hit.content)) {
        const preview = hit.content.length > 200
          ? `${hit.content.slice(0, 200)}...`
          : hit.content
        LogHelper.title('Memory Manager')
        LogHelper.debug(
          `Skipped persistent candidate due to similarity with existing memory: ${JSON.stringify(
            preview
          )}`
        )
        return true
      }
    }

    return false
  }

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
      await this.embeddingProvider.load()

      await this.syncContextFiles(true)

      this._isLoaded = true
      LogHelper.title('Memory Manager')
      LogHelper.success('Loaded')
    } catch (e) {
      LogHelper.title('Memory Manager')
      LogHelper.error(`Failed to load: ${e}`)
    }
  }

  public shouldRecallForQuery(query: string): boolean {
    const terms = (String(query || '').toLowerCase().match(/[a-z0-9_]+/g) || [])
      .map((term) => term.trim())
      .filter((term) => term.length >= 2)

    return terms.length >= RECALL_MIN_QUERY_TERMS
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
      const filePath = this.getPersistentEntryFilePath(saved.id, saved.createdAt)
      const markdown = `> Persistent memory entry (${saved.kind})\n\n# ${saved.title || saved.kind}\n\nID: ${saved.id}\nCreated At: ${new Date(saved.createdAt).toISOString()}\n\n${saved.content}\n`
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true })
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

    LogHelper.title('Memory Manager')
    LogHelper.debug(
      `Recall query="${input.query}" | namespaces=${namespaces.join(', ')} | context_files=${
        input.contextFilenames && input.contextFilenames.length > 0
          ? input.contextFilenames.join(', ')
          : 'all'
      } | topK=${topK} | token_budget=${tokenBudget} | fts_query="${ftsQuery || 'none'}"`
    )

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
        const contextSearchParams: {
          query: string
          namespaces: string[]
          topK: number
          filenames?: string[]
        } = {
          query: ftsQuery,
          namespaces: ['context'],
          topK: topK * 2
        }

        if (input.contextFilenames && input.contextFilenames.length > 0) {
          contextSearchParams.filenames = input.contextFilenames
        }

        hits.push(
          ...this.repository.searchContextChunks(contextSearchParams)
        )
      }
    }

    const queryTokens = [...new Set(tokenizeWords(input.query))]
    const lexicalScores = new Map<string, number>()
    const rankingScores = new Map<string, number>()
    if (hits.length > 0 && queryTokens.length > 0) {
      const queryTokenSet = new Set(queryTokens)
      const tokenDocumentFrequency = new Map<string, number>()
      const perHitTokenSets = new Map<string, Set<string>>()

      for (const hit of hits) {
        const hitTokenSet = new Set(tokenizeWords(hit.content))
        perHitTokenSets.set(hit.chunkId, hitTokenSet)

        for (const token of queryTokenSet) {
          if (!hitTokenSet.has(token)) {
            continue
          }
          tokenDocumentFrequency.set(
            token,
            (tokenDocumentFrequency.get(token) || 0) + 1
          )
        }
      }

      const totalDocs = hits.length
      const tokenWeights = new Map<string, number>()
      let totalWeight = 0
      for (const token of queryTokenSet) {
        const df = tokenDocumentFrequency.get(token) || 0
        const idf = Math.log((totalDocs + 1) / (df + 1)) + 1
        tokenWeights.set(token, idf)
        totalWeight += idf
      }

      for (const hit of hits) {
        const hitTokenSet = perHitTokenSets.get(hit.chunkId)
        if (!hitTokenSet || totalWeight <= 0) {
          lexicalScores.set(hit.chunkId, 0)
          continue
        }

        let matchedWeight = 0
        for (const token of queryTokenSet) {
          if (hitTokenSet.has(token)) {
            matchedWeight += tokenWeights.get(token) || 0
          }
        }

        lexicalScores.set(hit.chunkId, matchedWeight / totalWeight)
      }
    }

    for (const hit of hits) {
      const lexical = lexicalScores.get(hit.chunkId) || 0
      const namespaceWeight = namespaceRecallWeight(hit.namespace)
      const structureWeight = isConversationEchoChunk(hit.content) ? 0.55 : 1
      rankingScores.set(
        hit.chunkId,
        lexical * namespaceWeight * structureWeight
      )
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
            const aRank = rankingScores.get(a.chunkId) || 0
            const bRank = rankingScores.get(b.chunkId) || 0
            if (aRank !== bRank) {
              return bRank - aRank
            }

            const aRerank = a.rerankScore ?? -1
            const bRerank = b.rerankScore ?? -1
            if (aRerank !== bRerank) {
              return bRerank - aRerank
            }

            return a.bm25Score - b.bm25Score
          })
        } else {
          hits.sort((a, b) => {
            const aRank = rankingScores.get(a.chunkId) || 0
            const bRank = rankingScores.get(b.chunkId) || 0
            if (aRank !== bRank) {
              return bRank - aRank
            }

            return a.bm25Score - b.bm25Score
          })
        }
      } else {
        hits.sort((a, b) => {
          const aRank = rankingScores.get(a.chunkId) || 0
          const bRank = rankingScores.get(b.chunkId) || 0
          if (aRank !== bRank) {
            return bRank - aRank
          }

          return a.bm25Score - b.bm25Score
        })
      }
    }

    LogHelper.title('Memory Manager')
    LogHelper.debug(`Recall candidates: ${hits.length}`)

    const facts = input.includeFacts
      ? this.repository.getFactsTop(8)
      : []

    const selectedHits: RecallHit[] = []
    const selectedChunkIds = new Set<string>()
    const selectedContentHashes = new Set<string>()
    let usedTokenEstimate = 0
    let hasSelectedContext = false

    const fitHitToBudget = (
      hit: RecallHit,
      remainingBudget: number,
      allowTruncate: boolean
    ): { fittedHit: RecallHit, tokens: number, truncated: boolean } | null => {
      if (remainingBudget <= 0) {
        return null
      }

      const fullEstimate = Math.max(1, Math.ceil(hit.content.length / 4))
      if (fullEstimate <= remainingBudget) {
        return {
          fittedHit: hit,
          tokens: fullEstimate,
          truncated: false
        }
      }

      if (!allowTruncate || remainingBudget < MIN_TRUNCATED_RECALL_TOKENS) {
        return null
      }

      const truncatedTokenBudget = Math.max(
        MIN_TRUNCATED_RECALL_TOKENS,
        Math.min(
          remainingBudget,
          Math.floor(tokenBudget * TRUNCATED_RECALL_BUDGET_RATIO)
        )
      )
      if (truncatedTokenBudget > remainingBudget) {
        return null
      }

      const maxChars = truncatedTokenBudget * 4
      const truncatedContent =
        hit.content.length > maxChars
          ? `${hit.content.slice(0, maxChars).trimEnd()}...`
          : hit.content
      const truncatedEstimate = Math.max(
        1,
        Math.ceil(truncatedContent.length / 4)
      )

      return {
        fittedHit: {
          ...hit,
          content: truncatedContent
        },
        tokens: truncatedEstimate,
        truncated: true
      }
    }

    const topContextCandidate = namespaces.includes('context')
      ? hits.find((hit) => hit.namespace === 'context')
      : undefined
    if (topContextCandidate) {
      const contextSeed = fitHitToBudget(
        topContextCandidate,
        tokenBudget - usedTokenEstimate,
        true
      )
      if (contextSeed) {
        selectedHits.push(contextSeed.fittedHit)
        selectedChunkIds.add(topContextCandidate.chunkId)
        selectedContentHashes.add(
          computeHash(
            normalizeContent(contextSeed.fittedHit.content).toLowerCase()
          )
        )
        usedTokenEstimate += contextSeed.tokens
        hasSelectedContext = true
        if (contextSeed.truncated) {
          LogHelper.title('Memory Manager')
          LogHelper.debug(
            `Recall context seed truncated: source="${topContextCandidate.sourcePath || topContextCandidate.title || topContextCandidate.namespace}" tokens=${contextSeed.tokens}`
          )
        }
      }
    }

    for (const hit of hits) {
      if (selectedHits.length >= topK) {
        break
      }
      if (selectedChunkIds.has(hit.chunkId)) {
        continue
      }
      const candidateHash = computeHash(normalizeContent(hit.content).toLowerCase())
      if (selectedContentHashes.has(candidateHash)) {
        continue
      }
      const remainingBudget = tokenBudget - usedTokenEstimate
      const allowTruncate =
        selectedHits.length === 0 ||
        (hit.namespace === 'context' && !hasSelectedContext)
      const fitted = fitHitToBudget(hit, remainingBudget, allowTruncate)
      if (!fitted) {
        continue
      }
      selectedHits.push(fitted.fittedHit)
      selectedChunkIds.add(hit.chunkId)
      selectedContentHashes.add(
        computeHash(normalizeContent(fitted.fittedHit.content).toLowerCase())
      )
      usedTokenEstimate += fitted.tokens
      if (fitted.fittedHit.namespace === 'context') {
        hasSelectedContext = true
      }
      if (fitted.truncated) {
        LogHelper.title('Memory Manager')
        LogHelper.debug(
          `Recall selected truncated hit: source="${hit.sourcePath || hit.title || hit.namespace}" truncated_tokens=${fitted.tokens}`
        )
      }
    }

    LogHelper.title('Memory Manager')
    LogHelper.debug(
      `Recall selected: ${selectedHits.length} | used_tokens=${usedTokenEstimate}`
    )
    for (const [index, hit] of selectedHits.entries()) {
      const sourceLabel = hit.sourcePath
        ? path.basename(hit.sourcePath)
        : hit.title || hit.namespace
      const preview = hit.content.length > 280
        ? `${hit.content.slice(0, 280)}...`
        : hit.content
      LogHelper.debug(
        `Recall selected[${index + 1}] source="${sourceLabel}" namespace=${hit.namespace} score=${(rankingScores.get(hit.chunkId) || 0).toFixed(4)} lexical=${(lexicalScores.get(hit.chunkId) || 0).toFixed(4)} bm25=${hit.bm25Score.toFixed(4)} rerank=${(hit.rerankScore ?? -1).toFixed(4)} content=${JSON.stringify(preview)}`
      )
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
    if (!this.shouldRecallForQuery(query)) {
      return ''
    }

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

    if (!recalled.hits.length && !recalled.facts.length) {
      return ''
    }

    LogHelper.title('Memory Manager')
    LogHelper.debug(
      `Planning memory pack built | chars=${recalled.promptText.length} | used_tokens=${recalled.usedTokenEstimate}`
    )

    return recalled.promptText
  }

  public async buildExecutionMemoryPack(
    query: string,
    _toolkitId: string,
    contextFiles: string[] = [],
    tokenBudget = LEON_MEMORY_EXECUTION_TOKEN_BUDGET
  ): Promise<string> {
    if (!this.shouldRecallForQuery(query)) {
      return ''
    }

    const normalizedContextFiles = [...new Set(contextFiles)]
    const includeContext = normalizedContextFiles.length > 0

    const recalled = await this.recall({
      query,
      namespaces: includeContext
        ? ['memory_persistent', 'memory_discussion', 'context']
        : ['memory_persistent', 'memory_discussion'],
      contextFilenames: includeContext ? normalizedContextFiles : [],
      topK: LEON_MEMORY_RECALL_TOP_K,
      tokenBudget,
      includeFacts: true,
      useEmbeddings: true
    })

    if (!recalled.hits.length && !recalled.facts.length) {
      return ''
    }

    LogHelper.title('Memory Manager')
    LogHelper.debug(
      `Execution memory pack built | toolkit=${_toolkitId} | context_files=${
        normalizedContextFiles.length > 0
          ? normalizedContextFiles.join(', ')
          : 'none'
      } | chars=${recalled.promptText.length} | used_tokens=${recalled.usedTokenEstimate}`
    )

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

    await this.summarizeDay(dayKey)
    await this.pruneDiscussion(now)
  }

  public async savePersistentMemoryCandidates(
    candidates: string[],
    sourceRef: string,
    nowTs = Date.now()
  ): Promise<number> {
    if (!this._isLoaded) {
      await this.load()
    }

    const normalizedCandidates = [...new Set(candidates)]
      .map((item) => normalizeContent(item))
      .filter((item) => item.length > 0)

    if (normalizedCandidates.length === 0) {
      return 0
    }

    let savedCount = 0
    const savedEntries: Array<{ filePath: string, content: string }> = []
    for (const candidate of normalizedCandidates) {
      if (await this.shouldSkipSimilarPersistentCandidate(candidate)) {
        continue
      }

      const saved = await this.remember({
        scope: 'persistent',
        kind: 'note',
        title: 'Persistent memory candidate',
        content: candidate,
        sourceType: 'explicit_user',
        sourceRef,
        importance: 0.95,
        confidence: 0.95,
        metadata: {
          saved_at: nowTs
        }
      })
      savedCount += 1
      savedEntries.push({
        filePath: this.getPersistentEntryFilePath(saved.id, saved.createdAt),
        content: saved.content
      })
    }

    LogHelper.title('Memory Manager')
    LogHelper.debug(
      `Persistent memory candidates saved: ${savedCount}`
    )
    for (const savedEntry of savedEntries) {
      LogHelper.debug(
        `Persistent memory file="${savedEntry.filePath}" content=${JSON.stringify(
          savedEntry.content
        )}`
      )
    }
    try {
      const dbStats = fs.statSync(MEMORY_DB_PATH)
      const persistentItemCount = this.repository.countActivePersistentItems()
      LogHelper.debug(
        `Memory index file="${MEMORY_DB_PATH}" size_bytes=${dbStats.size} persistent_items=${persistentItemCount}`
      )
    } catch {
      // Ignore stat errors for debug stats.
    }

    return savedCount
  }

  public async savePersistentMemoryCandidatesFromTurn(
    userMessage: string,
    assistantMessage: string,
    sentAt: number
  ): Promise<number> {
    if (!this._isLoaded) {
      await this.load()
    }

    const normalizedUserMessage = truncateForExtraction(
      normalizeContent(userMessage),
      PERSISTENT_EXTRACTION_MAX_USER_CHARS
    )
    const normalizedAssistantMessage = truncateForExtraction(
      normalizeContent(assistantMessage),
      PERSISTENT_EXTRACTION_MAX_ASSISTANT_CHARS
    )

    if (
      !shouldAttemptPersistentExtraction(
        normalizedUserMessage,
        normalizedAssistantMessage
      )
    ) {
      LogHelper.title('Memory Manager')
      LogHelper.debug(
        'Persistent memory extraction skipped for low-signal turn'
      )
      return 0
    }

    const prompt = `Conversation turn:
User: ${normalizedUserMessage}
Leon: ${normalizedAssistantMessage}

Extract only durable personal memories worth persisting long-term.
Keep only stable user facts/preferences/commitments likely useful in future conversations.
Do not include transient chat content.
Return JSON.`

    try {
      const { LLM_PROVIDER } = await import('@/core')
      const completion = await LLM_PROVIDER.prompt(prompt, {
        dutyType: LLMDuties.Custom,
        systemPrompt:
          'Extract stable long-term user memory candidates. Be strict and concise.',
        data: EXTRACT_PERSISTENT_MEMORY_SCHEMA,
        timeout: PERSISTENT_EXTRACTION_TIMEOUT_MS,
        maxRetries: PERSISTENT_EXTRACTION_MAX_RETRIES,
        maxTokens: PERSISTENT_EXTRACTION_MAX_TOKENS,
        disableThinking: true,
        trackProviderErrors: false
      })

      if (!completion?.output) {
        LogHelper.title('Memory Manager')
        LogHelper.warning('Persistent memory extraction returned no output')
        return 0
      }

      const payload =
        typeof completion.output === 'string'
          ? JSON.parse(completion.output)
          : completion.output
      if (!payload || typeof payload !== 'object') {
        LogHelper.title('Memory Manager')
        LogHelper.warning(
          'Persistent memory extraction returned invalid payload'
        )
        return 0
      }

      const items = Array.isArray((payload as Record<string, unknown>)['items'])
        ? ((payload as Record<string, unknown>)['items'] as Array<unknown>)
        : []

      const candidates = items
        .map((item) =>
          item && typeof item === 'object'
            ? String((item as Record<string, unknown>)['content'] || '').trim()
            : ''
        )
        .filter((content) => content.length > 0)
        .slice(0, 3)

      if (candidates.length === 0) {
        return 0
      }

      const saved = await this.savePersistentMemoryCandidates(
        candidates,
        `turn:${sentAt}`,
        sentAt
      )

      LogHelper.title('Memory Manager')
      LogHelper.debug(
        `Persistent memory candidates extracted and saved: ${saved}`
      )

      return saved
    } catch (error) {
      LogHelper.title('Memory Manager')
      LogHelper.warning(`Persistent memory extraction skipped: ${error}`)
      return 0
    }
  }

  public async summarizeDay(dayKey: string): Promise<void> {
    if (!this._isLoaded) {
      await this.load()
    }

    const now = Date.now()
    const queuedSummary = this.dailySummaryQueue.get(dayKey)
    if (
      queuedSummary &&
      now - queuedSummary.startedAt > DAILY_SUMMARY_QUEUE_STALE_MS
    ) {
      LogHelper.title('Memory Manager')
      LogHelper.warning(
        `Daily summary queue reset for day=${dayKey} after ${Math.round(
          (now - queuedSummary.startedAt) / 1_000
        )}s stall`
      )
      this.dailySummaryQueue.delete(dayKey)
    }

    const previous = this.dailySummaryQueue.get(dayKey)?.promise || Promise.resolve()
    const current = previous
      .catch(() => undefined)
      .then(() => this.summarizeDayInternal(dayKey))

    this.dailySummaryQueue.set(dayKey, {
      promise: current,
      startedAt: now
    })
    try {
      await current
    } finally {
      if (this.dailySummaryQueue.get(dayKey)?.promise === current) {
        this.dailySummaryQueue.delete(dayKey)
      }
    }
  }

  private async summarizeDayInternal(dayKey: string): Promise<void> {
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

    let fileSize = 0
    let fileMtime = ''
    try {
      const stats = await fs.promises.stat(summaryPath)
      fileSize = stats.size
      fileMtime = stats.mtime.toISOString()
    } catch {
      // Ignore stat read issues for debug log.
    }

    LogHelper.title('Memory Manager')
    LogHelper.debug(
      `Daily memory summary updated: day=${dayKey} file="${summaryPath}" entries=${entries.length} chars=${summaryMarkdown.length} size_bytes=${fileSize} mtime=${fileMtime || 'unknown'}`
    )
  }

  public async pruneDiscussion(nowTs = Date.now()): Promise<number> {
    if (!this._isLoaded) {
      await this.load()
    }

    const deleted = this.repository.markDiscussionExpired(nowTs)
    await this.runStorageMaintenance(nowTs)
    return deleted
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

  private async runStorageMaintenance(nowTs: number): Promise<void> {
    if (nowTs - this.lastStorageMaintenanceAt < STORAGE_MAINTENANCE_INTERVAL_MS) {
      return
    }

    try {
      const purged = this.repository.purgeSoftDeleted(
        nowTs - SOFT_DELETED_RETENTION_MS
      )
      this.repository.optimizeStorage()
      this.lastStorageMaintenanceAt = nowTs

      LogHelper.title('Memory Manager')
      LogHelper.debug(
        `Storage maintenance completed: purged=${purged}`
      )
    } catch (error) {
      LogHelper.title('Memory Manager')
      LogHelper.warning(`Storage maintenance skipped: ${error}`)
    }
  }
}
