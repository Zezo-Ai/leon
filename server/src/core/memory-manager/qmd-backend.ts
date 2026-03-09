import fs from 'node:fs'
import path from 'node:path'

import execa from 'execa'

import {
  CONTEXT_PATH,
  MEMORY_PATH
} from '@/constants'
import { LogHelper } from '@/helpers/log-helper'
import {
  buildAdaptiveQueryTokenSet,
  buildHydratedBacktrackCandidates,
  buildDiscriminativeSecondPass,
  buildExpansionQuery,
  buildFinalSupportTokens,
  buildFocusedHitContent,
  buildHydratedRescueBridgeTokens,
  buildLexicalSearchQuery,
  buildQueryTokenSet,
  DEFAULT_QMD_NAMESPACE_WEIGHTS,
  extractContent,
  extractScore,
  normalizeFilename,
  normalizePath,
  parsePendingEmbeddingCount,
  parseRows,
  pickStringDeep,
  rankRetrievedHits,
  resolveRequestedCollectionName,
  shouldRunAdaptiveSecondPass
} from '@sdk/tools/memory/qmd-retrieval'

import type { KnowledgeNamespace } from './types'

const QMD_INDEX_NAME = 'leon-memory'
const QMD_UPDATE_MIN_INTERVAL_MS = 5_000
const QMD_EMBED_MIN_INTERVAL_MS = 30_000
const BRIDGE_SOURCE_CONTENT_CAP = 96_000

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

type QMDSearchMode = 'query' | 'search'

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
  private lastEmbedAt = 0
  private hybridRetrievalEnabled = false
  private embeddingRefreshPromise: Promise<void> | null = null
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

  public enableHybridRetrieval(): void {
    if (this.hybridRetrievalEnabled) {
      return
    }

    this.hybridRetrievalEnabled = true
    LogHelper.title('Memory Manager')
    LogHelper.debug('QMD hybrid retrieval enabled after first observed turn')
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
    await this.ensureEmbeddings()

    const uniqueNamespaces = [...new Set(input.namespaces)]
    if (uniqueNamespaces.length === 0) {
      return []
    }

    const perNamespaceLimit = Math.max(input.topK * 3, input.topK)
    const collectionNames = [
      ...new Set(
        uniqueNamespaces
          .map((namespace) => QMD_COLLECTIONS[namespace]?.name)
          .filter((name): name is string => Boolean(name))
      )
    ]
    if (collectionNames.length === 0) {
      return []
    }
    const globalLimit = Math.max(
      input.topK,
      perNamespaceLimit * collectionNames.length
    )
    const allowedContextFilenames = new Set(
      (input.contextFilenames || []).map((filename) => normalizeFilename(filename))
    )
    const namespaceByCollection = new Map<string, KnowledgeNamespace[]>(
      collectionNames.map((collectionName) => {
        const mappedNamespaces = uniqueNamespaces.filter(
          (namespace) => QMD_COLLECTIONS[namespace]?.name === collectionName
        )
        return [collectionName, mappedNamespaces]
      })
    )
    const collectionPathByName = new Map<string, string>(
      collectionNames.map((collectionName) => {
        const definition = Object.values(QMD_COLLECTIONS).find(
          (entry) => entry.name === collectionName
        )
        return [collectionName, definition?.dir || '']
      })
    )

    const queryTokens = buildQueryTokenSet(input.query)
    const hits: QMDRecallHit[] = []

    const runPreferredSearchModes = async (
      bridgeTerms: string[],
      scopedCollectionNames: string[],
      limit: number
    ): Promise<{
      rows: Array<Record<string, unknown>>
      modeUsed: QMDSearchMode
    }> => {
      const lexicalQuery = buildLexicalSearchQuery(input.query, bridgeTerms)
      let rows = parseRows(
        await this.runQMDSearchMode(
          'query',
          buildExpansionQuery(input.query, bridgeTerms),
          scopedCollectionNames,
          limit
        )
      )
      if (rows.length > 0) {
        return {
          rows,
          modeUsed: 'query'
        }
      }

      rows = parseRows(
        await this.runQMDSearchMode(
          'search',
          lexicalQuery,
          scopedCollectionNames,
          limit
        )
      )

      return {
        rows,
        modeUsed: 'search'
      }
    }

    const appendRows = (
      rowsToAppend: Array<Record<string, unknown>>,
      modeUsed: QMDSearchMode
    ): void => {
      for (const row of rowsToAppend) {
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

        const explicitCollection = resolveRequestedCollectionName(
          pickStringDeep(row, ['collection', 'collection_name', 'collectionName']),
          collectionNames
        )
        const collectionFromQmdPathMatch = sourcePath.match(/^qmd:\/\/([^/]+)\//i)
        const collectionFromQmdPath = resolveRequestedCollectionName(
          collectionFromQmdPathMatch?.[1] || '',
          collectionNames
        )
        const collectionFromAbsolutePath = collectionNames.find((collectionName) => {
          const collectionPath = collectionPathByName.get(collectionName)
          if (!collectionPath || !sourcePath) {
            return false
          }

          return sourcePath.startsWith(collectionPath)
        })
        const resolvedCollectionName =
          explicitCollection ||
          collectionFromQmdPath ||
          collectionFromAbsolutePath ||
          (collectionNames.length === 1 ? (collectionNames[0] || '') : '')

        const mappedNamespaces = namespaceByCollection.get(resolvedCollectionName) || []
        const resolvedNamespace =
          uniqueNamespaces.find((namespace) => mappedNamespaces.includes(namespace)) ||
          (uniqueNamespaces.length === 1 ? uniqueNamespaces[0] : null)
        if (!resolvedNamespace) {
          continue
        }

        if (
          resolvedNamespace === 'context' &&
          !isContextFilenameAllowed(allowedContextFilenames, sourcePath, title)
        ) {
          continue
        }

        hits.push({
          id,
          path: sourcePath,
          title,
          content,
          score: extractScore(row) + (modeUsed === 'query' ? 0.03 : 0.01),
          namespace: resolvedNamespace
        })
      }
    }

    const rankHitsByQuery = (
      hitsInput: QMDRecallHit[]
    ): Array<{ hit: QMDRecallHit, rankingScore: number, overlapCount: number }> => {
      return rankRetrievedHits(
        hitsInput,
        queryTokens,
        QMD_COLLECTIONS,
        namespaceWeights,
        BRIDGE_SOURCE_CONTENT_CAP
      )
    }
    const namespaceWeights: Partial<Record<KnowledgeNamespace, number>> = {
      ...DEFAULT_QMD_NAMESPACE_WEIGHTS
    }

    const hasPersistentHit = (): boolean =>
      hits.some((hit) => hit.namespace === 'memory_persistent')
    const retrievalStages: string[] = []
    const rewrittenQueries: string[] = []

    let rows: Array<Record<string, unknown>> = []
    let modeUsed: QMDSearchMode | null = null

    if (this.hybridRetrievalEnabled) {
      try {
        const result = await runPreferredSearchModes(
          [],
          collectionNames,
          globalLimit
        )
        rows = result.rows
        modeUsed = result.modeUsed
        retrievalStages.push(`initial:${modeUsed}:${rows.length}`)
      } catch (error) {
        LogHelper.title('Memory Manager')
        LogHelper.warning(
          `QMD preferred search failed for collections=${collectionNames.join(', ')}: ${String(error)}`
        )
      }
    } else {
      LogHelper.title('Memory Manager')
      LogHelper.debug('QMD cold-start retrieval mode: search-only (hybrid deferred)')
    }

    if (rows.length === 0) {
      try {
        rows = parseRows(
          await this.runQMDSearchMode(
            'search',
            buildLexicalSearchQuery(input.query),
            collectionNames,
            globalLimit
          )
        )
        modeUsed = 'search'
        retrievalStages.push(`fallback:search:${rows.length}`)
      } catch (error) {
        LogHelper.title('Memory Manager')
        LogHelper.warning(
          `QMD search fallback failed for collections=${collectionNames.join(', ')}: ${String(error)}`
        )
      }
    }

    if (modeUsed) {
      appendRows(rows, modeUsed)
    }

    let rankedHits = rankHitsByQuery(hits)
    if (!hasPersistentHit() || shouldRunAdaptiveSecondPass(rankedHits)) {
      try {
        const enrichmentRows = parseRows(
          await this.runQMDSearchMode(
            'search',
            buildLexicalSearchQuery(input.query),
            collectionNames,
            globalLimit
          )
        )
        appendRows(enrichmentRows, 'search')
        retrievalStages.push(`enrich:search:${enrichmentRows.length}`)
      } catch (error) {
        LogHelper.title('Memory Manager')
        LogHelper.warning(
          `QMD enrichment search failed for collections=${collectionNames.join(', ')}: ${String(error)}`
        )
      }

      const missingNamespaces = uniqueNamespaces.filter(
        (namespace) => !hits.some((hit) => hit.namespace === namespace)
      )
      for (const missingNamespace of missingNamespaces) {
        const collectionName = QMD_COLLECTIONS[missingNamespace]?.name
        if (!collectionName) {
          continue
        }

        try {
          appendRows(
            parseRows(
                await this.runQMDSearchMode(
                  'search',
                  buildLexicalSearchQuery(input.query),
                  [collectionName],
                  perNamespaceLimit
                )
            ),
            'search'
          )
        } catch (error) {
          LogHelper.title('Memory Manager')
          LogHelper.warning(
            `QMD scoped enrichment failed for collection=${collectionName}: ${String(error)}`
          )
        }
      }

      rankedHits = rankHitsByQuery(hits)
    }

    let secondPassSupportTokens: string[] = []
    if (!hasPersistentHit() || shouldRunAdaptiveSecondPass(rankedHits)) {
      const secondPass = buildDiscriminativeSecondPass(
        input.query,
        queryTokens,
        rankedHits.map((rankedHit) => rankedHit.hit),
        QMD_COLLECTIONS,
        BRIDGE_SOURCE_CONTENT_CAP
      )

      if (secondPass) {
        secondPassSupportTokens = secondPass.bridgeTokens
        rewrittenQueries.push(`second_pass=${JSON.stringify(secondPass.lexicalQuery)}`)

        try {
          const {
            rows: secondPassRows,
            modeUsed: secondPassMode
          } = await runPreferredSearchModes(
            secondPass.bridgeTokens,
            collectionNames,
            globalLimit
          )

          appendRows(secondPassRows, secondPassMode)
          retrievalStages.push(`second_pass:${secondPassMode}:${secondPassRows.length}`)

          const stillMissingNamespaces = uniqueNamespaces.filter(
            (namespace) => !hits.some((hit) => hit.namespace === namespace)
          )
          for (const missingNamespace of stillMissingNamespaces) {
            const collectionName = QMD_COLLECTIONS[missingNamespace]?.name
            if (!collectionName) {
              continue
            }

            try {
              appendRows(
                parseRows(
                  await this.runQMDSearchMode(
                    'search',
                    buildLexicalSearchQuery(input.query, secondPass.bridgeTokens),
                    [collectionName],
                    perNamespaceLimit
                  )
                ),
                'search'
              )
            } catch (error) {
              LogHelper.title('Memory Manager')
              LogHelper.warning(
                `QMD scoped second-pass failed for collection=${collectionName}: ${String(error)}`
              )
            }
          }

          rankedHits = rankHitsByQuery(hits)
        } catch (error) {
          LogHelper.title('Memory Manager')
          LogHelper.warning(
            `QMD second-pass failed for collections=${collectionNames.join(', ')}: ${String(error)}`
          )
        }
      }
    }

    let rescueSupportTokens: string[] = []
    const rescueBridgeTokens = buildHydratedRescueBridgeTokens(
      queryTokens,
      rankedHits,
      QMD_COLLECTIONS,
      BRIDGE_SOURCE_CONTENT_CAP
    ).filter((token) => !secondPassSupportTokens.includes(token))

    if (rescueBridgeTokens.length > 0) {
      rescueSupportTokens = rescueBridgeTokens
      rewrittenQueries.push(
        `rescue=${JSON.stringify(buildLexicalSearchQuery(input.query, rescueBridgeTokens))}`
      )

      try {
        const {
          rows: rescueRows,
          modeUsed: rescueMode
        } = await runPreferredSearchModes(
          rescueBridgeTokens,
          collectionNames,
          globalLimit
        )

        appendRows(rescueRows, rescueMode)
        retrievalStages.push(`rescue:${rescueMode}:${rescueRows.length}`)

        const stillMissingNamespaces = uniqueNamespaces.filter(
          (namespace) => !hits.some((hit) => hit.namespace === namespace)
        )
        for (const missingNamespace of stillMissingNamespaces) {
          const collectionName = QMD_COLLECTIONS[missingNamespace]?.name
          if (!collectionName) {
            continue
          }

          try {
            appendRows(
              parseRows(
                await this.runQMDSearchMode(
                  'search',
                  buildLexicalSearchQuery(input.query, rescueBridgeTokens),
                  [collectionName],
                  perNamespaceLimit
                )
              ),
              'search'
            )
          } catch (error) {
            LogHelper.title('Memory Manager')
            LogHelper.warning(
              `QMD scoped hydrated-rescue failed for collection=${collectionName}: ${String(error)}`
            )
          }
        }

        rankedHits = rankHitsByQuery(hits)
      } catch (error) {
        LogHelper.title('Memory Manager')
        LogHelper.warning(
          `QMD hydrated-rescue failed for collections=${collectionNames.join(', ')}: ${String(error)}`
        )
      }
    }

    const backtrackCandidates = buildHydratedBacktrackCandidates(
      queryTokens,
      rankedHits,
      QMD_COLLECTIONS,
      namespaceWeights,
      BRIDGE_SOURCE_CONTENT_CAP
    )
    const existingHitPaths = new Set(hits.map((hit) => `${hit.namespace}|${hit.path}`))
    const appendedBacktrackHits = backtrackCandidates
      .filter((candidate) => !existingHitPaths.has(
        `${candidate.hit.namespace}|${candidate.hit.path}`
      ))
      .slice(0, 4)

    if (appendedBacktrackHits.length > 0) {
      for (const candidate of appendedBacktrackHits) {
        hits.push({
          ...candidate.hit,
          score: Math.max(candidate.hit.score, candidate.rankingScore)
        })
      }
      retrievalStages.push(`backtrack:local:${appendedBacktrackHits.length}`)
      rankedHits = rankHitsByQuery(hits)
    }

    const excerptQueryTokens = buildAdaptiveQueryTokenSet(
      queryTokens,
      rankedHits.map((rankedHit) => rankedHit.hit),
      QMD_COLLECTIONS,
      BRIDGE_SOURCE_CONTENT_CAP
    )

    const supportTokens = buildFinalSupportTokens(
      excerptQueryTokens,
      rankedHits,
      QMD_COLLECTIONS,
      BRIDGE_SOURCE_CONTENT_CAP,
      [...secondPassSupportTokens, ...rescueSupportTokens]
    )

    const output = rankedHits.map((rankedHit) => ({
      ...rankedHit.hit,
      content: buildFocusedHitContent(
        rankedHit.hit,
        excerptQueryTokens,
        supportTokens,
        QMD_COLLECTIONS,
        BRIDGE_SOURCE_CONTENT_CAP
      )
    }))

    if (
      uniqueNamespaces.includes('context') &&
      !output.some((hit) => hit.namespace === 'context')
    ) {
      LogHelper.title('Memory Manager')
      LogHelper.debug(
        'QMD returned no context candidates for this query; planning may rely on memory-only hits'
      )
    }
    LogHelper.title('Memory Manager')
    LogHelper.debug(
      `QMD retrieval stages=${retrievalStages.join(' -> ')} final_hits=${output.length}`
    )
    if (rewrittenQueries.length > 0) {
      LogHelper.title('Memory Manager')
      LogHelper.debug(`QMD retrieval rewritten ${rewrittenQueries.join(' | ')}`)
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
      if (await this.collectionExists(name)) {
        return
      }
      throw error
    }
  }

  private async collectionExists(name: string): Promise<boolean> {
    try {
      await this.runQMD(['--index', QMD_INDEX_NAME, 'ls', name])
      return true
    } catch {
      return false
    }
  }

  private async ensureEmbeddings(force = false): Promise<void> {
    const now = Date.now()
    if (!force && now - this.lastEmbedAt < QMD_EMBED_MIN_INTERVAL_MS) {
      return
    }

    if (this.embeddingRefreshPromise) {
      await this.embeddingRefreshPromise
      return
    }

    this.embeddingRefreshPromise = (async (): Promise<void> => {
      try {
        const statusOutput = await this.runQMD(['status', '--index', QMD_INDEX_NAME])
        const pendingEmbeddingCount = parsePendingEmbeddingCount(statusOutput)

        if (pendingEmbeddingCount <= 0) {
          this.lastEmbedAt = Date.now()
          return
        }

        LogHelper.title('Memory Manager')
        LogHelper.debug(
          `QMD embeddings pending: ${pendingEmbeddingCount}. Running embed refresh...`
        )

        await this.runQMD(['embed', '--index', QMD_INDEX_NAME])
        this.lastEmbedAt = Date.now()

        LogHelper.title('Memory Manager')
        LogHelper.debug('QMD embeddings refreshed')
      } catch (error) {
        this.lastEmbedAt = Date.now()
        LogHelper.title('Memory Manager')
        LogHelper.warning(`QMD embedding refresh failed: ${String(error)}`)
      } finally {
        this.embeddingRefreshPromise = null
      }
    })()

    await this.embeddingRefreshPromise
  }

  private async runQMDSearchMode(
    mode: QMDSearchMode,
    query: string,
    collectionNames: string[],
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
      ...collectionNames.flatMap((collectionName) => ['-c', collectionName])
    ]

    try {
      return await this.runQMD(baseArgs)
    } catch (error) {
      const message = String(error).toLowerCase()
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
