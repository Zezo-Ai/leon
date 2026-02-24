import { writeFileSync, mkdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

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
  TOOL_EXECUTOR,
  CONVERSATION_LOGGER,
  BRAIN,
  SOCKET_SERVER
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

type ReactLLMDutyParams = LLMDutyParams;

const formatFilePath = (filePath: string): string => {
  return `[FILE_PATH]${filePath}[/FILE_PATH]`
}

/**
 * Catalog token budget. When the lightweight function catalog exceeds this
 * estimated token count we fall back to a tool-level catalog (no individual
 * functions) and resolve functions during the execution phase.
 *
 * ~4 chars per token is a conservative estimate that works across model
 * tokenizers.
 */
const CATALOG_TOKEN_BUDGET = 2_000
const CHARS_PER_TOKEN = 4

const FORMATTING_RULES = `FORMATTING RULES for all user-facing text:
- Do NOT use markdown (no **, ##, \`\`\`, etc.).
- Use plain text only: newlines for paragraphs, dashes for lists.
- Keep answers concise.
- ALWAYS wrap file paths with [FILE_PATH]/path/here[/FILE_PATH]. Example: the file is at [FILE_PATH]/home/user/file.txt[/FILE_PATH].`

const PLAN_SYSTEM_PROMPT = `You are an autonomous planning and acting agent. Your goal is to solve the user's request.

You have access to a catalog of available tools and functions. Your job is to:
1. Analyze the user request
2. Select the functions (or tools) you need to call, in order
3. Provide a short natural language summary of your plan for the user

Only use functions/tools that are listed in the catalog.
If no function/tool is relevant (e.g. the user is chatting or asking a general question), return an empty steps array and put your answer in the summary field.

Prefer dedicated tools over the operating_system_control toolkit.
You must always consider other tools first before using the operating_system_control toolkit. Use the operating_system_control toolkit and bash tool only as a last resort when no suitable tool exists.

${FORMATTING_RULES}

Always create a complete plan with ALL steps needed upfront. Do not return only the first step.
For example, if the user asks to "find a file and process it", include ALL steps: find, probe, process.

"steps" is an ordered array of functions to call. Each step has:
  - "function": the fully qualified name (toolkit_id.tool_id.function_name). If the catalog only lists tools, use toolkit_id.tool_id.
  - "label": a very short user-facing description of what this step does. Must start with a verb (e.g. "Search for video files", "Download the page", "List matching items"). Keep it under 8 words.
"summary" is a short natural language description of the plan for the user. If no tools are needed, put your conversational answer here with an empty steps array.

No other keys, no null values.`

const EXECUTE_SYSTEM_PROMPT = `You are an autonomous acting agent executing a plan step by step.

You are now executing a specific function. You are given the function signature with its parameters.
Fill in the tool_input based on the user request and any observations from previous steps.

When chaining tools, reuse fields from the latest observation to fill the next tool_input whenever possible.

IMPORTANT: Only provide required parameters. Do NOT fill in optional parameters unless the user explicitly provided values for them. Never guess or infer optional parameter values such as file paths, configurations, or system-specific settings.

When the next action is based on uncertainty, assumptions, ambiguous selection, or could be irreversible, ask for confirmation before executing the tool.

tool_input must be a JSON string.

${FORMATTING_RULES}

Return ONLY one of the following JSON shapes:
- {"type":"execute","function_name":"...","tool_input":"{...}"}
- {"type":"replan","functions":["toolkit_id.tool_id.function_name",...],"reason":"..."}
- {"type":"final","answer":"..."}

No other keys, no null values.`

const RESOLVE_FUNCTION_SYSTEM_PROMPT = `You are selecting a function from a tool to execute.

You are given the available functions for a specific tool. Choose the most appropriate function for the current step and provide the tool_input.

IMPORTANT: Only provide required parameters. Do NOT fill in optional parameters unless the user explicitly provided values for them.

tool_input must be a JSON string.

${FORMATTING_RULES}

Return ONLY one of the following JSON shapes:
- {"type":"execute","function_name":"...","tool_input":"{...}"}
- {"type":"replan","functions":["toolkit_id.tool_id.function_name",...],"reason":"..."}
- {"type":"final","answer":"..."}

No other keys, no null values.`

const MAX_EXECUTIONS = 20
const MAX_REPLANS = 3
const MAX_RETRIES_PER_FUNCTION = 2
const REACT_TEMPERATURE = 0.2

const REACT_LOCAL_PROVIDER_HISTORY_LOGS = 8
const REACT_REMOTE_PROVIDER_HISTORY_LOGS = 16

interface PlanStep {
  function: string
  label: string
}

interface ExecutionRecord {
  function: string
  status: string
  observation: string
}

type PlanStepStatus = 'pending' | 'in_progress' | 'completed'

interface TrackedPlanStep {
  label: string
  status: PlanStepStatus
}

/**
 * Helper to generate a short random ID for widget component IDs.
 */
const widgetId = (prefix: string): string =>
  `${prefix}-${Math.random().toString(36).substring(2, 7)}`

/**
 * Builds a serialized Aurora component tree for the plan widget.
 * This produces the exact JSON shape the client renderer expects.
 */
function buildPlanComponentTree(
  steps: TrackedPlanStep[],
  justCompletedIndex: number | null
): Record<string, unknown> {
  const listItems = steps.map((step, i) => {
    let child: Record<string, unknown>

    if (step.status === 'in_progress') {
      // Loader + Text
      child = {
        component: 'Flexbox',
        id: widgetId('flexbox'),
        props: {
          alignItems: 'center',
          flexDirection: 'row',
          gap: 'sm',
          children: [
            {
              component: 'Loader',
              id: widgetId('loader'),
              props: {},
              events: []
            },
            {
              component: 'Text',
              id: widgetId('text'),
              props: { children: step.label },
              events: []
            }
          ]
        },
        events: []
      }
    } else {
      // Checkbox
      const isCompleted = step.status === 'completed'
      const isJustCompleted = justCompletedIndex === i
      child = {
        component: 'Checkbox',
        id: widgetId('checkbox'),
        props: {
          name: `step-${i}`,
          label: step.label,
          checked: isCompleted,
          disabled: isCompleted && !isJustCompleted
        },
        events: []
      }
    }

    return {
      component: 'ListItem',
      id: widgetId('listitem'),
      props: {
        align: 'left',
        children: [child]
      },
      events: []
    }
  })

  return {
    component: 'WidgetWrapper',
    id: widgetId('widgetwrapper'),
    props: {
      noPadding: true,
      children: [
        {
          component: 'List',
          id: widgetId('list'),
          props: { children: listItems },
          events: []
        }
      ]
    },
    events: []
  }
}

/**
 * Determines whether a catalog entry refers to a tool (toolkit.tool) rather
 * than a fully-qualified function (toolkit.tool.function).
 */
const isToolLevel = (qualifiedName: string): boolean => {
  return qualifiedName.split('.').length <= 2
}

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
      const catalog = this.buildCatalog()

      LogHelper.title(this.name)
      LogHelper.debug(`Catalog mode: ${catalog.mode} | Catalog length: ${catalog.text.length} chars (~${Math.ceil(catalog.text.length / CHARS_PER_TOKEN)} tokens) | Input: "${this.input}"`)
      LogHelper.debug(`Native tools supported: ${this.supportsNativeTools} (provider: ${LLM_PROVIDER_NAME})`)

      // --- Phase 1: Planning ---
      LogHelper.title(this.name)
      LogHelper.debug('Phase 1: Planning...')

      const planResult = await this.runPlanningPhase(catalog, history)

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
      const planWidgetId = widgetId('plan')
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
      this.emitPlanWidget(trackedSteps, null, planWidgetId, false)

      // --- Phase 2: Execution loop ---
      LogHelper.title(this.name)
      LogHelper.debug('Phase 2: Execution loop...')

      let currentStepIndex = 0

      while (pendingSteps.length > 0 && executionCount < MAX_EXECUTIONS) {
        const currentStep = pendingSteps.shift()!
        executionCount += 1

        LogHelper.title(this.name)
        LogHelper.debug(
          `Execution ${executionCount}/${MAX_EXECUTIONS}: ${currentStep.function} | ${pendingSteps.length} step(s) remaining`
        )

        const stepResult = await this.runExecutionStep(
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
          this.emitPlanWidget(trackedSteps, null, planWidgetId, true)

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

          this.emitPlanWidget(trackedSteps, null, planWidgetId, true)
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
        this.emitPlanWidget(trackedSteps, currentStepIndex, planWidgetId, true)
        currentStepIndex = nextTrackedIndex

        // Check for short-circuit final answer from tool result
        if (stepResult.finalAnswer) {
          LogHelper.title(this.name)
          LogHelper.debug(`Tool returned final_answer, short-circuiting: "${stepResult.finalAnswer.slice(0, 200)}"`)

          // Mark all remaining as completed
          for (const ts of trackedSteps) {
            ts.status = 'completed'
          }
          this.emitPlanWidget(trackedSteps, null, planWidgetId, true)

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
      this.emitPlanWidget(trackedSteps, null, planWidgetId, true)

      if (executionHistory.length === 0) {
        LogHelper.debug('No executions completed, returning fallback')
        return this.makeDutyResult(
          'I was unable to find the right tools to help with your request.'
        )
      }

      const finalAnswer = await this.runFinalAnswerPhase(executionHistory)
      return this.makeDutyResult(finalAnswer)
    } catch (e) {
      LogHelper.title(this.name)
      LogHelper.error(`Failed to execute: ${e}`)
    }

    return null
  }

  // ---------------------------------------------------------------------------
  // Catalog building
  // ---------------------------------------------------------------------------

  private buildCatalog(): {
    text: string
    mode: 'function' | 'tool'
  } {
    const flattenedTools = TOOLKIT_REGISTRY.getFlattenedTools()

    // First try function-level catalog
    const functionLines: string[] = []
    for (const tool of flattenedTools) {
      const toolFunctions = TOOLKIT_REGISTRY.getToolFunctions(
        tool.toolkitId,
        tool.toolId
      )
      if (toolFunctions) {
        for (const [fnName, fnConfig] of Object.entries(toolFunctions)) {
          // Include required parameter names so the model can reason about
          // data flow between steps (e.g. search returns a URL → download needs a URL)
          const params = fnConfig.parameters
          const paramNames: string[] = []
          if (params && typeof params === 'object') {
            const properties = (params as Record<string, unknown>)['properties']
            if (properties && typeof properties === 'object') {
              paramNames.push(...Object.keys(properties as Record<string, unknown>))
            }
          }
          const paramHint = paramNames.length > 0
            ? ` (${paramNames.join(', ')})`
            : ''
          functionLines.push(
            `- ${tool.toolkitId}.${tool.toolId}.${fnName}${paramHint}: ${fnConfig.description}`
          )
        }
      }
    }

    const functionCatalog = functionLines.join('\n')
    const estimatedTokens = Math.ceil(
      functionCatalog.length / CHARS_PER_TOKEN
    )

    if (estimatedTokens <= CATALOG_TOKEN_BUDGET) {
      return {
        text: `Available Functions:\n${functionCatalog}`,
        mode: 'function'
      }
    }

    // Fall back to tool-level catalog
    const toolLines: string[] = []
    for (const tool of flattenedTools) {
      toolLines.push(
        `- ${tool.toolkitId}.${tool.toolId}: ${tool.toolDescription}`
      )
    }

    return {
      text: `Available Tools:\n${toolLines.join('\n')}`,
      mode: 'tool'
    }
  }

  // ---------------------------------------------------------------------------
  // Phase 1: Planning
  // ---------------------------------------------------------------------------

  private async runPlanningPhase(
    catalog: { text: string, mode: 'function' | 'tool' },
    history: MessageLog[]
  ): Promise<
    | { type: 'plan', steps: PlanStep[], summary: string }
    | { type: 'final', answer: string }
  > {
    const catalogNote =
      catalog.mode === 'tool'
        ? '\nNote: The catalog lists tools, not individual functions. Use the format toolkit_id.tool_id in your plan steps.'
        : ''
    const planSystemPrompt = PERSONA.getCompactDutySystemPrompt(
      PLAN_SYSTEM_PROMPT
    )
    const prompt = `${catalog.text}${catalogNote}\n\nUser Request: "${this.input}"`

    const planSchema = {
      oneOf: [
        {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['plan'] },
            steps: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  function: { type: 'string' },
                  label: { type: 'string' }
                },
                required: ['function', 'label'],
                additionalProperties: false
              }
            },
            summary: { type: 'string' }
          },
          required: ['type', 'steps', 'summary'],
          additionalProperties: false
        },
        {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['final'] },
            answer: { type: 'string' }
          },
          required: ['type', 'answer'],
          additionalProperties: false
        }
      ]
    }

    const completionParams = {
      dutyType: LLMDuties.ReAct,
      systemPrompt: planSystemPrompt,
      data: planSchema,
      temperature: REACT_TEMPERATURE,
      history
    }

    let completionResult = undefined

    // --- Remote providers: use native tool calling to force structured output ---
    if (this.supportsNativeTools) {
      const planTools: OpenAITool[] = [
        {
          type: 'function',
          function: {
            name: 'create_plan',
            description:
              'Create an execution plan with ordered steps to solve the user request. If no tools are needed (conversational message), return empty steps with the answer in summary.',
            parameters: {
              type: 'object',
              properties: {
                steps: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      function: {
                        type: 'string',
                        description:
                          'Fully qualified function name: toolkit_id.tool_id.function_name'
                      },
                      label: {
                        type: 'string',
                        description:
                          'Short user-facing task description starting with a verb, under 8 words'
                      }
                    },
                    required: ['function', 'label']
                  }
                },
                summary: {
                  type: 'string',
                  description:
                    'Short natural language summary of the plan, or the conversational answer if steps is empty'
                }
              },
              required: ['steps', 'summary']
            }
          }
        }
      ]

      // First attempt: force create_plan to get a proper multi-step plan
      const toolResult = await this.callLLMWithTools(
        prompt,
        planSystemPrompt,
        planTools,
        { type: 'function', function: { name: 'create_plan' } },
        history
      )

      LogHelper.title(this.name)
      LogHelper.debug(`Planning prompt: "${prompt.slice(0, 300)}..."`)
      LogHelper.debug(
        `Planning tool result: ${JSON.stringify(toolResult).slice(0, 500)}`
      )

      if (toolResult?.toolCall) {
        try {
          const parsedArgs = JSON.parse(toolResult.toolCall.arguments)
          if (Array.isArray(parsedArgs.steps)) {
            const steps = this.parseStepsFromArgs(parsedArgs.steps)
            if (steps.length > 0) {
              const summary =
                typeof parsedArgs.summary === 'string'
                  ? (parsedArgs.summary as string)
                  : ''
              return { type: 'plan', steps, summary }
            }
          }

          // Model returned create_plan with empty steps — treat the summary
          // as a direct answer (conversational response)
          if (parsedArgs.summary) {
            return {
              type: 'final',
              answer: (parsedArgs.summary as string).trim()
            }
          }
        } catch {
          LogHelper.debug('Planning: failed to parse create_plan arguments')
        }
      }

      // Fallback: if the model returned text instead of a tool call
      if (toolResult?.textContent) {
        const parsed = this.parseOutput(toolResult.textContent)
        const fallbackResult = this.extractPlanFromParsed(parsed)
        if (fallbackResult) {
          return fallbackResult
        }

        return {
          type: 'final',
          answer:
            toolResult.textContent.trim() ||
            'I could not understand how to help with that request.'
        }
      }

      return {
        type: 'final',
        answer: 'I could not determine what to do.'
      }
    }

    // --- Local provider: use grammar-constrained JSON mode ---
    completionResult = await LLM_PROVIDER.prompt(prompt, {
      ...completionParams,
      session: ReActLLMDuty.session
    })

    LogHelper.title(this.name)
    LogHelper.debug(`Planning prompt: "${prompt.slice(0, 300)}..."`)
    LogHelper.debug(
      `Planning raw output: ${JSON.stringify(completionResult?.output).slice(0, 500)}`
    )

    const parsed = this.parseOutput(completionResult?.output)
    const planResult = this.extractPlanFromParsed(parsed)
    if (planResult) {
      return planResult
    }

    // Fallback
    const raw =
      typeof completionResult?.output === 'string'
        ? completionResult.output.trim()
        : ''
    return { type: 'final', answer: raw || 'I could not determine what to do.' }
  }

  // ---------------------------------------------------------------------------
  // Phase 2: Execution
  // ---------------------------------------------------------------------------

  private async runExecutionStep(
    step: PlanStep,
    executionHistory: ExecutionRecord[],
    catalog: { text: string, mode: 'function' | 'tool' }
  ): Promise<
    | { type: 'final', answer: string }
    | {
        type: 'replan'
        reason: string
        functions: string[]
      }
    | {
        type: 'executed'
        execution: ExecutionRecord
        finalAnswer?: string
        missingSettingsMessage?: string
      }
  > {
    const qualifiedName = step.function
    const parts = qualifiedName.split('.')

    // If the plan only has tool-level references (from tool-level catalog),
    // we need an extra resolution step to pick the right function.
    if (isToolLevel(qualifiedName) || catalog.mode === 'tool') {
      return this.runToolLevelExecution(
        qualifiedName,
        parts,
        executionHistory,
        catalog
      )
    }

    // Function-level: we have toolkit.tool.function
    const toolkitId = parts[0] || ''
    const toolId = parts[1] || ''
    const functionName = parts.slice(2).join('.') || ''

    if (!toolkitId || !toolId || !functionName) {
      return {
        type: 'executed',
        execution: {
          function: qualifiedName,
          status: 'error',
          observation: `Invalid function reference "${qualifiedName}". Expected format: toolkit_id.tool_id.function_name.`
        }
      }
    }

    // Get function schema for this specific function
    const toolFunctions = TOOLKIT_REGISTRY.getToolFunctions(
      toolkitId,
      toolId
    )
    const functionConfig = toolFunctions?.[functionName]

    if (!functionConfig) {
      // Try resolving via registry
      const resolved = TOOLKIT_REGISTRY.resolveToolById(toolId, toolkitId)
      if (!resolved) {
        return {
          type: 'executed',
          execution: {
            function: qualifiedName,
            status: 'error',
            observation: `Function "${qualifiedName}" not found in the registry.`
          }
        }
      }
      const resolvedFunctions = TOOLKIT_REGISTRY.getToolFunctions(
        resolved.toolkitId,
        resolved.toolId
      )
      if (!resolvedFunctions?.[functionName]) {
        return {
          type: 'executed',
          execution: {
            function: qualifiedName,
            status: 'error',
            observation: `Function "${functionName}" not found in tool "${resolved.toolId}". Available: ${resolvedFunctions ? Object.keys(resolvedFunctions).join(', ') : 'none'}.`
          }
        }
      }
    }

    const resolvedConfig = functionConfig || TOOLKIT_REGISTRY.getToolFunctions(
      toolkitId,
      toolId
    )?.[functionName]

    if (!resolvedConfig) {
      return {
        type: 'executed',
        execution: {
          function: qualifiedName,
          status: 'error',
          observation: `Could not resolve function config for "${qualifiedName}".`
        }
      }
    }

    // Ask the LLM to fill in tool_input
    return this.executeFunction(
      toolkitId,
      toolId,
      functionName,
      resolvedConfig,
      executionHistory
    )
  }

  /**
   * Handles execution when the plan step refers to a tool (toolkit.tool)
   * rather than a fully-qualified function. Shows the tool's functions
   * and asks the LLM to pick one and provide input in a single step.
   */
  private async runToolLevelExecution(
    qualifiedName: string,
    parts: string[],
    executionHistory: ExecutionRecord[],
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _catalog: { text: string, mode: 'function' | 'tool' }
  ): Promise<
    | { type: 'final', answer: string }
    | { type: 'replan', reason: string, functions: string[] }
    | {
        type: 'executed'
        execution: ExecutionRecord
        finalAnswer?: string
        missingSettingsMessage?: string
      }
  > {
    const toolkitId = parts[0] || ''
    const toolId = parts[1] || parts[0] || ''

    LogHelper.title(this.name)
    LogHelper.debug(`Tool-level execution: resolving "${qualifiedName}"`)

    // Try to resolve the tool
    const resolved = TOOLKIT_REGISTRY.resolveToolById(toolId, toolkitId || undefined)
    const effectiveToolkitId = resolved?.toolkitId || toolkitId
    const effectiveToolId = resolved?.toolId || toolId

    const toolFunctions = TOOLKIT_REGISTRY.getToolFunctions(
      effectiveToolkitId,
      effectiveToolId
    )

    if (!toolFunctions || Object.keys(toolFunctions).length === 0) {
      LogHelper.debug(`No functions found for tool "${qualifiedName}"`)
      return {
        type: 'executed',
        execution: {
          function: qualifiedName,
          status: 'error',
          observation: `No functions found for tool "${qualifiedName}".`
        }
      }
    }

    const functionEntries = Object.entries(toolFunctions)

    // If only one function, auto-select it
    if (functionEntries.length === 1) {
      const [fnName, fnConfig] = functionEntries[0]!
      LogHelper.debug(`Auto-selecting only function: ${fnName}`)
      return this.executeFunction(
        effectiveToolkitId,
        effectiveToolId,
        fnName,
        fnConfig,
        executionHistory
      )
    }

    // Multiple functions — ask the LLM to pick one and provide input

    // --- Native tool calling path (OpenRouter) ---
    if (this.supportsNativeTools) {
      return this.resolveToolFunctionWithNativeTools(
        qualifiedName,
        effectiveToolkitId,
        effectiveToolId,
        toolFunctions,
        executionHistory
      )
    }

    // --- JSON mode fallback ---
    return this.resolveToolFunctionWithJSONMode(
      qualifiedName,
      effectiveToolkitId,
      effectiveToolId,
      toolFunctions,
      functionEntries,
      executionHistory
    )
  }

  /**
   * Uses native tool calling with tool_choice='auto' to let the model pick
   * the right function from multiple options and provide arguments.
   */
  private async resolveToolFunctionWithNativeTools(
    qualifiedName: string,
    toolkitId: string,
    toolId: string,
    toolFunctions: Record<
      string,
      {
        description: string
        parameters: Record<string, unknown>
        output_schema?: Record<string, unknown>
      }
    >,
    executionHistory: ExecutionRecord[]
  ): Promise<
    | { type: 'final', answer: string }
    | { type: 'replan', reason: string, functions: string[] }
    | {
        type: 'executed'
        execution: ExecutionRecord
        finalAnswer?: string
        missingSettingsMessage?: string
      }
  > {
    const historySection = this.formatExecutionHistory(executionHistory)
    const resolveSystemPrompt = PERSONA.getCompactDutySystemPrompt(
      RESOLVE_FUNCTION_SYSTEM_PROMPT
    )

    const tools: OpenAITool[] = Object.entries(toolFunctions).map(
      ([fnName, fnConfig]) => ({
        type: 'function' as const,
        function: {
          name: fnName,
          description: fnConfig.description,
          parameters: fnConfig.parameters
        }
      })
    )

    const prompt = `Tool: ${toolkitId}.${toolId}\n\n${historySection}\n\nUser Request: "${this.input}"\n\nSelect the appropriate function and provide arguments.`

    const result = await this.callLLMWithTools(
      prompt,
      resolveSystemPrompt,
      tools,
      'auto'
    )

    if (!result) {
      return {
        type: 'executed',
        execution: {
          function: qualifiedName,
          status: 'error',
          observation: 'Failed to determine which function to call.'
        }
      }
    }

    if (result.toolCall) {
      const fnName = result.toolCall.functionName
      const fnConfig = toolFunctions[fnName]
      if (!fnConfig) {
        return {
          type: 'executed',
          execution: {
            function: `${toolkitId}.${toolId}.${fnName}`,
            status: 'error',
            observation: `Function "${fnName}" not found. Available: ${Object.keys(toolFunctions).join(', ')}.`
          }
        }
      }

      const toolInput = result.toolCall.arguments || '{}'
      return this.runToolExecution(
        toolkitId,
        toolId,
        fnName,
        toolInput,
        fnConfig
      )
    }

    // Text content fallback — parse for replan/final
    if (result.textContent) {
      const parsed = this.parseOutput(result.textContent)
      if (parsed?.['type'] === 'final' && parsed['answer']) {
        return { type: 'final', answer: parsed['answer'] as string }
      }
      if (parsed?.['type'] === 'replan') {
        return {
          type: 'replan',
          reason: (parsed['reason'] as string) || 'Plan revision needed',
          functions: Array.isArray(parsed['functions'])
            ? (parsed['functions'] as string[])
            : []
        }
      }
    }

    return {
      type: 'executed',
      execution: {
        function: qualifiedName,
        status: 'error',
        observation: 'Could not resolve function from tool-level plan step.'
      }
    }
  }

  /**
   * JSON mode fallback for resolving which function to call when the plan
   * step refers to a tool with multiple functions.
   */
  private async resolveToolFunctionWithJSONMode(
    qualifiedName: string,
    effectiveToolkitId: string,
    effectiveToolId: string,
    toolFunctions: Record<
      string,
      {
        description: string
        parameters: Record<string, unknown>
        output_schema?: Record<string, unknown>
      }
    >,
    functionEntries: [string, { description: string, parameters: Record<string, unknown> }][],
    executionHistory: ExecutionRecord[]
  ): Promise<
    | { type: 'final', answer: string }
    | { type: 'replan', reason: string, functions: string[] }
    | {
        type: 'executed'
        execution: ExecutionRecord
        finalAnswer?: string
        missingSettingsMessage?: string
      }
  > {
    const functionsSection = functionEntries
      .map(([fnName, fnConfig]) => {
        const params = JSON.stringify(fnConfig.parameters)
        return `- ${fnName}: ${fnConfig.description} ${params}`
      })
      .join('\n')

    const historySection = this.formatExecutionHistory(executionHistory)
    const resolveSystemPrompt = PERSONA.getCompactDutySystemPrompt(
      RESOLVE_FUNCTION_SYSTEM_PROMPT
    )
    const prompt = `Tool: ${effectiveToolkitId}.${effectiveToolId}\n\nAvailable Functions:\n${functionsSection}\n\n${historySection}\n\nUser Request: "${this.input}"\n\nSelect the appropriate function and provide tool_input.`

    const resolveSchema = {
      oneOf: [
        {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['execute'] },
            function_name: { type: 'string' },
            tool_input: { type: 'string' }
          },
          required: ['type', 'function_name', 'tool_input'],
          additionalProperties: false
        },
        {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['replan'] },
            functions: {
              type: 'array',
              items: { type: 'string' }
            },
            reason: { type: 'string' }
          },
          required: ['type', 'functions', 'reason'],
          additionalProperties: false
        },
        {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['final'] },
            answer: { type: 'string' }
          },
          required: ['type', 'answer'],
          additionalProperties: false
        }
      ]
    }

    const completionResult = await this.callLLM(prompt, resolveSystemPrompt, resolveSchema)
    const parsed = this.parseOutput(completionResult?.output)

    if (!parsed) {
      return {
        type: 'executed',
        execution: {
          function: qualifiedName,
          status: 'error',
          observation: 'Failed to determine which function to call.'
        }
      }
    }

    if (parsed['type'] === 'final' && parsed['answer']) {
      return { type: 'final', answer: parsed['answer'] as string }
    }

    if (parsed['type'] === 'replan') {
      return {
        type: 'replan',
        reason: (parsed['reason'] as string) || 'Plan revision needed',
        functions: Array.isArray(parsed['functions'])
          ? (parsed['functions'] as string[])
          : []
      }
    }

    if (parsed['type'] === 'execute' && parsed['function_name']) {
      const fnName = (parsed['function_name'] as string)
        .split(/[./]/)
        .filter(Boolean)
        .pop() || ''
      const fnConfig = toolFunctions[fnName]
      if (!fnConfig) {
        return {
          type: 'executed',
          execution: {
            function: `${effectiveToolkitId}.${effectiveToolId}.${fnName}`,
            status: 'error',
            observation: `Function "${fnName}" not found. Available: ${Object.keys(toolFunctions).join(', ')}.`
          }
        }
      }

      const toolInput = (parsed['tool_input'] as string) || '{}'
      return this.runToolExecution(
        effectiveToolkitId,
        effectiveToolId,
        fnName,
        toolInput,
        fnConfig
      )
    }

    return {
      type: 'executed',
      execution: {
        function: qualifiedName,
        status: 'error',
        observation: 'Could not resolve function from tool-level plan step.'
      }
    }
  }

  /**
   * Asks the LLM to fill tool_input for a known function, then executes it.
   * Uses native tool calling for supported providers (OpenRouter), falls back
   * to JSON mode for others. Retries on invalid input up to MAX_RETRIES_PER_FUNCTION.
   */
  private async executeFunction(
    toolkitId: string,
    toolId: string,
    functionName: string,
    functionConfig: {
      description: string
      parameters: Record<string, unknown>
      output_schema?: Record<string, unknown>
    },
    executionHistory: ExecutionRecord[]
  ): Promise<
    | { type: 'final', answer: string }
    | { type: 'replan', reason: string, functions: string[] }
    | {
        type: 'executed'
        execution: ExecutionRecord
        finalAnswer?: string
        missingSettingsMessage?: string
      }
  > {
    // --- Native tool calling path (OpenRouter) ---
    if (this.supportsNativeTools) {
      return this.executeFunctionWithNativeTools(
        toolkitId,
        toolId,
        functionName,
        functionConfig,
        executionHistory
      )
    }

    // --- JSON mode fallback (Local, Groq, Cerebras, etc.) ---
    return this.executeFunctionWithJSONMode(
      toolkitId,
      toolId,
      functionName,
      functionConfig,
      executionHistory
    )
  }

  /**
   * Uses native OpenAI-style tool calling to fill tool_input.
   * The LLM is forced to call the specific function via tool_choice.
   */
   
  private async executeFunctionWithNativeTools(
    toolkitId: string,
    toolId: string,
    functionName: string,
    functionConfig: {
      description: string
      parameters: Record<string, unknown>
    },
    executionHistory: ExecutionRecord[]
  ): Promise<
    | { type: 'final', answer: string }
    | { type: 'replan', reason: string, functions: string[] }
    | {
        type: 'executed'
        execution: ExecutionRecord
        finalAnswer?: string
        missingSettingsMessage?: string
      }
  > {
    const qualifiedName = `${toolkitId}.${toolId}.${functionName}`
    const historySection = this.formatExecutionHistory(executionHistory)
    const executeSystemPrompt = PERSONA.getCompactDutySystemPrompt(
      EXECUTE_SYSTEM_PROMPT
    )

    const tool: OpenAITool = {
      type: 'function',
      function: {
        name: functionName,
        description: functionConfig.description,
        parameters: functionConfig.parameters
      }
    }

    let retries = 0
    let lastError = ''

    while (retries <= MAX_RETRIES_PER_FUNCTION) {
      const retryNote = lastError
        ? `\n\nPrevious attempt failed: ${lastError}. Please fix the arguments.`
        : ''
      const prompt = `${historySection}\n\nUser Request: "${this.input}"${retryNote}`

      const result = await this.callLLMWithTools(
        prompt,
        executeSystemPrompt,
        [tool],
        { type: 'function', function: { name: functionName } }
      )

      if (!result) {
        retries += 1
        lastError = 'Failed to produce output'
        continue
      }

      // Model returned a tool call — extract and validate arguments
      if (result.toolCall) {
        const toolInput = result.toolCall.arguments || '{}'

        const inputValidation = this.validateToolInput(
          toolInput,
          functionConfig.parameters
        )
        if (!inputValidation.isValid) {
          retries += 1
          lastError =
            inputValidation.message || 'tool arguments do not match schema'
          continue
        }

        return this.runToolExecution(
          toolkitId,
          toolId,
          functionName,
          inputValidation.repairedToolInput ?? toolInput,
          functionConfig,
          inputValidation.parsedValue
        )
      }

      // Model responded with text instead of a tool call — parse for replan/final
      if (result.textContent) {
        const parsed = this.parseOutput(result.textContent)
        if (parsed?.['type'] === 'final' && parsed['answer']) {
          return { type: 'final', answer: parsed['answer'] as string }
        }
        if (parsed?.['type'] === 'replan') {
          return {
            type: 'replan',
            reason: (parsed['reason'] as string) || 'Plan revision needed',
            functions: Array.isArray(parsed['functions'])
              ? (parsed['functions'] as string[])
              : []
          }
        }
      }

      retries += 1
      lastError = 'Model did not produce a tool call'
    }

    return {
      type: 'executed',
      execution: {
        function: qualifiedName,
        status: 'error',
        observation: `Failed after ${MAX_RETRIES_PER_FUNCTION + 1} attempts: ${lastError}`
      }
    }
  }

  /**
   * JSON mode fallback for providers that do not support native tool calling.
   * The function signature is injected into the prompt text and the LLM
   * returns structured JSON with the tool_input.
   */
  private async executeFunctionWithJSONMode(
    toolkitId: string,
    toolId: string,
    functionName: string,
    functionConfig: {
      description: string
      parameters: Record<string, unknown>
    },
    executionHistory: ExecutionRecord[]
  ): Promise<
    | { type: 'final', answer: string }
    | { type: 'replan', reason: string, functions: string[] }
    | {
        type: 'executed'
        execution: ExecutionRecord
        finalAnswer?: string
        missingSettingsMessage?: string
      }
  > {
    const qualifiedName = `${toolkitId}.${toolId}.${functionName}`
    const paramsSchema = JSON.stringify(functionConfig.parameters)
    const historySection = this.formatExecutionHistory(executionHistory)
    const executeSystemPrompt = PERSONA.getCompactDutySystemPrompt(
      EXECUTE_SYSTEM_PROMPT
    )

    const executeSchema = {
      oneOf: [
        {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['execute'] },
            function_name: { type: 'string' },
            tool_input: { type: 'string' }
          },
          required: ['type', 'function_name', 'tool_input'],
          additionalProperties: false
        },
        {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['replan'] },
            functions: {
              type: 'array',
              items: { type: 'string' }
            },
            reason: { type: 'string' }
          },
          required: ['type', 'functions', 'reason'],
          additionalProperties: false
        },
        {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['final'] },
            answer: { type: 'string' }
          },
          required: ['type', 'answer'],
          additionalProperties: false
        }
      ]
    }

    let retries = 0
    let lastError = ''

    while (retries <= MAX_RETRIES_PER_FUNCTION) {
      const retryNote = lastError
        ? `\n\nPrevious attempt failed: ${lastError}. Please fix the tool_input.`
        : ''
      const prompt = `Function: ${qualifiedName}\nDescription: ${functionConfig.description}\nParameters: ${paramsSchema}\n\n${historySection}\n\nUser Request: "${this.input}"${retryNote}\n\nProvide the tool_input for this function.`

      const completionResult = await this.callLLM(
        prompt,
        executeSystemPrompt,
        executeSchema
      )
      const parsed = this.parseOutput(completionResult?.output)

      if (!parsed) {
        retries += 1
        lastError = 'Failed to produce valid output'
        continue
      }

      if (parsed['type'] === 'final' && parsed['answer']) {
        return { type: 'final', answer: parsed['answer'] as string }
      }

      if (parsed['type'] === 'replan') {
        return {
          type: 'replan',
          reason: (parsed['reason'] as string) || 'Plan revision needed',
          functions: Array.isArray(parsed['functions'])
            ? (parsed['functions'] as string[])
            : []
        }
      }

      if (parsed['type'] === 'execute') {
        const toolInput = (parsed['tool_input'] as string) || '{}'

        // Validate input
        const inputValidation = this.validateToolInput(
          toolInput,
          functionConfig.parameters
        )
        if (!inputValidation.isValid) {
          retries += 1
          lastError =
            inputValidation.message || 'tool_input does not match schema'
          continue
        }

        return this.runToolExecution(
          toolkitId,
          toolId,
          functionName,
          inputValidation.repairedToolInput ?? toolInput,
          functionConfig,
          inputValidation.parsedValue
        )
      }

      retries += 1
      lastError = 'Unexpected response type'
    }

    return {
      type: 'executed',
      execution: {
        function: qualifiedName,
        status: 'error',
        observation: `Failed after ${MAX_RETRIES_PER_FUNCTION + 1} attempts: ${lastError}`
      }
    }
  }

  /**
   * Actually executes a tool via TOOL_EXECUTOR and processes the result.
   */
  private async runToolExecution(
    toolkitId: string,
    toolId: string,
    functionName: string,
    toolInput: string,
    _functionConfig: {
      description: string
      parameters: Record<string, unknown>
    },
    parsedInput?: Record<string, unknown>
  ): Promise<{
    type: 'executed'
    execution: ExecutionRecord
    finalAnswer?: string
    missingSettingsMessage?: string
  }> {
    const qualifiedName = `${toolkitId}.${toolId}.${functionName}`

    const toolExecutionInput: {
      toolId: string
      toolkitId: string
      functionName: string
      toolInput: string
      parsedInput?: Record<string, unknown>
    } = {
      toolId,
      toolkitId,
      functionName,
      toolInput
    }

    if (parsedInput) {
      toolExecutionInput.parsedInput = parsedInput
    }

    // For bash commands, write the command to a temp script file so that
    // base-tool's escapeShellArg does not destroy shell metacharacters
    // (quotes, pipes, redirects, etc.). The bash tool receives a simple
    // file path instead of a raw command string.
    let bashScriptPath: string | null = null
    if (
      toolId === 'bash' &&
      functionName === 'executeBashCommand' &&
      toolExecutionInput.parsedInput?.['command']
    ) {
      const command = toolExecutionInput.parsedInput['command'] as string
      const scriptDir = join(tmpdir(), 'leon_bash_scripts')
      mkdirSync(scriptDir, { recursive: true })
      bashScriptPath = join(
        scriptDir,
        `cmd_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.sh`
      )
      writeFileSync(bashScriptPath, `${command}\nexit 0`, { mode: 0o755 })

      // Replace the command with the script path
      toolExecutionInput.parsedInput = {
        ...toolExecutionInput.parsedInput,
        command: bashScriptPath
      }
      toolExecutionInput.toolInput = JSON.stringify(
        toolExecutionInput.parsedInput
      )
    }

    LogHelper.title(this.name)
    LogHelper.debug(`Running tool: ${qualifiedName}`)
    LogHelper.debug(`Tool input: ${toolInput}`)

    const toolExecutionResult =
      await TOOL_EXECUTOR.executeTool(toolExecutionInput)

    // Clean up temp script
    if (bashScriptPath) {
      try {
        unlinkSync(bashScriptPath)
      } catch {
        // Ignore cleanup errors
      }
    }

    LogHelper.title(this.name)
    LogHelper.debug(
      `Tool result: ${qualifiedName} [${toolExecutionResult.status}] — ${toolExecutionResult.message}`
    )
    LogHelper.debug(
      `Tool output: ${JSON.stringify(toolExecutionResult.data?.output)}`
    )

    // Check for final_answer in tool result
    const finalAnswer =
      this.extractFinalAnswerFromToolResult(toolExecutionResult)
    if (finalAnswer) {
      return {
        type: 'executed',
        execution: {
          function: qualifiedName,
          status: 'success',
          observation: finalAnswer
        },
        finalAnswer
      }
    }

    // Check for missing settings
    const missingSettings =
      toolExecutionResult.status === 'error'
        ? (toolExecutionResult.data.output?.['missing_settings'] as
            | string[]
            | undefined)
        : undefined
    const settingsPath =
      toolExecutionResult.status === 'error'
        ? (toolExecutionResult.data.output?.['settings_path'] as
            | string
            | undefined)
        : undefined
    if (missingSettings && missingSettings.length > 0 && settingsPath) {
      const formattedPath = formatFilePath(settingsPath)
      return {
        type: 'executed',
        execution: {
          function: qualifiedName,
          status: 'error',
          observation: `Missing settings: ${missingSettings.join(', ')}`
        },
        missingSettingsMessage: `Missing tool settings: ${missingSettings.join(
          ', '
        )}. Please set them in ${formattedPath}.`
      }
    }

    const observation = JSON.stringify({
      status: toolExecutionResult.status,
      message: toolExecutionResult.message,
      data: toolExecutionResult.data
    })

    return {
      type: 'executed',
      execution: {
        function: qualifiedName,
        status: toolExecutionResult.status,
        observation
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Phase 3: Final answer synthesis
  // ---------------------------------------------------------------------------

  private async runFinalAnswerPhase(
    executionHistory: ExecutionRecord[]
  ): Promise<string> {
    LogHelper.title(this.name)
    LogHelper.debug('Synthesizing final answer from execution history...')

    const historySection = this.formatExecutionHistory(executionHistory)
    const systemPrompt = PERSONA.getCompactDutySystemPrompt(
      `You are synthesizing a final answer from tool execution results. Provide a clear, helpful, and complete response to the user based on the observations collected. Always include relevant details from the tool results.\n\n${FORMATTING_RULES}`
    )
    const prompt = `${historySection}\n\nUser Request: "${this.input}"\n\nBased on the execution results above, provide a final answer to the user.`

    // Use native tool calling for remote providers to get a proper answer
    if (this.supportsNativeTools) {
      const answerTool: OpenAITool = {
        type: 'function',
        function: {
          name: 'provide_answer',
          description:
            'Provide the final answer to the user. Include all relevant details from the tool execution results. Use plain text only, no markdown.',
          parameters: {
            type: 'object',
            properties: {
              answer: {
                type: 'string',
                description:
                  'A clear, complete, and helpful plain text answer (no markdown) to the user request based on the tool results. Wrap any file paths with [FILE_PATH]/path[/FILE_PATH].'
              }
            },
            required: ['answer']
          }
        }
      }

      const result = await this.callLLMWithTools(
        prompt,
        systemPrompt,
        [answerTool],
        { type: 'function', function: { name: 'provide_answer' } }
      )

      if (result?.toolCall) {
        try {
          const parsed = JSON.parse(result.toolCall.arguments)
          if (typeof parsed.answer === 'string' && parsed.answer.trim()) {
            return parsed.answer.trim()
          }
        } catch {
          // Fall through
        }
      }

      // If the model responded with text instead
      if (result?.textContent?.trim()) {
        return result.textContent.trim()
      }
    } else {
      // Local provider: use JSON mode
      const finalSchema = {
        type: 'object',
        properties: {
          answer: { type: 'string' }
        },
        required: ['answer'],
        additionalProperties: false
      }

      const completionResult = await this.callLLM(
        prompt,
        systemPrompt,
        finalSchema
      )

      if (completionResult?.output) {
        const parsed = this.parseOutput(completionResult.output)
        if (parsed?.['answer']) {
          return parsed['answer'] as string
        }
        if (typeof completionResult.output === 'string') {
          return completionResult.output.trim()
        }
      }
    }

    // Last resort: summarize from execution history
    const lastSuccess = executionHistory
      .filter((e) => e.status === 'success')
      .pop()
    if (lastSuccess) {
      return lastSuccess.observation
    }

    return 'I completed the requested actions but could not generate a summary.'
  }

  // ---------------------------------------------------------------------------
  // Helpers
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

  private formatExecutionHistory(history: ExecutionRecord[]): string {
    if (history.length === 0) {
      return 'Previous Executions: none'
    }
    return `Previous Executions:\n${history
      .map(
        (exec, i) =>
          `Step ${i + 1}: ${exec.function} [${exec.status}]\n  Observation: ${exec.observation}`
      )
      .join('\n')}`
  }

  /**
   * Parses plan steps from raw tool call arguments (array of objects).
   * Handles missing labels gracefully.
   */
  private parseStepsFromArgs(
    rawSteps: Record<string, unknown>[]
  ): PlanStep[] {
    return rawSteps
      .filter(
        (s) =>
          typeof s['function'] === 'string' &&
          (s['function'] as string).trim()
      )
      .map((s) => ({
        function: (s['function'] as string).trim(),
        label:
          typeof s['label'] === 'string' && (s['label'] as string).trim()
            ? (s['label'] as string).trim()
            : (s['function'] as string).trim()
      }))
  }

  /**
   * Extracts a plan or final answer from a parsed output object.
   * Handles the common patterns: type=plan with steps, type=final with answer,
   * and the fallback of extracting function references from the summary.
   */
  private extractPlanFromParsed(
    parsed: Record<string, unknown> | null
  ): { type: 'plan', steps: PlanStep[], summary: string } | { type: 'final', answer: string } | null {
    if (!parsed) {
      return null
    }

    if (parsed['type'] === 'final' && parsed['answer']) {
      return { type: 'final', answer: parsed['answer'] as string }
    }

    if (parsed['type'] === 'plan') {
      let steps: PlanStep[] = []

      if (
        Array.isArray(parsed['steps']) &&
        (parsed['steps'] as unknown[]).length > 0
      ) {
        steps = this.parseStepsFromArgs(
          parsed['steps'] as Record<string, unknown>[]
        )
      }

      // If steps array is empty but the summary mentions function references
      // (common with local/smaller models), extract them from the summary
      if (steps.length === 0) {
        const summary =
          typeof parsed['summary'] === 'string'
            ? (parsed['summary'] as string)
            : ''

        if (summary) {
          LogHelper.title(this.name)
          LogHelper.debug(
            'Planning: steps array is empty, attempting to extract functions from summary'
          )

          const functionPattern = /([a-z_]+\.[a-z_]+\.[a-zA-Z_]+)/g
          const matches = summary.match(functionPattern)
          if (matches) {
            steps = [...new Set(matches)].map((fn) => ({
              function: fn,
              label: fn
            }))
            LogHelper.debug(
              `Extracted ${steps.length} function(s) from summary: ${steps.map((s) => s.function).join(', ')}`
            )
          }
        }
      }

      if (steps.length > 0) {
        const summary =
          typeof parsed['summary'] === 'string'
            ? (parsed['summary'] as string)
            : ''
        return { type: 'plan', steps, summary }
      }
    }

    return null
  }

  private async emitProgress(message: string): Promise<void> {
    if (!message) {
      return
    }
    await BRAIN.talk(message)
  }

  /**
   * Emits or updates the plan widget via socket. On first call it creates
   * a new message; subsequent calls replace the same message using
   * replaceMessageId so the plan list updates in-place.
   */
  private emitPlanWidget(
    steps: TrackedPlanStep[],
    justCompletedIndex: number | null,
    planWidgetId: string,
    isUpdate: boolean
  ): void {
    const componentTree = buildPlanComponentTree(steps, justCompletedIndex)
    const widgetData: Record<string, unknown> = {
      id: planWidgetId,
      widget: 'PlanWidget',
      componentTree,
      supportedEvents: []
    }

    if (isUpdate) {
      widgetData['replaceMessageId'] = planWidgetId
    }

    SOCKET_SERVER.socket?.emit('answer', widgetData)
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

  /**
   * Parses raw LLM output into a structured object, handling both JSON
   * objects from structured output and string responses from remote providers.
   */
  private parseOutput(
    rawOutput: unknown
  ): Record<string, unknown> | null {
    if (!rawOutput) {
      return null
    }

    if (typeof rawOutput === 'object' && !Array.isArray(rawOutput)) {
      return rawOutput as Record<string, unknown>
    }

    if (typeof rawOutput !== 'string') {
      return null
    }

    const trimmed = rawOutput.trim()
    if (!trimmed) {
      return null
    }

    // Try tagged JSON
    const taggedJson = this.extractTaggedJson(trimmed)
    if (taggedJson) {
      try {
        return JSON.parse(taggedJson)
      } catch {
        // Continue
      }
    }

    // Try direct JSON parse
    try {
      return JSON.parse(trimmed)
    } catch {
      // Continue
    }

    // Try extracting JSON substring
    const extracted = this.extractJsonSubstring(trimmed)
    if (extracted) {
      try {
        const parsed = JSON.parse(extracted)
        if (Array.isArray(parsed)) {
          const first = parsed[0]
          if (first && typeof first === 'object') {
            return first as Record<string, unknown>
          }
          return null
        }
        return parsed
      } catch {
        // Continue
      }
    }

    return null
  }

  // ---------------------------------------------------------------------------
  // Validation (kept from original)
  // ---------------------------------------------------------------------------

  private validateToolInput(
    toolInput: string,
    parameters: Record<string, unknown> | null
  ): {
    isValid: boolean
    message?: string
    repairedToolInput?: string
    parsedValue?: Record<string, unknown>
  } {
    if (!parameters) {
      return {
        isValid: false,
        message: 'No parameters schema found for this function.'
      }
    }

    let parsed: unknown = null
    let parsedFromRepair: { repaired: string, value: unknown } | null = null
    try {
      parsed = JSON.parse(toolInput)
    } catch {
      parsedFromRepair = this.tryRepairToolInput(toolInput)
      if (!parsedFromRepair) {
        return {
          isValid: false,
          message: 'tool_input must be valid JSON.'
        }
      }
      parsed = parsedFromRepair.value
    }

    const validateSchema = (
      schema: Record<string, unknown>,
      value: unknown
    ): boolean => {
      if (schema['oneOf'] && Array.isArray(schema['oneOf'])) {
        return schema['oneOf'].some((candidate) => {
          if (candidate && typeof candidate === 'object') {
            return validateSchema(candidate as Record<string, unknown>, value)
          }
          return false
        })
      }

      const schemaType = schema['type']
      if (schemaType === 'object') {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          return false
        }

        const required = Array.isArray(schema['required'])
          ? (schema['required'] as string[])
          : []
        for (const key of required) {
          if (!(key in (value as Record<string, unknown>))) {
            return false
          }
        }

        const properties = schema['properties']
        if (properties && typeof properties === 'object') {
          for (const [key, propSchema] of Object.entries(properties)) {
            if (
              key in (value as Record<string, unknown>) &&
              propSchema &&
              typeof propSchema === 'object'
            ) {
              const propValue = (value as Record<string, unknown>)[key]
              if (
                !validateSchema(
                  propSchema as Record<string, unknown>,
                  propValue
                )
              ) {
                return false
              }
            }
          }
        }

        return true
      }

      if (schemaType === 'array') {
        if (!Array.isArray(value)) {
          return false
        }
        const items = schema['items']
        if (items && typeof items === 'object') {
          return value.every((item) =>
            validateSchema(items as Record<string, unknown>, item)
          )
        }
        return true
      }

      if (schemaType === 'string') {
        return typeof value === 'string'
      }
      if (schemaType === 'number') {
        return typeof value === 'number' && Number.isFinite(value)
      }
      if (schemaType === 'boolean') {
        return typeof value === 'boolean'
      }

      return true
    }

    const isValid = validateSchema(parameters, parsed)
    if (!isValid) {
      return {
        isValid: false,
        message: 'tool_input does not match the function parameters schema.'
      }
    }

    const result: {
      isValid: boolean
      repairedToolInput?: string
      parsedValue?: Record<string, unknown>
    } = {
      isValid: true
    }
    if (parsedFromRepair?.repaired) {
      result.repairedToolInput = parsedFromRepair.repaired
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      result.parsedValue = parsed as Record<string, unknown>
    }
    return result
  }

  private tryRepairToolInput(
    toolInput: string
  ): { repaired: string, value: unknown } | null {
    const repaired = this.repairJsonStringLiterals(toolInput)
    if (repaired === toolInput) {
      return null
    }

    try {
      const value = JSON.parse(repaired)
      return { repaired, value }
    } catch {
      return null
    }
  }

  private repairJsonStringLiterals(input: string): string {
    let inString = false
    let escaped = false
    let result = ''

    const isValidEscape = (char: string): boolean => {
      return (
        char === '"' ||
        char === '\\' ||
        char === '/' ||
        char === 'b' ||
        char === 'f' ||
        char === 'n' ||
        char === 'r' ||
        char === 't' ||
        char === 'u'
      )
    }

    const nextNonSpace = (value: string, start: number): string => {
      for (let i = start; i < value.length; i += 1) {
        const char = value[i]
        if (char && !/\s/.test(char)) {
          return char
        }
      }
      return ''
    }

    for (let i = 0; i < input.length; i += 1) {
      const char = input[i]

      if (!inString) {
        if (char === '"') {
          inString = true
        }
        result += char
        continue
      }

      if (escaped) {
        result += char
        escaped = false
        continue
      }

      if (char === '\\') {
        const nextChar = input[i + 1]
        if (nextChar && isValidEscape(nextChar)) {
          result += char
          escaped = true
          continue
        }
        result += '\\\\'
        continue
      }

      if (char === '"') {
        const nextChar = nextNonSpace(input, i + 1)
        const isTerminator =
          nextChar === '' ||
          nextChar === ',' ||
          nextChar === '}' ||
          nextChar === ']' ||
          nextChar === ':'
        if (isTerminator) {
          inString = false
          result += char
          continue
        }
        result += '\\"'
        continue
      }

      result += char
    }

    return result
  }

  // ---------------------------------------------------------------------------
  // Output parsing helpers (kept from original)
  // ---------------------------------------------------------------------------

  private extractTaggedJson(input: string): string | null {
    const tagMatch = input.match(/\[(TOOL|TOOLKIT|FUNCTION|FINAL|PLAN|EXECUTE|REPLAN)\]/i)
    if (!tagMatch || tagMatch.index === undefined) {
      return null
    }

    const startIndex = tagMatch.index + tagMatch[0].length
    const rest = input.slice(startIndex).trim()
    return this.extractJsonSubstring(rest)
  }

  private extractJsonSubstring(input: string): string | null {
    const firstBrace = input.indexOf('{')
    const firstBracket = input.indexOf('[')
    let startIndex = -1
    let endIndex = -1

    if (firstBrace !== -1 && firstBracket !== -1) {
      startIndex = Math.min(firstBrace, firstBracket)
    } else {
      startIndex = Math.max(firstBrace, firstBracket)
    }

    if (startIndex === -1) {
      return null
    }

    if (input[startIndex] === '{') {
      endIndex = input.lastIndexOf('}')
    } else {
      endIndex = input.lastIndexOf(']')
    }

    if (endIndex <= startIndex) {
      return null
    }

    return input.slice(startIndex, endIndex + 1)
  }

  private extractFinalAnswerFromToolResult(toolExecutionResult: {
    status: string
    data?: {
      output?: Record<string, unknown>
    }
  }): string | null {
    if (toolExecutionResult.status !== 'success') {
      return null
    }

    const output = toolExecutionResult.data?.output || {}
    const finalAnswer = output['final_answer']
    if (typeof finalAnswer === 'string' && finalAnswer.trim()) {
      return finalAnswer
    }
    const answer = output['answer']
    if (typeof answer === 'string' && answer.trim()) {
      return answer
    }
    return null
  }
}
