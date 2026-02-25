import type { LlamaContext } from 'node-llama-cpp'
import { LlamaChatSession } from 'node-llama-cpp'

import {
  DEFAULT_INIT_PARAMS,
  LLMDuty,
  type LLMDutyInitParams,
  type LLMDutyParams,
  type LLMDutyResult
} from '@/core/llm-manager/llm-duty'
import { LogHelper } from '@/helpers/log-helper'
import {
  LLM_MANAGER,
  LLM_PROVIDER,
  PERSONA,
  TOOLKIT_REGISTRY,
  CONTEXT_MANAGER,
  CONVERSATION_LOGGER,
  BRAIN
} from '@/core'
import {
  LLMDuties,
  LLMProviders,
  type OpenAITool,
  type OpenAIToolCall,
  type OpenAIToolChoice
} from '@/core/llm-manager/types'
import { LLM_PROVIDER as LLM_PROVIDER_NAME } from '@/constants'
import type { MessageLog } from '@/types'

import {
  PLAN_SYSTEM_PROMPT,
  REACT_TEMPERATURE,
  REACT_INFERENCE_TIMEOUT_MS,
  REACT_LOCAL_PROVIDER_HISTORY_LOGS,
  REACT_REMOTE_PROVIDER_HISTORY_LOGS,
  MAX_EXECUTIONS,
  MAX_REPLANS
} from './react-llm-duty/constants'
import type {
  ReactLLMDutyParams,
  ExecutionRecord,
  TrackedPlanStep,
  PlanStepStatus,
  LLMCaller
} from './react-llm-duty/types'
import { widgetId, emitPlanWidget } from './react-llm-duty/plan-widget'
import {
  buildCatalog,
  runPlanningPhase,
  runExecutionStep,
  runFinalAnswerPhase
} from './react-llm-duty/phases'

export class ReActLLMDuty extends LLMDuty {
  private static instance: ReActLLMDuty
  private static context: LlamaContext = null as unknown as LlamaContext
  private static session: LlamaChatSession =
    null as unknown as LlamaChatSession
  protected systemPrompt: LLMDutyParams['systemPrompt'] = null
  protected readonly name = 'ReAct LLM Duty'
  protected input: LLMDutyParams['input'] = null
  private totalInputTokens = 0
  private totalOutputTokens = 0

  constructor(params: ReactLLMDutyParams) {
    super()

    if (!ReActLLMDuty.instance) {
      LogHelper.title(this.name)
      LogHelper.success('New instance')

      ReActLLMDuty.instance = this
    }

    this.input = params.input
    this.systemPrompt = PERSONA.getCompactDutySystemPrompt(PLAN_SYSTEM_PROMPT)
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

    try {
      const history =
        LLM_PROVIDER_NAME !== LLMProviders.Local
          ? await CONVERSATION_LOGGER.load({
              nbOfLogsToLoad: REACT_REMOTE_PROVIDER_HISTORY_LOGS
            })
          : await CONVERSATION_LOGGER.load({
              nbOfLogsToLoad: REACT_LOCAL_PROVIDER_HISTORY_LOGS
            })

      // --- Build adaptive catalog ---
      const catalog = buildCatalog()

      LogHelper.title(this.name)
      LogHelper.debug(`Catalog mode: ${catalog.mode} | Catalog length: ${catalog.text.length} chars (~${Math.ceil(catalog.text.length / 4)} tokens) | Input: "${this.input}"`)
      LogHelper.debug(`Native tools supported: ${this.supportsNativeTools} (provider: ${LLM_PROVIDER_NAME})`)

      // --- Phase 1: Planning ---
      LogHelper.title(this.name)
      LogHelper.debug('Phase 1: Planning...')

      const caller = this.createLLMCaller(history)
      const planResult = await runPlanningPhase(caller, catalog, history)

      if (planResult.type === 'final') {
        LogHelper.title(this.name)
        LogHelper.debug(`Planning returned final answer directly: "${planResult.answer.slice(0, 200)}"`)
        return this.makeDutyResult(planResult.answer)
      }

      LogHelper.title(this.name)
      LogHelper.debug(
        `Plan created with ${planResult.steps.length} step(s): ${planResult.steps.map((s) => s.function).join(' -> ')}`
      )
      if (planResult.summary) {
        LogHelper.debug(`Plan summary: "${planResult.summary}"`)
      }

      let pendingSteps = [...planResult.steps]
      const executionHistory: ExecutionRecord[] = []
      let replanCount = 0
      let executionCount = 0

      // --- Plan widget state ---
      const planWidgetIdValue = widgetId('plan')
      let trackedSteps: TrackedPlanStep[] = pendingSteps.map((s) => ({
        label: s.label,
        status: 'pending' as PlanStepStatus
      }))

      // Mark first step as in_progress and emit initial widget
      if (trackedSteps.length > 0) {
        trackedSteps[0]!.status = 'in_progress'
      }

      // Emit plan summary as text, then show the widget
      if (planResult.summary) {
        await this.emitProgress(planResult.summary)
      }
      emitPlanWidget(trackedSteps, null, planWidgetIdValue, false)

      // --- Phase 2: Execution loop ---
      LogHelper.title(this.name)
      LogHelper.debug('Phase 2: Execution loop...')

      let currentStepIndex = 0

      while (pendingSteps.length > 0 && executionCount < MAX_EXECUTIONS) {
        const currentStep = pendingSteps.shift()!
        executionCount += 1

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

        if (stepResult.type === 'final') {
          LogHelper.title(this.name)
          LogHelper.debug(`Execution returned final answer: "${(stepResult.answer).slice(0, 200)}"`)

          // Mark all remaining steps as completed in the widget
          for (const ts of trackedSteps) {
            ts.status = 'completed'
          }
          emitPlanWidget(trackedSteps, null, planWidgetIdValue, true)

          return this.makeDutyResult(stepResult.answer)
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

          pendingSteps = stepResult.functions.map((f) => ({ function: f, label: f }))

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

          emitPlanWidget(trackedSteps, null, planWidgetIdValue, true)
          continue
        }

        // Record execution
        executionHistory.push(stepResult.execution)

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
        emitPlanWidget(trackedSteps, currentStepIndex, planWidgetIdValue, true)
        currentStepIndex = nextTrackedIndex

        // Check for short-circuit final answer from tool result
        if (stepResult.finalAnswer) {
          LogHelper.title(this.name)
          LogHelper.debug(`Tool returned final_answer, short-circuiting: "${stepResult.finalAnswer.slice(0, 200)}"`)

          // Mark all remaining as completed
          for (const ts of trackedSteps) {
            ts.status = 'completed'
          }
          emitPlanWidget(trackedSteps, null, planWidgetIdValue, true)

          return this.makeDutyResult(stepResult.finalAnswer)
        }

        // Check for missing settings error — return immediately
        if (stepResult.missingSettingsMessage) {
          LogHelper.title(this.name)
          LogHelper.debug(`Missing settings detected: "${stepResult.missingSettingsMessage}"`)
          return this.makeDutyResult(stepResult.missingSettingsMessage)
        }
      }

      // --- Phase 3: Final answer synthesis ---
      LogHelper.title(this.name)
      LogHelper.debug(`Phase 3: Final answer synthesis (${executionHistory.length} execution(s) completed)`)

      // Mark all steps as completed in the widget
      for (const ts of trackedSteps) {
        ts.status = 'completed'
      }
      emitPlanWidget(trackedSteps, null, planWidgetIdValue, true)

      if (executionHistory.length === 0) {
        LogHelper.debug('No executions completed, returning fallback')
        return this.makeDutyResult(
          'I was unable to find the right tools to help with your request.'
        )
      }

      const finalAnswer = await runFinalAnswerPhase(caller, executionHistory)
      return this.makeDutyResult(finalAnswer)
    } catch (e) {
      LogHelper.title(this.name)
      LogHelper.error(`Failed to execute: ${e}`)
    }

    return null
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
  private createLLMCaller(history: MessageLog[]): LLMCaller {
    return {
      callLLM: this.callLLM.bind(this),
      callLLMWithTools: this.callLLMWithTools.bind(this),
      supportsNativeTools: this.supportsNativeTools,
      input: this.input,
      history,
      getContextForToolkit: CONTEXT_MANAGER.getContextForToolkit.bind(
        CONTEXT_MANAGER
      )
    }
  }

  private async callLLM(
    prompt: string,
    systemPrompt: string,
    schema: Record<string, unknown>,
    history?: MessageLog[]
  ): Promise<{
    output: unknown
    usedInputTokens?: number
    usedOutputTokens?: number
  } | null> {
    const completionParams = {
      dutyType: LLMDuties.ReAct,
      systemPrompt,
      data: schema,
      temperature: REACT_TEMPERATURE,
      timeout: REACT_INFERENCE_TIMEOUT_MS,
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
      LogHelper.title(this.name)
      LogHelper.debug(
        `Tokens — input: ${result.usedInputTokens ?? 0} | output: ${result.usedOutputTokens ?? 0} | total: ${this.totalInputTokens}+${this.totalOutputTokens}=${this.totalInputTokens + this.totalOutputTokens}`
      )
    }

    return result
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
    history?: MessageLog[]
  ): Promise<{
    toolCall?: { functionName: string, arguments: string }
    textContent?: string
    usedInputTokens?: number
    usedOutputTokens?: number
  } | null> {
    const toolNames = tools.map((t) => t.function.name).join(', ')
    const choiceLabel =
      typeof toolChoice === 'string'
        ? toolChoice
        : `forced:${toolChoice.function.name}`

    LogHelper.title(this.name)
    LogHelper.debug(
      `callLLMWithTools: tools=[${toolNames}] | choice=${choiceLabel}`
    )

    const completionResult = await LLM_PROVIDER.prompt(prompt, {
      dutyType: LLMDuties.ReAct,
      systemPrompt,
      temperature: REACT_TEMPERATURE,
      timeout: REACT_INFERENCE_TIMEOUT_MS,
      tools,
      toolChoice,
      ...(history ? { history } : {})
    })

    if (!completionResult) {
      LogHelper.debug('callLLMWithTools: no completion result returned')
      return null
    }

    this.totalInputTokens += completionResult.usedInputTokens ?? 0
    this.totalOutputTokens += completionResult.usedOutputTokens ?? 0
    LogHelper.title(this.name)
    LogHelper.debug(
      `Tokens — input: ${completionResult.usedInputTokens ?? 0} | output: ${completionResult.usedOutputTokens ?? 0} | total: ${this.totalInputTokens}+${this.totalOutputTokens}=${this.totalInputTokens + this.totalOutputTokens}`
    )

    // Check if the model responded with tool calls
    const toolCalls = (
      completionResult as unknown as { toolCalls?: OpenAIToolCall[] }
    ).toolCalls
    if (toolCalls && toolCalls.length > 0) {
      const firstCall = toolCalls[0]!
      const allowedToolNames = new Set(tools.map((t) => t.function.name))
      if (!allowedToolNames.has(firstCall.function.name)) {
        LogHelper.title(this.name)
        LogHelper.warning(
          `callLLMWithTools: unexpected tool call "${firstCall.function.name}" (allowed: ${[...allowedToolNames].join(', ') || 'none'})`
        )

        const textContentFallback =
          typeof completionResult.output === 'string'
            ? completionResult.output
            : ''
        return {
          textContent: textContentFallback,
          usedInputTokens: completionResult.usedInputTokens,
          usedOutputTokens: completionResult.usedOutputTokens
        }
      }
      LogHelper.title(this.name)
      LogHelper.debug(
        `callLLMWithTools: tool call received — ${firstCall.function.name}(${firstCall.function.arguments.slice(0, 200)})`
      )
      return {
        toolCall: {
          functionName: firstCall.function.name,
          arguments: firstCall.function.arguments
        },
        usedInputTokens: completionResult.usedInputTokens,
        usedOutputTokens: completionResult.usedOutputTokens
      }
    }

    // Model responded with text content (no tool call)
    const textContent =
      typeof completionResult.output === 'string'
        ? completionResult.output
        : ''
    LogHelper.title(this.name)
    LogHelper.debug(
      `callLLMWithTools: no tool call, text response: "${textContent.slice(0, 200)}"`
    )
    return {
      textContent,
      usedInputTokens: completionResult.usedInputTokens,
      usedOutputTokens: completionResult.usedOutputTokens
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private async emitProgress(message: string): Promise<void> {
    if (!message) {
      return
    }
    await BRAIN.talk(message)
  }

  private makeDutyResult(output: string): LLMDutyResult {
    LogHelper.title(this.name)
    LogHelper.success('Duty executed')
    LogHelper.success(`Output — ${output}`)
    LogHelper.debug(
      `Total tokens — input: ${this.totalInputTokens} | output: ${this.totalOutputTokens} | combined: ${this.totalInputTokens + this.totalOutputTokens}`
    )

    return {
      dutyType: LLMDuties.ReAct,
      systemPrompt: this.systemPrompt,
      input: this.input,
      output,
      data: {}
    } as unknown as LLMDutyResult
  }
}
