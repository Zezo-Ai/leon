import fs from 'node:fs'
import path from 'node:path'

import type { ChatHistoryItem, LlamaContext } from 'node-llama-cpp'
import { LlamaChatSession } from 'node-llama-cpp'

import {
  DEFAULT_INIT_PARAMS,
  LLMDuty,
  type LLMDutyInitParams,
  type LLMDutyParams,
  type LLMDutyResult
} from '@/core/llm-manager/llm-duty'
import { LogHelper } from '@/helpers/log-helper'
import { StringHelper } from '@/helpers/string-helper'
import {
  LLM_MANAGER,
  LLM_PROVIDER,
  PERSONA,
  TOOLKIT_REGISTRY,
  CONTEXT_MANAGER,
  CONVERSATION_LOGGER,
  BRAIN,
  SOCKET_SERVER
} from '@/core'
import {
  LLMDuties,
  LLMProviders,
  type LLMPromptAbortReason,
  type OpenAITool,
  type OpenAIToolCall,
  type OpenAIToolChoice
} from '@/core/llm-manager/types'
import { ContextStateStore } from '@/core/context-manager/context-state-store'
import { LLM_PROVIDER as LLM_PROVIDER_NAME, LOGS_PATH } from '@/constants'
import type { MessageLog } from '@/types'

import {
  PLAN_SYSTEM_PROMPT,
  REACT_TEMPERATURE,
  REACT_INFERENCE_TIMEOUT_MS,
  REACT_TIMEOUT_MAX_RETRIES,
  CHARS_PER_TOKEN,
  TOOL_CALL_WAIT_NOTICE_DELAY_MS,
  TOOL_CALL_DIAGNOSIS_DELAY_MS,
  TOOL_CALL_DIAGNOSIS_RETRY_DELAY_MS,
  REACT_HISTORY_COMPACTION_MAX_TOKENS,
  REACT_HISTORY_COMPACTION_RETRY_MAX_TOKENS,
  REACT_HISTORY_COMPACTION_SYSTEM_PROMPT,
  REACT_LOCAL_PROVIDER_HISTORY_LOGS,
  REACT_LOCAL_PROVIDER_HISTORY_COMPACTION_POINT,
  REACT_REMOTE_PROVIDER_HISTORY_LOGS,
  REACT_REMOTE_PROVIDER_HISTORY_COMPACTION_POINT,
  MAX_EXECUTIONS,
  MAX_REPLANS
} from './react-llm-duty/constants'
import type {
  ReactLLMDutyParams,
  ExecutionRecord,
  PlanStep,
  TrackedPlanStep,
  PlanStepStatus,
  LLMCaller,
  PromptLogSection,
  LLMCallOptions,
  FinalResponseSignal,
  ReactPhase
} from './react-llm-duty/types'
import { widgetId, emitPlanWidget } from './react-llm-duty/plan-widget'
import {
  getPhasePolicy,
  formatPhasePolicyForLog
} from './react-llm-duty/phase-policy'
import {
  buildCatalog,
  runPlanningPhase,
  runRecoveryPlanningPhase,
  runExecutionSelfObservationPhase,
  runExecutionStep,
  runFinalAnswerPhase
} from './react-llm-duty/phases'
import { buildStepLabelFromFunction } from './react-llm-duty/phase-helpers'
import {
  buildCompactedHistoryMessage,
  findMessageSequenceStart,
  formatHistoryForCompaction,
  hasHistoryCompactionContent,
  normalizeHistoryCompactionSummary,
  toChatHistoryItems
} from './react-llm-duty/history-compaction'

const REACT_CONTINUATION_STATE_FILENAME = '.react-execution-continuation-state.json'
const REACT_HISTORY_COMPACTION_STATE_FILENAME =
  '.react-history-compaction-state.json'
const REACT_CONTINUATION_MAX_AGE_MS = 30 * 60 * 1_000
const REACT_PROMPTS_LOG_DIR = path.join(LOGS_PATH, 'prompts')

type ReactHistoryCompactionScope = 'local' | 'remote'

interface ReactExecutionContinuationState {
  version: 1
  phase: 'execution'
  planWidgetId: string
  originalInput: string
  clarificationQuestion: string
  pendingSteps: PlanStep[]
  executionHistory: ExecutionRecord[]
  trackedSteps: TrackedPlanStep[]
  currentStepIndex: number
  replanCount: number
  executionCount: number
  createdAt: number
}

interface PreparedReactHistory {
  messageLogs: MessageLog[]
  localChatHistory?: ChatHistoryItem[]
}

interface ReactHistoryCompactionProviderState {
  summary: string | null
  summarySentAt: number | null
  tail: MessageLog[]
}

interface ReactHistoryCompactionState {
  version: 1
  local: ReactHistoryCompactionProviderState
  remote: ReactHistoryCompactionProviderState
}

interface ReactHistoryCompactionConfig {
  historyLimit: number
  compactionBatchSize: number
}

function createEmptyHistoryCompactionProviderState(): ReactHistoryCompactionProviderState {
  return {
    summary: null,
    summarySentAt: null,
    tail: []
  }
}

const REACT_HISTORY_COMPACTION_STATE_FALLBACK: ReactHistoryCompactionState = {
  version: 1,
  local: createEmptyHistoryCompactionProviderState(),
  remote: createEmptyHistoryCompactionProviderState()
}

export class ReActLLMDuty extends LLMDuty {
  private static instance: ReActLLMDuty
  private static context: LlamaContext = null as unknown as LlamaContext
  private static session: LlamaChatSession =
    null as unknown as LlamaChatSession
  private static readonly continuationStateStore =
    new ContextStateStore<ReactExecutionContinuationState | null>(
      REACT_CONTINUATION_STATE_FILENAME,
      null
    )
  private static readonly historyCompactionStateStore =
    new ContextStateStore<ReactHistoryCompactionState>(
      REACT_HISTORY_COMPACTION_STATE_FILENAME,
      REACT_HISTORY_COMPACTION_STATE_FALLBACK
    )
  protected systemPrompt: LLMDutyParams['systemPrompt'] = null
  protected readonly name = 'ReAct LLM Duty'
  protected input: LLMDutyParams['input'] = null
  private totalInputTokens = 0
  private totalOutputTokens = 0
  private hasStreamedTokenEmission = false
  private hasExplicitMemoryWrite = false
  private reasoningGenerationId: string | null = null
  private finalAnswerPhaseCompleted = false

  constructor(params: ReactLLMDutyParams) {
    super()

    if (!ReActLLMDuty.instance) {
      LogHelper.title(this.name)
      LogHelper.success('New instance')

      ReActLLMDuty.instance = this
    }

    this.input = params.input
    this.systemPrompt = PERSONA.getCompactDutySystemPrompt(PLAN_SYSTEM_PROMPT, {
      includePersonality: false,
      includeMood: false
    })
  }

  public async init(
    params: LLMDutyInitParams = DEFAULT_INIT_PARAMS
  ): Promise<void> {
    if (!TOOLKIT_REGISTRY.isLoaded) {
      await TOOLKIT_REGISTRY.load()
    }

    if (!CONTEXT_MANAGER.isLoaded || params.force) {
      await CONTEXT_MANAGER.load()
    }

    if (LLM_PROVIDER_NAME === LLMProviders.Local) {
      if (!ReActLLMDuty.session || params.force) {
        LogHelper.title(this.name)
        LogHelper.info('Initializing...')

        try {
          if (params.force) {
            if (ReActLLMDuty.context) {
              await ReActLLMDuty.context.dispose()
            }
            if (ReActLLMDuty.session) {
              ReActLLMDuty.session.dispose({ disposeSequence: true })
              LogHelper.info('Session disposed')
            }
          }

          ReActLLMDuty.context = await LLM_MANAGER.model.createContext()

          ReActLLMDuty.session = new LlamaChatSession({
            contextSequence: ReActLLMDuty.context.getSequence(),
            autoDisposeSequence: true,
            systemPrompt: this.systemPrompt as string
          })

          LogHelper.success('Initialized')
        } catch (e) {
          LogHelper.title(this.name)
          LogHelper.error(`Failed to initialize: ${e}`)
        }
      }
    }
  }

  public async execute(): Promise<LLMDutyResult | null> {
    LogHelper.title(this.name)
    LogHelper.info('Executing...')

    this.totalInputTokens = 0
    this.totalOutputTokens = 0
    this.hasStreamedTokenEmission = false
    this.hasExplicitMemoryWrite = false
    this.reasoningGenerationId = StringHelper.random(6, { onlyLetters: true })
    this.finalAnswerPhaseCompleted = false

    try {
      const { messageLogs: history, localChatHistory } =
        await this.loadPreparedHistory()

      if (LLM_PROVIDER_NAME === LLMProviders.Local && localChatHistory) {
        ReActLLMDuty.session.setChatHistory(localChatHistory)
      }

      const ownerInputText = this.getInputAsText(this.input)
      const continuation = this.consumeExecutionContinuation(ownerInputText)
      const effectiveInput = continuation
        ? continuation.resumedInput
        : this.input

      // --- Build adaptive catalog ---
      const catalog = buildCatalog()

      LogHelper.title(this.name)
      LogHelper.debug(`Catalog mode: ${catalog.mode} | Catalog length: ${catalog.text.length} chars (~${Math.ceil(catalog.text.length / 4)} tokens) | Input: "${this.input}"`)
      LogHelper.debug(`Native tools supported: ${this.supportsNativeTools} (provider: ${LLM_PROVIDER_NAME})`)
      if (continuation) {
        LogHelper.debug(
          `Resuming paused execution from clarification: "${continuation.state.clarificationQuestion}"`
        )
      }

      const planWidgetIdValue = continuation?.state.planWidgetId || widgetId('plan')
      let hasPlanningWidget = false
      const executionHistory: ExecutionRecord[] = []
      let replanCount = 0
      let executionCount = 0
      let pendingSteps: PlanStep[] = []
      let trackedSteps: TrackedPlanStep[] = []
      let currentStepIndex = 0
      let currentExecutingFunction: string | null = null
      const caller = this.createLLMCaller(history, effectiveInput)
      const finalizeWithPostAnswerMaintenance = async (
        finalAnswer: string
      ): Promise<LLMDutyResult> => {
        this.finalAnswerPhaseCompleted = true
        const dutyResult = this.makeDutyResult(finalAnswer)
        try {
          await this.maybeCompactHistoryAfterAnswer(
            planWidgetIdValue,
            trackedSteps
          )
        } catch (error) {
          LogHelper.title(this.name)
          LogHelper.warning(
            `Post-answer history compaction failed: ${String(error)}`
          )
        }
        return dutyResult
      }
      const finalizeFromSignal = async (
        signal: FinalResponseSignal
      ): Promise<LLMDutyResult> => {
        const finalAnswer = await runFinalAnswerPhase(
          caller,
          executionHistory,
          signal
        )
        return finalizeWithPostAnswerMaintenance(finalAnswer)
      }

      if (continuation) {
        pendingSteps = continuation.state.pendingSteps.map((step) => ({
          function: step.function,
          label: step.label
        }))
        executionHistory.push(
          ...continuation.state.executionHistory.map((item) => ({ ...item }))
        )
        replanCount = continuation.state.replanCount
        executionCount = continuation.state.executionCount
        trackedSteps = continuation.state.trackedSteps.map((step) => ({
          label: step.label,
          status: step.status
        }))

        if (trackedSteps.length === 0) {
          trackedSteps = pendingSteps.map((step, index) => ({
            label: step.label,
            status: index === 0 ? 'in_progress' : 'pending'
          }))
          currentStepIndex = 0
        } else {
          currentStepIndex = Math.min(
            Math.max(continuation.state.currentStepIndex, 0),
            Math.max(trackedSteps.length - 1, 0)
          )
          trackedSteps = this.buildPausedTrackedSteps(
            trackedSteps,
            currentStepIndex
          )
        }

        emitPlanWidget(trackedSteps, null, planWidgetIdValue, true)
        hasPlanningWidget = true
      } else {
        // --- Phase 1: Planning ---
        this.logTitle('planning')
        LogHelper.debug('Phase 1: Planning...')

        let planningUiSteps: TrackedPlanStep[] = [
          { label: 'Thinking...', status: 'in_progress' }
        ]
        emitPlanWidget(
          planningUiSteps,
          null,
          planWidgetIdValue,
          false
        )
        hasPlanningWidget = true

        const updatePlanningStage = (): void => {
          planningUiSteps = [
            { label: 'Thinking...', status: 'in_progress' }
          ]
          if (hasPlanningWidget) {
            emitPlanWidget(
              planningUiSteps,
              null,
              planWidgetIdValue,
              true
            )
          }
        }

        const planResult = await runPlanningPhase(
          caller,
          catalog,
          history,
          updatePlanningStage
        )

        if (planResult.type === 'handoff') {
          if (hasPlanningWidget) {
            emitPlanWidget(
              planningUiSteps.map((step) => ({ ...step, status: 'completed' })),
              null,
              planWidgetIdValue,
              true
            )
          }
          this.logTitle('planning')
          LogHelper.debug(
            `Planning returned handoff signal: intent="${planResult.signal.intent}"`
          )
          return await finalizeFromSignal(planResult.signal)
        }

        this.logTitle('planning')
        LogHelper.debug(
          `Plan created with ${planResult.steps.length} step(s): ${planResult.steps.map((s) => s.function).join(' -> ')}`
        )
        if (planResult.summary) {
          LogHelper.debug(`Plan summary: "${planResult.summary}"`)
        }

        pendingSteps = [...planResult.steps]

        // --- Plan widget state ---
        trackedSteps = pendingSteps.map((s) => ({
          label: s.label,
          status: 'pending' as PlanStepStatus
        }))

        // Mark first step as in_progress and emit initial widget
        if (trackedSteps.length > 0) {
          trackedSteps[0]!.status = 'in_progress'
        }

        // Emit plan summary as text, then show the widget
        if (planResult.summary) {
          await this.emitProgress(this.toProgressiveMessage(planResult.summary))
        }
        emitPlanWidget(
          trackedSteps,
          null,
          planWidgetIdValue,
          hasPlanningWidget
        )
        hasPlanningWidget = true
      }

      // --- Phase 2: Execution loop ---
      this.logTitle('execution')
      LogHelper.debug('Phase 2: Execution loop...')

      while (pendingSteps.length > 0 && executionCount < MAX_EXECUTIONS) {
        const currentStep = pendingSteps.shift()!
        executionCount += 1
        currentExecutingFunction = currentStep.function

        emitPlanWidget(
          trackedSteps,
          null,
          planWidgetIdValue,
          true,
          currentExecutingFunction
        )

        LogHelper.title(this.name)
        LogHelper.debug(
          `Execution ${executionCount}/${MAX_EXECUTIONS}: ${currentStep.function} | label="${currentStep.label}" | ${pendingSteps.length} step(s) remaining`
        )

        const stepResult = await runExecutionStep(
          caller,
          currentStep,
          executionHistory,
          catalog
        )

        if (stepResult.type === 'handoff') {
          LogHelper.title(this.name)
          LogHelper.debug(
            `Execution returned handoff signal: intent="${stepResult.signal.intent}"`
          )

          if (stepResult.signal.intent === 'clarification') {
            const pausedTrackedSteps =
              trackedSteps.length > 0
                ? this.buildPausedTrackedSteps(trackedSteps, currentStepIndex)
                : [
                    {
                      label: currentStep.label,
                      status: 'in_progress' as PlanStepStatus
                    }
                  ]
            const pendingWithCurrent: PlanStep[] = [currentStep, ...pendingSteps]

            this.saveExecutionContinuation({
              version: 1,
              phase: 'execution',
              planWidgetId: planWidgetIdValue,
              originalInput: continuation?.state.originalInput || ownerInputText,
              clarificationQuestion: stepResult.signal.draft,
              pendingSteps: pendingWithCurrent,
              executionHistory,
              trackedSteps: pausedTrackedSteps,
              currentStepIndex:
                pausedTrackedSteps.length > 0
                  ? Math.min(currentStepIndex, pausedTrackedSteps.length - 1)
                  : 0,
              replanCount,
              executionCount,
              createdAt: Date.now()
            })
            currentExecutingFunction = null
            emitPlanWidget(
              pausedTrackedSteps,
              null,
              planWidgetIdValue,
              true,
              currentExecutingFunction
            )

            LogHelper.debug(
              `Execution paused for clarification at step "${currentStep.label}"`
            )
            return await finalizeFromSignal(stepResult.signal)
          }

          // Mark all remaining steps as completed in the widget
          for (const ts of trackedSteps) {
            ts.status = 'completed'
          }
          currentExecutingFunction = null
          emitPlanWidget(
            trackedSteps,
            null,
            planWidgetIdValue,
            true,
            currentExecutingFunction
          )

          return await finalizeFromSignal(stepResult.signal)
        }

        if (stepResult.type === 'replan') {
          replanCount += 1
          LogHelper.title(this.name)
          LogHelper.debug(
            `Re-plan ${replanCount}/${MAX_REPLANS}: reason="${stepResult.reason}" | new steps: ${stepResult.functions.join(' -> ')}`
          )

          if (replanCount > MAX_REPLANS) {
            LogHelper.title(this.name)
            LogHelper.warning('Max re-plans reached, synthesizing answer')
            break
          }

          pendingSteps = stepResult.functions.map((f) => ({
            function: f,
            label: buildStepLabelFromFunction(f)
          }))

          // Rebuild tracked steps: keep completed ones, replace remaining
          const completedSteps = trackedSteps.filter(
            (s) => s.status === 'completed'
          )
          const newSteps: TrackedPlanStep[] = pendingSteps.map((s) => ({
            label: s.label,
            status: 'pending' as PlanStepStatus
          }))
          if (newSteps.length > 0) {
            newSteps[0]!.status = 'in_progress'
          }
          trackedSteps = [...completedSteps, ...newSteps]
          currentStepIndex = completedSteps.length

          currentExecutingFunction = null
          emitPlanWidget(
            trackedSteps,
            null,
            planWidgetIdValue,
            true,
            currentExecutingFunction
          )
          continue
        }

        // Record execution
        executionHistory.push(stepResult.execution)

        if (
          stepResult.execution.status === 'success' &&
          stepResult.execution.function ===
            'structured_knowledge.memory.write'
        ) {
          this.hasExplicitMemoryWrite = true
        }

        LogHelper.title(this.name)
        LogHelper.debug(
          `Execution result: ${stepResult.execution.function} [${stepResult.execution.status}]`
        )
        LogHelper.debug(`Observation: ${stepResult.execution.observation}`)

        // Update plan widget: mark current step as completed, next as in_progress
        if (currentStepIndex < trackedSteps.length) {
          trackedSteps[currentStepIndex]!.status = 'completed'
        }
        const nextTrackedIndex = currentStepIndex + 1
        if (nextTrackedIndex < trackedSteps.length) {
          trackedSteps[nextTrackedIndex]!.status = 'in_progress'
        }
        currentExecutingFunction = null
        emitPlanWidget(
          trackedSteps,
          currentStepIndex,
          planWidgetIdValue,
          true,
          currentExecutingFunction
        )
        currentStepIndex = nextTrackedIndex

        // Check for short-circuit handoff from tool result
        if (stepResult.handoffSignal) {
          LogHelper.title(this.name)
          LogHelper.debug(
            `Tool returned handoff signal: intent="${stepResult.handoffSignal.intent}"`
          )

          // Mark all remaining as completed
          for (const ts of trackedSteps) {
            ts.status = 'completed'
          }
          currentExecutingFunction = null
          emitPlanWidget(
            trackedSteps,
            null,
            planWidgetIdValue,
            true,
            currentExecutingFunction
          )

          return await finalizeFromSignal(stepResult.handoffSignal)
        }

        if (stepResult.execution.status === 'error') {
          if (replanCount >= MAX_REPLANS) {
            LogHelper.title(this.name)
            LogHelper.warning(
              'Recovery replanning skipped: max re-plans reached'
            )
            continue
          }

          const recoveryPlanResult = await runRecoveryPlanningPhase(
            caller,
            catalog,
            history,
            executionHistory,
            currentStep,
            pendingSteps
          )

          if (recoveryPlanResult?.type === 'handoff') {
            LogHelper.title(this.name)
            LogHelper.debug(
              `Recovery planning returned handoff signal: intent="${recoveryPlanResult.signal.intent}"`
            )

            if (recoveryPlanResult.signal.intent === 'clarification') {
              const retryStepIndex = Math.max(0, currentStepIndex - 1)
              const pausedTrackedSteps =
                trackedSteps.length > 0
                  ? this.buildPausedTrackedSteps(trackedSteps, retryStepIndex)
                  : [
                      {
                        label: currentStep.label,
                        status: 'in_progress' as PlanStepStatus
                      }
                    ]
              const pendingWithCurrent: PlanStep[] = [currentStep, ...pendingSteps]

              this.saveExecutionContinuation({
                version: 1,
                phase: 'execution',
                planWidgetId: planWidgetIdValue,
                originalInput:
                  continuation?.state.originalInput || ownerInputText,
                clarificationQuestion: recoveryPlanResult.signal.draft,
                pendingSteps: pendingWithCurrent,
                executionHistory,
                trackedSteps: pausedTrackedSteps,
                currentStepIndex:
                  pausedTrackedSteps.length > 0
                    ? Math.min(retryStepIndex, pausedTrackedSteps.length - 1)
                    : 0,
                replanCount,
                executionCount,
                createdAt: Date.now()
              })
              currentExecutingFunction = null
              emitPlanWidget(
                pausedTrackedSteps,
                null,
                planWidgetIdValue,
                true,
                currentExecutingFunction
              )

              LogHelper.debug(
                `Recovery execution paused for clarification at step "${currentStep.label}"`
              )
              return await finalizeFromSignal(recoveryPlanResult.signal)
            }

            return await finalizeFromSignal(recoveryPlanResult.signal)
          }

          if (
            recoveryPlanResult?.type === 'plan' &&
            recoveryPlanResult.steps.length > 0
          ) {
            replanCount += 1
            pendingSteps = [...recoveryPlanResult.steps]

            LogHelper.title(this.name)
            LogHelper.debug(
              `Recovery re-plan ${replanCount}/${MAX_REPLANS}: ${pendingSteps.map((s) => s.function).join(' -> ')}`
            )
            if (recoveryPlanResult.summary) {
              LogHelper.debug(
                `Recovery plan summary: "${recoveryPlanResult.summary}"`
              )
              await this.emitProgress(
                this.toProgressiveMessage(recoveryPlanResult.summary)
              )
            }

            const completedSteps = trackedSteps.filter(
              (s) => s.status === 'completed'
            )
            const newSteps: TrackedPlanStep[] = pendingSteps.map((s) => ({
              label: s.label,
              status: 'pending' as PlanStepStatus
            }))
            if (newSteps.length > 0) {
              newSteps[0]!.status = 'in_progress'
            }
            trackedSteps = [...completedSteps, ...newSteps]
            currentStepIndex = completedSteps.length

            currentExecutingFunction = null
            emitPlanWidget(
              trackedSteps,
              null,
              planWidgetIdValue,
              true,
              currentExecutingFunction
            )
          }
        }

        if (
          stepResult.execution.status === 'success' &&
          pendingSteps.length === 0
        ) {
          if (replanCount >= MAX_REPLANS) {
            LogHelper.title(this.name)
            LogHelper.warning(
              'Execution self-observation replanning skipped: max re-plans reached'
            )
            continue
          }

          const selfObservationResult = await runExecutionSelfObservationPhase(
            caller,
            executionHistory
          )

          if (selfObservationResult?.type === 'handoff') {
            LogHelper.title(this.name)
            LogHelper.debug(
              `Execution self-observation returned handoff signal: intent="${selfObservationResult.signal.intent}"`
            )

            return await finalizeFromSignal(selfObservationResult.signal)
          }

          if (
            selfObservationResult?.type === 'replan' &&
            selfObservationResult.functions.length > 0
          ) {
            replanCount += 1
            pendingSteps = selfObservationResult.functions.map((f) => ({
              function: f,
              label: buildStepLabelFromFunction(f)
            }))

            LogHelper.title(this.name)
            LogHelper.debug(
              `Execution self-observation re-plan ${replanCount}/${MAX_REPLANS}: ${pendingSteps.map((s) => s.function).join(' -> ')}`
            )
            if (selfObservationResult.reason) {
              LogHelper.debug(
                `Execution self-observation reason: "${selfObservationResult.reason}"`
              )
              const normalizedReason = selfObservationResult.reason
                .trim()
                .replace(/[.?!]+$/g, '')
              await this.emitProgress(
                normalizedReason ? `${normalizedReason}...` : 'Working...'
              )
            }

            const appendStartIndex = trackedSteps.length
            const appendedSteps: TrackedPlanStep[] = pendingSteps.map((s) => ({
              label: s.label,
              status: 'pending' as PlanStepStatus
            }))
            if (appendedSteps.length > 0) {
              appendedSteps[0]!.status = 'in_progress'
            }
            trackedSteps = [...trackedSteps, ...appendedSteps]
            currentStepIndex = appendStartIndex

            currentExecutingFunction = null
            emitPlanWidget(
              trackedSteps,
              null,
              planWidgetIdValue,
              true,
              currentExecutingFunction
            )
            continue
          }
        }
      }

      // --- Phase 3: Final answer synthesis ---
      this.logTitle('final_answer')
      LogHelper.debug(`Phase 3: Final answer synthesis (${executionHistory.length} execution(s) completed)`)

      // Mark all steps as completed in the widget
      for (const ts of trackedSteps) {
        ts.status = 'completed'
      }
      currentExecutingFunction = null
      emitPlanWidget(
        trackedSteps,
        null,
        planWidgetIdValue,
        true,
        currentExecutingFunction
      )

      if (executionHistory.length === 0) {
        LogHelper.debug('No executions completed, handing off to final phase')
        const providerError = LLM_PROVIDER.consumeLastProviderErrorMessage()
        const noExecutionSignal: FinalResponseSignal = providerError
          ? {
              intent: 'error',
              draft: providerError,
              source: 'system'
            }
          : {
              intent: 'error',
              draft: 'I was unable to find the right tools to help with your request.',
              source: 'system'
            }
        return await finalizeFromSignal(noExecutionSignal)
      }

      const finalAnswer = await runFinalAnswerPhase(caller, executionHistory)
      return await finalizeWithPostAnswerMaintenance(finalAnswer)
    } catch (e) {
      LogHelper.title(this.name)
      LogHelper.error(`Failed to execute: ${e}`)
    }

    return null
  }

  private async loadPreparedHistory(): Promise<PreparedReactHistory> {
    const historyConfig = this.getHistoryCompactionConfig()
    const historyScope = this.getHistoryCompactionScope()
    const conversationLogs = await CONVERSATION_LOGGER.loadAll()
    const currentState = this.loadHistoryCompactionProviderState(historyScope)
    const synchronizedState = this.synchronizeHistoryCompactionState(
      conversationLogs,
      currentState
    )

    if (synchronizedState.shouldPersist) {
      this.saveHistoryCompactionProviderState(historyScope, synchronizedState.state)
    }

    return this.buildPreparedHistory(
      this.buildHistoryForCurrentTurn(
        conversationLogs,
        synchronizedState.state,
        historyConfig
      )
    )
  }

  private getHistoryCompactionScope(): ReactHistoryCompactionScope {
    return LLM_PROVIDER_NAME === LLMProviders.Local ? 'local' : 'remote'
  }

  private getHistoryCompactionConfig(): ReactHistoryCompactionConfig {
    if (LLM_PROVIDER_NAME === LLMProviders.Local) {
      return {
        historyLimit: REACT_LOCAL_PROVIDER_HISTORY_LOGS,
        compactionBatchSize: REACT_LOCAL_PROVIDER_HISTORY_COMPACTION_POINT
      }
    }

    return {
      historyLimit: REACT_REMOTE_PROVIDER_HISTORY_LOGS,
      compactionBatchSize: REACT_REMOTE_PROVIDER_HISTORY_COMPACTION_POINT
    }
  }

  private loadHistoryCompactionProviderState(
    scope: ReactHistoryCompactionScope
  ): ReactHistoryCompactionProviderState {
    const persistedState = ReActLLMDuty.historyCompactionStateStore.load()
    return this.normalizeHistoryCompactionProviderState(persistedState?.[scope])
  }

  private normalizeHistoryCompactionProviderState(
    value: unknown
  ): ReactHistoryCompactionProviderState {
    const record =
      value && typeof value === 'object'
        ? (value as Record<string, unknown>)
        : null

    return {
      summary: normalizeHistoryCompactionSummary(record?.['summary']),
      summarySentAt:
        typeof record?.['summarySentAt'] === 'number'
          ? record['summarySentAt']
          : null,
      tail: this.normalizeMessageLogs(record?.['tail'])
    }
  }

  private saveHistoryCompactionProviderState(
    scope: ReactHistoryCompactionScope,
    providerState: ReactHistoryCompactionProviderState
  ): void {
    const persistedState = ReActLLMDuty.historyCompactionStateStore.load()
    const nextState: ReactHistoryCompactionState = {
      version: 1,
      local:
        scope === 'local'
          ? providerState
          : this.normalizeHistoryCompactionProviderState(persistedState?.local),
      remote:
        scope === 'remote'
          ? providerState
          : this.normalizeHistoryCompactionProviderState(persistedState?.remote)
    }

    ReActLLMDuty.historyCompactionStateStore.save(nextState)
  }

  private normalizeMessageLogs(value: unknown): MessageLog[] {
    if (!Array.isArray(value)) {
      return []
    }

    return value.flatMap((item) => {
      const record =
        item && typeof item === 'object'
          ? (item as Record<string, unknown>)
          : null

      if (
        !record ||
        (record['who'] !== 'owner' && record['who'] !== 'leon') ||
        typeof record['sentAt'] !== 'number' ||
        typeof record['message'] !== 'string'
      ) {
        return []
      }

      return [
        {
          who: record['who'],
          sentAt: record['sentAt'],
          message: record['message']
        }
      ]
    })
  }

  private hasStoredHistoryCompactionState(
    state: ReactHistoryCompactionProviderState
  ): boolean {
    return Boolean(
      hasHistoryCompactionContent(state.summary) ||
        state.summarySentAt !== null ||
        state.tail.length > 0
    )
  }

  private areMessageLogsEqual(left: MessageLog[], right: MessageLog[]): boolean {
    if (left.length !== right.length) {
      return false
    }

    return left.every((message, index) => {
      const otherMessage = right[index]

      return (
        otherMessage &&
        message.who === otherMessage.who &&
        message.sentAt === otherMessage.sentAt &&
        message.message === otherMessage.message
      )
    })
  }

  private areHistoryCompactionStatesEqual(
    left: ReactHistoryCompactionProviderState,
    right: ReactHistoryCompactionProviderState
  ): boolean {
    return (
      left.summary === right.summary &&
      left.summarySentAt === right.summarySentAt &&
      this.areMessageLogsEqual(left.tail, right.tail)
    )
  }

  private synchronizeHistoryCompactionState(
    conversationLogs: MessageLog[],
    currentState: ReactHistoryCompactionProviderState
  ): {
    state: ReactHistoryCompactionProviderState
    shouldPersist: boolean
  } {
    const emptyState = createEmptyHistoryCompactionProviderState()

    if (!hasHistoryCompactionContent(currentState.summary)) {
      return {
        state: emptyState,
        shouldPersist:
          this.hasStoredHistoryCompactionState(currentState) &&
          !this.areHistoryCompactionStatesEqual(currentState, emptyState)
      }
    }

    if (currentState.tail.length === 0) {
      return {
        state: emptyState,
        shouldPersist: true
      }
    }

    const tailStartIndex = findMessageSequenceStart(conversationLogs, currentState.tail)
    if (tailStartIndex === -1) {
      LogHelper.title(this.name)
      LogHelper.debug('History compaction state reset; rebuilding from raw logs')

      return {
        state: emptyState,
        shouldPersist: true
      }
    }

    const synchronizedState: ReactHistoryCompactionProviderState = {
      summary: currentState.summary,
      summarySentAt: currentState.summarySentAt,
      tail: conversationLogs.slice(tailStartIndex)
    }

    return {
      state: synchronizedState,
      shouldPersist: !this.areHistoryCompactionStatesEqual(
        currentState,
        synchronizedState
      )
    }
  }

  private buildHistoryForCurrentTurn(
    conversationLogs: MessageLog[],
    state: ReactHistoryCompactionProviderState,
    config: ReactHistoryCompactionConfig
  ): MessageLog[] {
    if (
      hasHistoryCompactionContent(state.summary) &&
      state.tail.length > 0 &&
      state.tail.length < config.historyLimit
    ) {
      return this.buildHistoryFromCompactionState(state)
    }

    return conversationLogs.slice(-config.historyLimit)
  }

  private getStateForPostAnswerCompaction(
    conversationLogs: MessageLog[],
    synchronizedState: ReactHistoryCompactionProviderState
  ): ReactHistoryCompactionProviderState {
    if (hasHistoryCompactionContent(synchronizedState.summary)) {
      return synchronizedState
    }

    return {
      summary: null,
      summarySentAt: null,
      tail: [...conversationLogs]
    }
  }

  private async rollHistoryCompactionState(
    state: ReactHistoryCompactionProviderState,
    config: ReactHistoryCompactionConfig
  ): Promise<ReactHistoryCompactionProviderState | null> {
    let nextSummary = state.summary
    let nextSummarySentAt = state.summarySentAt
    let nextTail = [...state.tail]
    let compactedBatches = 0
    let compactedMessages = 0

    while (nextTail.length >= config.historyLimit) {
      const batch = nextTail.slice(0, config.compactionBatchSize)

      LogHelper.title(this.name)
      LogHelper.debug(
        `History compaction triggering: batch=${batch.length} tail=${nextTail.length} threshold=${config.historyLimit}`
      )

      const compactedSummary = await this.compactHistoryLogs(batch, nextSummary)

      if (!compactedSummary || !hasHistoryCompactionContent(compactedSummary)) {
        return null
      }

      nextSummary = compactedSummary
      nextSummarySentAt =
        batch[batch.length - 1]?.sentAt ?? nextSummarySentAt ?? Date.now()
      nextTail = nextTail.slice(config.compactionBatchSize)
      compactedBatches += 1
      compactedMessages += batch.length
    }

    if (compactedBatches > 0) {
      LogHelper.title(this.name)
      LogHelper.debug(
        `History compaction advanced: batches=${compactedBatches} absorbed=${compactedMessages} remaining=${nextTail.length}`
      )
    }

    return {
      summary: nextSummary,
      summarySentAt: nextSummarySentAt,
      tail: nextTail
    }
  }

  private async maybeCompactHistoryAfterAnswer(
    planWidgetId: string,
    trackedSteps: TrackedPlanStep[]
  ): Promise<void> {
    const historyConfig = this.getHistoryCompactionConfig()
    const historyScope = this.getHistoryCompactionScope()
    const conversationLogs = await CONVERSATION_LOGGER.loadAll()
    const currentState = this.loadHistoryCompactionProviderState(historyScope)
    const synchronizedState = this.synchronizeHistoryCompactionState(
      conversationLogs,
      currentState
    )

    if (synchronizedState.shouldPersist) {
      this.saveHistoryCompactionProviderState(historyScope, synchronizedState.state)
    }

    const stateToCompact = this.getStateForPostAnswerCompaction(
      conversationLogs,
      synchronizedState.state
    )

    if (stateToCompact.tail.length < historyConfig.historyLimit) {
      return
    }

    const compactionWidgetSteps = [
      ...trackedSteps.map((step) => ({ ...step })),
      {
        label: 'Compacting history...',
        status: 'in_progress' as PlanStepStatus
      }
    ]

    emitPlanWidget(compactionWidgetSteps, null, planWidgetId, true, null)

    const compactedState = await this.rollHistoryCompactionState(
      stateToCompact,
      historyConfig
    )

    if (!compactedState) {
      emitPlanWidget(trackedSteps, null, planWidgetId, true, null)
      return
    }

    this.saveHistoryCompactionProviderState(historyScope, compactedState)
    compactionWidgetSteps[compactionWidgetSteps.length - 1]!.status = 'completed'
    emitPlanWidget(compactionWidgetSteps, null, planWidgetId, true, null)
  }

  private buildHistoryFromCompactionState(
    state: ReactHistoryCompactionProviderState
  ): MessageLog[] {
    if (!state.summary || !hasHistoryCompactionContent(state.summary)) {
      return [...state.tail]
    }

    const summaryMessage: MessageLog = {
      who: 'leon',
      sentAt: state.summarySentAt ?? state.tail[0]?.sentAt ?? Date.now(),
      message: buildCompactedHistoryMessage(state.summary)
    }

    return [summaryMessage, ...state.tail]
  }

  private buildPreparedHistory(history: MessageLog[]): PreparedReactHistory {
    if (LLM_PROVIDER_NAME !== LLMProviders.Local) {
      return {
        messageLogs: history
      }
    }

    const [existingSystemMessage] = ReActLLMDuty.session.getChatHistory()
    const systemMessage: ChatHistoryItem = existingSystemMessage || {
      type: 'system',
      text: this.systemPrompt as string
    }

    return {
      messageLogs: history,
      localChatHistory: [systemMessage, ...toChatHistoryItems(history)]
    }
  }

  private async compactHistoryLogs(
    logsToCompact: MessageLog[],
    previousSummary: string | null
  ): Promise<string | null> {
    if (logsToCompact.length === 0) {
      return null
    }

    const prompt = formatHistoryForCompaction(previousSummary, logsToCompact)
    const baseCompletionParams = {
      dutyType: LLMDuties.ReAct,
      systemPrompt: REACT_HISTORY_COMPACTION_SYSTEM_PROMPT,
      temperature: 0,
      thoughtTokensBudget: 0,
      disableThinking: true,
      trackProviderErrors: false
    }

    const maxTokenBudgets = [
      REACT_HISTORY_COMPACTION_MAX_TOKENS,
      REACT_HISTORY_COMPACTION_RETRY_MAX_TOKENS
    ]

    for (const maxTokens of maxTokenBudgets) {
      try {
        let result = null

        if (LLM_PROVIDER_NAME === LLMProviders.Local) {
          const tempContext = await LLM_MANAGER.model.createContext()
          const tempSession = new LlamaChatSession({
            contextSequence: tempContext.getSequence(),
            autoDisposeSequence: true,
            systemPrompt: REACT_HISTORY_COMPACTION_SYSTEM_PROMPT
          })

          try {
            result = await LLM_PROVIDER.prompt(prompt, {
              ...baseCompletionParams,
              session: tempSession,
              maxTokens: Math.min(maxTokens, tempContext.contextSize)
            })
          } finally {
            tempSession.dispose({ disposeSequence: true })
            await tempContext.dispose()
          }
        } else {
          result = await LLM_PROVIDER.prompt(prompt, {
            ...baseCompletionParams,
            maxTokens
          })
        }

        const normalized = normalizeHistoryCompactionSummary(result?.output)
        if (normalized && hasHistoryCompactionContent(normalized)) {
          return normalized
        }

        if (maxTokens !== maxTokenBudgets[maxTokenBudgets.length - 1]) {
          LogHelper.title(this.name)
          LogHelper.warning(
            `History compaction returned invalid structured output; retrying with maxTokens=${REACT_HISTORY_COMPACTION_RETRY_MAX_TOKENS}`
          )
        }
      } catch (error) {
        if (maxTokens === maxTokenBudgets[maxTokenBudgets.length - 1]) {
          LogHelper.title(this.name)
          LogHelper.warning(
            `History compaction failed; using raw history instead: ${String(error)}`
          )
          return null
        }

        LogHelper.title(this.name)
        LogHelper.warning(
          `History compaction attempt failed; retrying with maxTokens=${REACT_HISTORY_COMPACTION_RETRY_MAX_TOKENS}: ${String(error)}`
        )
      }
    }

    return null
  }

  private getInputAsText(input: string | object | null): string {
    if (typeof input === 'string') {
      return input
    }

    if (input === null || input === undefined) {
      return ''
    }

    return this.safeJSONStringify(input)
  }

  private loadExecutionContinuation(): ReactExecutionContinuationState | null {
    const state = ReActLLMDuty.continuationStateStore.load()
    if (!state) {
      return null
    }

    const isExpired =
      !state.createdAt || Date.now() - state.createdAt > REACT_CONTINUATION_MAX_AGE_MS
    if (isExpired) {
      this.clearExecutionContinuation()
      return null
    }

    if (state.phase !== 'execution' || !Array.isArray(state.pendingSteps)) {
      this.clearExecutionContinuation()
      return null
    }

    return state
  }

  private saveExecutionContinuation(state: ReactExecutionContinuationState): void {
    ReActLLMDuty.continuationStateStore.save(state)
  }

  private clearExecutionContinuation(): void {
    ReActLLMDuty.continuationStateStore.save(null)
  }

  private consumeExecutionContinuation(
    ownerReply: string
  ): { state: ReactExecutionContinuationState, resumedInput: string } | null {
    const state = this.loadExecutionContinuation()
    if (!state) {
      return null
    }

    this.clearExecutionContinuation()

    const resumedInput = `${state.originalInput}\n\nPrevious clarification request: "${state.clarificationQuestion}"\nClarification reply: "${ownerReply}"`

    return { state, resumedInput }
  }

  private buildPausedTrackedSteps(
    trackedSteps: TrackedPlanStep[],
    inProgressIndex: number
  ): TrackedPlanStep[] {
    if (trackedSteps.length === 0) {
      return []
    }

    const normalizedIndex = Math.min(
      Math.max(inProgressIndex, 0),
      trackedSteps.length - 1
    )

    return trackedSteps.map((step, index) => {
      if (index < normalizedIndex) {
        return { ...step, status: 'completed' as PlanStepStatus }
      }
      if (index === normalizedIndex) {
        return { ...step, status: 'in_progress' as PlanStepStatus }
      }

      return { ...step, status: 'pending' as PlanStepStatus }
    })
  }

  // ---------------------------------------------------------------------------
  // LLM calling helpers
  // ---------------------------------------------------------------------------

  /**
   * Whether the current LLM provider supports native OpenAI-style tool calling.
   * All remote providers support the OpenAI-compatible tools API.
   * The local provider (node-llama-cpp) uses a different function calling
   * mechanism and stays on grammar-based JSON mode.
   */
  private get supportsNativeTools(): boolean {
    return LLM_PROVIDER_NAME !== LLMProviders.Local
  }

  /**
   * Creates an LLMCaller interface that phase functions use to call the LLM
   * without needing a direct reference to this class instance.
   */
  private createLLMCaller(
    history: MessageLog[],
    inputOverride?: string | object | null
  ): LLMCaller {
    return {
      callLLM: this.callLLM.bind(this),
      callLLMText: this.callLLMText.bind(this),
      callLLMWithTools: this.callLLMWithTools.bind(this),
      supportsNativeTools: this.supportsNativeTools,
      input: inputOverride ?? this.input,
      history,
      getContextFileContent: CONTEXT_MANAGER.getContextFileContent.bind(
        CONTEXT_MANAGER
      ),
      consumeProviderErrorMessage:
        LLM_PROVIDER.consumeLastProviderErrorMessage.bind(LLM_PROVIDER)
    }
  }

  private async callLLM(
    prompt: string,
    systemPrompt: string,
    schema: Record<string, unknown>,
    history?: MessageLog[],
    promptSections?: PromptLogSection[],
    options?: LLMCallOptions
  ): Promise<{
    output: unknown
    usedInputTokens?: number
    usedOutputTokens?: number
    reasoning?: string
  } | null> {
    const phase = options?.phase ?? 'execution'
    const phasePolicy = getPhasePolicy(phase)
    const reasoningMode =
      options?.disableThinking === true
        ? 'off'
        : (options?.reasoningMode ?? phasePolicy.reasoningMode)
    const thoughtTokensBudget =
      options?.thoughtTokensBudget ?? phasePolicy.thoughtTokensBudget
    const disableThinking = reasoningMode === 'off'
    const shouldEmitReasoning =
      options?.emitReasoning ?? phasePolicy.emitReasoning
    const shouldStream =
      (options?.streamToProvider ?? phasePolicy.streamToProvider) &&
      LLM_PROVIDER_NAME !== LLMProviders.Local
    const reasoningGenerationId = shouldEmitReasoning
      ? this.reasoningGenerationId || StringHelper.random(6, { onlyLetters: true })
      : null

    this.logPromptDispatch({
      phase,
      channel: 'json',
      prompt,
      systemPrompt,
      phasePolicySummary: formatPhasePolicyForLog(phase, phasePolicy),
      shouldStream,
      schema,
      ...(promptSections ? { promptSections } : {}),
      ...(history ? { history } : {})
    })

    const completionParams = {
      dutyType: LLMDuties.ReAct,
      systemPrompt,
      data: schema,
      temperature: REACT_TEMPERATURE,
      timeout: REACT_INFERENCE_TIMEOUT_MS,
      maxRetries: REACT_TIMEOUT_MAX_RETRIES,
      shouldStream,
      ...(shouldEmitReasoning && reasoningGenerationId
        ? {
            onReasoningToken: (reasoningChunk: string): void => {
              this.emitReasoningToken(reasoningChunk, reasoningGenerationId)
            }
          }
        : {}),
      reasoningMode,
      ...(typeof thoughtTokensBudget === 'number'
        ? { thoughtTokensBudget }
        : {}),
      ...(disableThinking ? { disableThinking: true } : {}),
      ...(history ? { history } : {})
    }

    let result
    if (LLM_PROVIDER_NAME === LLMProviders.Local) {
      result = await LLM_PROVIDER.prompt(prompt, {
        ...completionParams,
        session: ReActLLMDuty.session
      })
    } else {
      result = await LLM_PROVIDER.prompt(prompt, completionParams)
    }

    if (result) {
      this.totalInputTokens += result.usedInputTokens ?? 0
      this.totalOutputTokens += result.usedOutputTokens ?? 0
      this.logPromptUsage(
        phase,
        'json',
        result.usedInputTokens ?? 0,
        result.usedOutputTokens ?? 0
      )
      this.logPromptReasoning(phase, 'json', result.reasoning)
    }

    return result
  }

  private async callLLMText(
    prompt: string,
    systemPrompt: string,
    history?: MessageLog[],
    shouldStream?: boolean,
    promptSections?: PromptLogSection[],
    options?: LLMCallOptions
  ): Promise<{
    output: string
    usedInputTokens?: number
    usedOutputTokens?: number
    reasoning?: string
  } | null> {
    const phase = options?.phase ?? 'execution'
    const phasePolicy = getPhasePolicy(phase)
    const reasoningMode =
      options?.disableThinking === true
        ? 'off'
        : (options?.reasoningMode ?? phasePolicy.reasoningMode)
    const thoughtTokensBudget =
      options?.thoughtTokensBudget ?? phasePolicy.thoughtTokensBudget
    const disableThinking = reasoningMode === 'off'
    const shouldEmitReasoning =
      options?.emitReasoning ?? phasePolicy.emitReasoning
    const shouldStreamToUser =
      options?.streamToUser ?? shouldStream ?? phasePolicy.streamToUser
    const shouldStreamEffective =
      (options?.streamToProvider ?? phasePolicy.streamToProvider) &&
      LLM_PROVIDER_NAME !== LLMProviders.Local
    const reasoningGenerationId = shouldEmitReasoning
      ? this.reasoningGenerationId || StringHelper.random(6, { onlyLetters: true })
      : null

    this.logPromptDispatch({
      phase,
      channel: 'text',
      prompt,
      systemPrompt,
      phasePolicySummary: formatPhasePolicyForLog(phase, phasePolicy),
      shouldStream: shouldStreamEffective,
      ...(promptSections ? { promptSections } : {}),
      ...(history ? { history } : {})
    })

    const generationId = shouldStreamToUser
      ? StringHelper.random(6, { onlyLetters: true })
      : null

    const completionParams = {
      dutyType: LLMDuties.ReAct,
      systemPrompt,
      temperature: REACT_TEMPERATURE,
      timeout: REACT_INFERENCE_TIMEOUT_MS,
      maxRetries: REACT_TIMEOUT_MAX_RETRIES,
      shouldStream: shouldStreamEffective,
      ...(shouldEmitReasoning && reasoningGenerationId
        ? {
            onReasoningToken: (reasoningChunk: string): void => {
              this.emitReasoningToken(reasoningChunk, reasoningGenerationId)
            }
          }
        : {}),
      reasoningMode,
      ...(typeof thoughtTokensBudget === 'number'
        ? { thoughtTokensBudget }
        : {}),
      ...(disableThinking ? { disableThinking: true } : {}),
      ...(shouldStreamToUser
        ? {
            onToken: (chunk: unknown): void => {
              const token = StringHelper.normalizeUserFacingText(
                typeof chunk === 'string'
                  ? chunk
                  : LLM_PROVIDER.cleanUpResult(
                      LLM_MANAGER.model.detokenize(
                        chunk as Parameters<
                          typeof LLM_MANAGER.model.detokenize
                        >[0]
                      )
                    )
              )

              if (!token || !generationId) {
                return
              }

              this.hasStreamedTokenEmission = true
              SOCKET_SERVER.socket?.emit('llm-token', {
                token,
                generationId
              })
            }
          }
        : {}),
      ...(history ? { history } : {})
    }

    let result
    if (LLM_PROVIDER_NAME === LLMProviders.Local) {
      result = await LLM_PROVIDER.prompt(prompt, {
        ...completionParams,
        session: ReActLLMDuty.session
      })
    } else {
      result = await LLM_PROVIDER.prompt(prompt, completionParams)
    }

    if (!result) {
      return null
    }

    this.totalInputTokens += result.usedInputTokens ?? 0
    this.totalOutputTokens += result.usedOutputTokens ?? 0
    this.logPromptUsage(
      phase,
      'text',
      result.usedInputTokens ?? 0,
      result.usedOutputTokens ?? 0
    )
    this.logPromptReasoning(phase, 'text', result.reasoning)

    return {
      output:
        typeof result.output === 'string'
          ? result.output
          : this.safeJSONStringify(result.output),
      usedInputTokens: result.usedInputTokens,
      usedOutputTokens: result.usedOutputTokens,
      ...(result.reasoning ? { reasoning: result.reasoning } : {})
    }
  }

  /**
   * Calls the LLM using native tool calling (OpenAI-compatible `tools` API).
   * Returns parsed tool call if successful, or null if the model responded
   * with text content instead.
   */
  private async callLLMWithTools(
    prompt: string,
    systemPrompt: string,
    tools: OpenAITool[],
    toolChoice: OpenAIToolChoice,
    history?: MessageLog[],
    shouldStreamToUser?: boolean,
    promptSections?: PromptLogSection[],
    options?: LLMCallOptions
  ): Promise<{
    toolCall?: { functionName: string, arguments: string }
    unexpectedToolCall?: { functionName: string, arguments: string }
    textContent?: string
    usedInputTokens?: number
    usedOutputTokens?: number
    reasoning?: string
  } | null> {
    const phase = options?.phase ?? 'execution'
    const phasePolicy = getPhasePolicy(phase)
    // Keep tool_choice explicit at call sites. This avoids hidden behavior and
    // lets phases decide when forcing a tool is worth disabling thinking.
    const effectiveToolChoice: OpenAIToolChoice | undefined =
      tools.length === 0 ? undefined : toolChoice
    const reasoningMode =
      options?.disableThinking === true
        ? 'off'
        : (options?.reasoningMode ?? phasePolicy.reasoningMode)
    const thoughtTokensBudget =
      options?.thoughtTokensBudget ?? phasePolicy.thoughtTokensBudget
    const disableThinking = reasoningMode === 'off'
    const shouldEmitReasoning =
      options?.emitReasoning ?? phasePolicy.emitReasoning
    const shouldStreamToUserEffective =
      options?.streamToUser ?? shouldStreamToUser ?? phasePolicy.streamToUser
    const shouldStreamEffective =
      (options?.streamToProvider ?? phasePolicy.streamToProvider) &&
      LLM_PROVIDER_NAME !== LLMProviders.Local

    const toolNames = tools.map((t) => t.function.name).join(', ')
    const choiceLabel =
      effectiveToolChoice === undefined
        ? 'omitted'
        : effectiveToolChoice
    const generationId = shouldStreamToUserEffective
      ? StringHelper.random(6, { onlyLetters: true })
      : null
    const reasoningGenerationId = shouldEmitReasoning
      ? this.reasoningGenerationId || generationId || StringHelper.random(6, {
          onlyLetters: true
        })
      : null

    this.logTitle(phase)
    LogHelper.debug(
      `callLLMWithTools: tools=[${toolNames}] | choice=${choiceLabel}`
    )
    this.logPromptDispatch({
      phase,
      channel: 'tools',
      prompt,
      systemPrompt,
      tools,
      ...(effectiveToolChoice !== undefined
        ? { toolChoice: effectiveToolChoice }
        : {}),
      phasePolicySummary: formatPhasePolicyForLog(phase, phasePolicy),
      shouldStream: shouldStreamEffective,
      ...(promptSections ? { promptSections } : {}),
      ...(history ? { history } : {})
    })

    let completionResult: Awaited<ReturnType<typeof LLM_PROVIDER.prompt>>
    let completed = false
    let waitNoticeTimer: NodeJS.Timeout | null = null
    let diagnosisTimer: NodeJS.Timeout | null = null
    let diagnosisRetryTimer: NodeJS.Timeout | null = null
    const toolCallAbortController = new AbortController()

    const delayReason = this.buildLongToolCallReason(
      prompt,
      systemPrompt,
      tools,
      history
    )

    waitNoticeTimer = setTimeout(() => {
      if (completed) {
        return
      }
      this.logTitle(phase)
      LogHelper.warning(
        `callLLMWithTools: pending > ${TOOL_CALL_WAIT_NOTICE_DELAY_MS}ms`
      )
      void this.emitProgress(
        BRAIN.wernicke('react.tool_call.waiting', '', {
          '{{ reason }}': delayReason
        })
      )
    }, TOOL_CALL_WAIT_NOTICE_DELAY_MS)

    diagnosisTimer = setTimeout(() => {
      if (completed) {
        return
      }

      void this.runLongToolCallDiagnosis(
        prompt,
        systemPrompt,
        tools,
        toolChoice,
        history
      )

      diagnosisRetryTimer = setTimeout(() => {
        if (completed || toolCallAbortController.signal.aborted) {
          return
        }

        const abortReason: LLMPromptAbortReason = {
          shouldRetry: true,
          retryStrategy: 'timeout',
          source: 'react_tool_call_diagnosis',
          delayMs: TOOL_CALL_DIAGNOSIS_RETRY_DELAY_MS
        }

        this.logTitle(phase)
        LogHelper.warning(
          `callLLMWithTools: diagnosis grace period exceeded (${TOOL_CALL_DIAGNOSIS_RETRY_DELAY_MS}ms); canceling in-flight request and retrying`
        )

        toolCallAbortController.abort(abortReason)
      }, TOOL_CALL_DIAGNOSIS_RETRY_DELAY_MS)
    }, TOOL_CALL_DIAGNOSIS_DELAY_MS)

    try {
      completionResult = await LLM_PROVIDER.prompt(prompt, {
        dutyType: LLMDuties.ReAct,
        systemPrompt,
        temperature: REACT_TEMPERATURE,
        timeout: REACT_INFERENCE_TIMEOUT_MS,
        maxRetries: REACT_TIMEOUT_MAX_RETRIES,
        shouldStream: shouldStreamEffective,
        ...(shouldEmitReasoning && reasoningGenerationId
          ? {
              onReasoningToken: (reasoningChunk: string): void => {
                this.emitReasoningToken(reasoningChunk, reasoningGenerationId)
              }
            }
          : {}),
        reasoningMode,
        ...(typeof thoughtTokensBudget === 'number'
          ? { thoughtTokensBudget }
          : {}),
        ...(disableThinking ? { disableThinking: true } : {}),
        ...(shouldStreamToUserEffective
          ? {
              onToken: (chunk: unknown): void => {
                const token = StringHelper.normalizeUserFacingText(
                  typeof chunk === 'string'
                    ? chunk
                    : LLM_PROVIDER.cleanUpResult(
                        LLM_MANAGER.model.detokenize(
                          chunk as Parameters<
                            typeof LLM_MANAGER.model.detokenize
                          >[0]
                        )
                      )
                )

                if (!token || !generationId) {
                  return
                }

                this.hasStreamedTokenEmission = true
                SOCKET_SERVER.socket?.emit('llm-token', {
                  token,
                  generationId
                })
              }
            }
          : {}),
        tools,
        ...(effectiveToolChoice !== undefined
          ? { toolChoice: effectiveToolChoice }
          : {}),
        signal: toolCallAbortController.signal,
        ...(history ? { history } : {})
      })
    } finally {
      completed = true
      if (waitNoticeTimer) {
        clearTimeout(waitNoticeTimer)
      }
      if (diagnosisTimer) {
        clearTimeout(diagnosisTimer)
      }
      if (diagnosisRetryTimer) {
        clearTimeout(diagnosisRetryTimer)
      }
    }

    if (!completionResult) {
      LogHelper.debug('callLLMWithTools: no completion result returned')
      return null
    }

    this.totalInputTokens += completionResult.usedInputTokens ?? 0
    this.totalOutputTokens += completionResult.usedOutputTokens ?? 0
    this.logPromptUsage(
      phase,
      'tools',
      completionResult.usedInputTokens ?? 0,
      completionResult.usedOutputTokens ?? 0
    )
    this.logPromptReasoning(phase, 'tools', completionResult.reasoning)

    // Check if the model responded with tool calls
    const toolCalls = (
      completionResult as unknown as { toolCalls?: OpenAIToolCall[] }
    ).toolCalls
    if (toolCalls && toolCalls.length > 0) {
      const firstCall = toolCalls[0]!
      const allowedToolNames = new Set(tools.map((t) => t.function.name))
      const resolvedToolName = this.resolveAllowedToolCallName(
        firstCall.function.name,
        allowedToolNames
      )
      if (!resolvedToolName) {
        this.logTitle(phase)
        LogHelper.warning(
          `callLLMWithTools: unexpected tool call "${firstCall.function.name}" (allowed: ${[...allowedToolNames].join(', ') || 'none'})`
        )

        const textContentFallback =
          typeof completionResult.output === 'string'
            ? completionResult.output
            : ''
        return {
          unexpectedToolCall: {
            functionName: firstCall.function.name,
            arguments: firstCall.function.arguments
          },
          textContent: textContentFallback,
          usedInputTokens: completionResult.usedInputTokens,
          usedOutputTokens: completionResult.usedOutputTokens,
          ...(completionResult.reasoning
            ? { reasoning: completionResult.reasoning }
            : {})
        }
      }
      if (resolvedToolName !== firstCall.function.name) {
        this.logTitle(phase)
        LogHelper.debug(
          `callLLMWithTools: normalized tool call "${firstCall.function.name}" -> "${resolvedToolName}"`
        )
      }
      this.logTitle(phase)
      LogHelper.debug(
        `callLLMWithTools: tool call received — ${resolvedToolName}(${firstCall.function.arguments})`
      )
      return {
        toolCall: {
          functionName: resolvedToolName,
          arguments: firstCall.function.arguments
        },
        usedInputTokens: completionResult.usedInputTokens,
        usedOutputTokens: completionResult.usedOutputTokens,
        ...(completionResult.reasoning
          ? { reasoning: completionResult.reasoning }
          : {})
      }
    }

    // Model responded with text content (no tool call)
    const textContent =
      typeof completionResult.output === 'string'
        ? completionResult.output
        : ''
    this.logTitle(phase)
    LogHelper.debug(
      `callLLMWithTools: no tool call, text response: "${textContent}"`
    )
    return {
      textContent,
      usedInputTokens: completionResult.usedInputTokens,
      usedOutputTokens: completionResult.usedOutputTokens,
      ...(completionResult.reasoning
        ? { reasoning: completionResult.reasoning }
        : {})
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private safeJSONStringify(value: unknown): string {
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }

  private resolveAllowedToolCallName(
    requestedName: string,
    allowedToolNames: Set<string>
  ): string | null {
    const normalizedRequested = String(requestedName || '').trim()
    if (!normalizedRequested) {
      return null
    }

    if (allowedToolNames.has(normalizedRequested)) {
      return normalizedRequested
    }

    const allowList = [...allowedToolNames]
    const lowerMatches = allowList.filter(
      (toolName) => toolName.toLowerCase() === normalizedRequested.toLowerCase()
    )
    if (lowerMatches.length === 1) {
      return lowerMatches[0] || null
    }

    const tailCandidate = normalizedRequested
      .split(/[./:]/)
      .filter(Boolean)
      .pop()
    if (!tailCandidate) {
      return null
    }

    if (allowedToolNames.has(tailCandidate)) {
      return tailCandidate
    }

    const lowerTailMatches = allowList.filter(
      (toolName) => toolName.toLowerCase() === tailCandidate.toLowerCase()
    )
    if (lowerTailMatches.length === 1) {
      return lowerTailMatches[0] || null
    }

    return null
  }

  private estimateTokensFromText(text: string): number {
    if (!text) {
      return 0
    }

    return Math.ceil(text.length / CHARS_PER_TOKEN)
  }

  private estimateHistoryTokens(history?: MessageLog[]): number {
    if (!history || history.length === 0) {
      return 0
    }

    const historyChars = history.reduce((total, log) => {
      return total + (log?.message?.length || 0)
    }, 0)

    return Math.ceil(historyChars / CHARS_PER_TOKEN)
  }

  private buildLogTitle(context?: string): string {
    return context ? `${this.name} / ${context}` : this.name
  }

  private logTitle(context?: string): void {
    LogHelper.title(this.buildLogTitle(context))
  }

  private writePhasePromptLog(params: {
    phase: ReactPhase
    channel: 'json' | 'text' | 'tools'
    sections: PromptLogSection[]
    phasePolicySummary?: string
    shouldStream?: boolean
    tools?: OpenAITool[]
    toolChoice?: OpenAIToolChoice
  }): void {
    try {
      fs.mkdirSync(REACT_PROMPTS_LOG_DIR, { recursive: true })

      const promptLogFilePath = path.join(
        REACT_PROMPTS_LOG_DIR,
        `${params.phase}.log`
      )
      const headerLines = [
        `=== ${new Date().toISOString()} ===`,
        `phase=${params.phase}`,
        `channel=${params.channel}`,
        `stream=${params.shouldStream === true ? 'true' : 'false'}`,
        ...(params.phasePolicySummary
          ? [`policy=${params.phasePolicySummary}`]
          : []),
        ...(params.tools
          ? [
              `tool_count=${params.tools.length}`,
              `tool_choice=${
                params.toolChoice === undefined
                  ? 'omitted'
                  : typeof params.toolChoice === 'string'
                    ? params.toolChoice
                    : params.toolChoice.function.name
              }`
            ]
          : []),
        ''
      ]
      const sectionLines = params.sections.flatMap((section) => [
        `--- ${section.name} (${section.source}) ---`,
        section.content ?? '',
        ''
      ])

      fs.writeFileSync(
        promptLogFilePath,
        `${[...headerLines, ...sectionLines].join('\n')}\n`,
        'utf8'
      )
    } catch (error) {
      this.logTitle(params.phase)
      LogHelper.warning(
        `Failed to write prompt log file: ${String(error)}`
      )
    }
  }

  private logPromptDispatch(params: {
    phase: ReactPhase
    channel: 'json' | 'text' | 'tools'
    prompt: string
    systemPrompt: string
    phasePolicySummary?: string
    history?: MessageLog[]
    schema?: Record<string, unknown>
    tools?: OpenAITool[]
    toolChoice?: OpenAIToolChoice
    shouldStream?: boolean
    promptSections?: PromptLogSection[]
  }): void {
    const promptTokens = this.estimateTokensFromText(params.prompt)
    const systemTokens = this.estimateTokensFromText(params.systemPrompt)
    const historyTokens = this.estimateHistoryTokens(params.history)
    const schemaTokens = params.schema
      ? this.estimateTokensFromText(this.safeJSONStringify(params.schema))
      : 0
    const totalEstimated =
      promptTokens + systemTokens + historyTokens + schemaTokens

    this.logTitle(params.phase)
    LogHelper.debug(
      `Prompt dispatch [${params.channel}] est_tokens=${totalEstimated} (prompt=${promptTokens}, system=${systemTokens}, history=${historyTokens}${schemaTokens > 0 ? `, schema=${schemaTokens}` : ''})${
        params.shouldStream === true ? ' | stream=true' : ''
      }${
        params.phasePolicySummary ? ` | ${params.phasePolicySummary}` : ''
      }${
        params.tools
          ? ` | tools=${params.tools.length} | tool_choice=${
              params.toolChoice === undefined
                ? 'omitted'
                : typeof params.toolChoice === 'string'
                  ? params.toolChoice
                  : params.toolChoice.function.name
            }`
          : ''
      }`
    )
    const sections =
      params.promptSections && params.promptSections.length > 0
        ? params.promptSections
        : this.buildDefaultPromptSections(params)
    this.writePhasePromptLog({
      phase: params.phase,
      channel: params.channel,
      sections,
      ...(params.phasePolicySummary !== undefined
        ? { phasePolicySummary: params.phasePolicySummary }
        : {}),
      ...(params.shouldStream !== undefined
        ? { shouldStream: params.shouldStream }
        : {}),
      ...(params.tools ? { tools: params.tools } : {}),
      ...(params.toolChoice !== undefined
        ? { toolChoice: params.toolChoice }
        : {})
    })

    if (sections.length > 0) {
      LogHelper.debug(
        `Prompt sections [${params.channel}]:\n${sections
          .map((section) => {
            const sectionTokens = this.estimateTokensFromText(
              section.content ?? ''
            )
            return `- ${section.name} (${this.compactSectionSourcePath(
              section.source
            )}) | est_tokens=${sectionTokens}`
          })
          .join('\n')}`
      )
    }
  }

  private compactSectionSourcePath(source: string): string {
    const normalized = String(source || '').replace(/\\/g, '/')
    const parts = normalized.split('/').filter((part) => part.length > 0)
    if (parts.length <= 2) {
      return parts.join('/')
    }

    return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`
  }

  private buildDefaultPromptSections(params: {
    prompt: string
    systemPrompt: string
    schema?: Record<string, unknown>
    tools?: OpenAITool[]
    history?: MessageLog[]
  }): PromptLogSection[] {
    const sections: PromptLogSection[] = [
      {
        name: 'SYSTEM_PROMPT',
        source: 'server/src/core/llm-manager/persona.ts',
        content: params.systemPrompt
      },
      {
        name: 'PHASE_PROMPT',
        source: 'server/src/core/llm-manager/llm-duties/react-llm-duty/*.ts',
        content: params.prompt
      }
    ]

    if (params.schema) {
      sections.push({
        name: 'JSON_SCHEMA',
        source: 'server/src/core/llm-manager/llm-duties/react-llm-duty/*.ts',
        content: this.safeJSONStringify(params.schema)
      })
    }

    if (params.tools && params.tools.length > 0) {
      sections.push({
        name: 'TOOLS_SCHEMA',
        source: 'server/src/core/llm-manager/llm-duties/react-llm-duty/*.ts',
        content: this.safeJSONStringify(params.tools)
      })
    }

    if (params.history && params.history.length > 0) {
      sections.push({
        name: 'HISTORY',
        source: 'core/conversation_logger',
        content: params.history.map((entry) => entry.message || '').join('\n')
      })
    }

    return sections
  }

  private logPromptUsage(
    phase: ReactPhase,
    channel: 'json' | 'text' | 'tools',
    usedInputTokens: number,
    usedOutputTokens: number
  ): void {
    this.logTitle(phase)
    LogHelper.debug(
      `Prompt usage [${channel}] input=${usedInputTokens} output=${usedOutputTokens} | total=${this.totalInputTokens}+${this.totalOutputTokens}=${this.totalInputTokens + this.totalOutputTokens}`
    )
  }

  private logPromptReasoning(
    phase: ReactPhase,
    channel: 'json' | 'text' | 'tools',
    reasoning?: string
  ): void {
    this.logTitle(phase)
    if (reasoning && reasoning.trim()) {
      LogHelper.debug(`Prompt reasoning [${channel}]:\n${reasoning.trim()}`)
      return
    }

    LogHelper.debug(`Prompt reasoning [${channel}]: none`)
  }

  private buildLongToolCallReason(
    prompt: string,
    systemPrompt: string,
    tools: OpenAITool[],
    history?: MessageLog[]
  ): string {
    const estimatedPromptTokens =
      this.estimateTokensFromText(prompt) +
      this.estimateTokensFromText(systemPrompt) +
      this.estimateTokensFromText(JSON.stringify(tools)) +
      this.estimateHistoryTokens(history)

    if (estimatedPromptTokens > 4_500) {
      return BRAIN.wernicke('react.tool_call.reason.large_prompt', '', {
        '{{ estimated_tokens }}': String(estimatedPromptTokens)
      })
    }

    if (tools.length > 1) {
      return BRAIN.wernicke('react.tool_call.reason.multi_tools', '', {
        '{{ tool_count }}': String(tools.length)
      })
    }

    return BRAIN.wernicke('react.tool_call.reason.provider_latency')
  }

  private async runLongToolCallDiagnosis(
    prompt: string,
    systemPrompt: string,
    tools: OpenAITool[],
    toolChoice: OpenAIToolChoice,
    history?: MessageLog[]
  ): Promise<void> {
    const promptTokens =
      this.estimateTokensFromText(prompt) +
      this.estimateTokensFromText(systemPrompt)
    const toolSchemaTokens = this.estimateTokensFromText(JSON.stringify(tools))
    const historyTokens = this.estimateHistoryTokens(history)
    const totalEstimatedTokens =
      promptTokens + toolSchemaTokens + historyTokens
    const forcedChoice =
      typeof toolChoice === 'string'
        ? toolChoice
        : `forced:${toolChoice.function.name}`

    const diagnosisMessage = BRAIN.wernicke('react.tool_call.diagnosis', '', {
      '{{ provider }}': LLM_PROVIDER_NAME,
      '{{ tool_choice }}': forcedChoice,
      '{{ tool_count }}': String(tools.length),
      '{{ total_tokens }}': String(totalEstimatedTokens),
      '{{ prompt_tokens }}': String(promptTokens),
      '{{ tool_tokens }}': String(toolSchemaTokens),
      '{{ history_tokens }}': String(historyTokens)
    })

    this.logTitle('execution')
    LogHelper.warning(
      `Long tool-call diagnosis (> ${TOOL_CALL_DIAGNOSIS_DELAY_MS}ms): ${diagnosisMessage}`
    )

    await this.emitProgress(diagnosisMessage)
  }

  private async emitProgress(message: string): Promise<void> {
    if (!message) {
      return
    }

    try {
      await BRAIN.talk(message)
    } catch (error) {
      this.logTitle('execution')
      LogHelper.warning(
        `Failed to emit intermediate progress message: ${String(error)}`
      )
    }
  }

  private toProgressiveMessage(message: string): string {
    const normalized = String(message || '')
      .replace(/\s+/g, ' ')
      .trim()
    if (!normalized) {
      return 'Working...'
    }

    const withEllipsis = normalized.endsWith('...')
      ? normalized
      : `${normalized.replace(/[.?!]+$/g, '')}...`

    return withEllipsis
  }

  private makeDutyResult(output: string): LLMDutyResult {
    if (!this.finalAnswerPhaseCompleted) {
      throw new Error(
        'ReAct invariant violation: user-facing output must be produced by final_answer phase.'
      )
    }

    const normalizedOutput = StringHelper.normalizeUserFacingText(output)

    if (!this.hasStreamedTokenEmission && normalizedOutput?.trim()) {
      this.emitSyntheticTokenStream(normalizedOutput)
    }

    this.logTitle('final_answer')
    LogHelper.success('Duty executed')
    LogHelper.success(`Output — ${normalizedOutput}`)
    LogHelper.debug(
      `Total tokens — input: ${this.totalInputTokens} | output: ${this.totalOutputTokens} | combined: ${this.totalInputTokens + this.totalOutputTokens}`
    )

    return {
      dutyType: LLMDuties.ReAct,
      systemPrompt: this.systemPrompt,
      input: this.input,
      output: normalizedOutput,
      data: {
        hasExplicitMemoryWrite: this.hasExplicitMemoryWrite
      }
    } as unknown as LLMDutyResult
  }

  private emitReasoningToken(token: string, generationId: string): void {
    if (!token || !generationId) {
      return
    }

    const chunks = token.match(/(\s+|[^\s]+)/g) || [token]
    for (const chunk of chunks) {
      SOCKET_SERVER.socket?.emit('llm-reasoning-token', {
        token: chunk,
        generationId
      })
    }
  }

  private emitSyntheticTokenStream(output: string): void {
    const generationId = StringHelper.random(6, { onlyLetters: true })
    const chunks = output.match(/(\s+|[^\s]+)/g) || [output]

    this.hasStreamedTokenEmission = chunks.length > 0

    for (const token of chunks) {
      SOCKET_SERVER.socket?.emit('llm-token', {
        token,
        generationId
      })
    }
  }
}
