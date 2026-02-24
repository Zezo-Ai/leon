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
const CATALOG_TOKEN_BUDGET = 2000
const CHARS_PER_TOKEN = 4

const PLAN_SYSTEM_PROMPT = `You are an autonomous planning and acting agent. Your goal is to solve the user's request.

You have access to a catalog of available tools and functions. Your job is to:
1. Analyze the user request
2. Select the functions (or tools) you need to call, in order
3. Provide a short natural language summary of your plan for the user

Only use functions/tools that are listed in the catalog. If no function/tool is relevant, provide a direct answer.

Prefer dedicated tools over the operating_system_control toolkit.
You must always consider other tools before using the operating_system_control toolkit. Use the operating_system_control toolkit and bash tool only as a last resort when no suitable tool exists.

If your answers include a file path, wrap it as [FILE_PATH]/the_path_here[/FILE_PATH].

Return ONLY one of the following JSON shapes:
- {"type":"plan","steps":[{"function":"toolkit_id.tool_id.function_name"},...],"summary":"..."}
- {"type":"final","answer":"..."}

"steps" is an ordered array of functions to call. Each step has a "function" field with the fully qualified name (toolkit_id.tool_id.function_name).
If the catalog only lists tools (without functions), use the format toolkit_id.tool_id in the "function" field.
"summary" is a short natural language description of the plan for the user.

No other keys, no null values.`

const EXECUTE_SYSTEM_PROMPT = `You are an autonomous acting agent executing a plan step by step.

You are now executing a specific function. You are given the function signature with its parameters.
Fill in the tool_input based on the user request and any observations from previous steps.

When chaining tools, reuse fields from the latest observation to fill the next tool_input whenever possible.

When the next action is based on uncertainty, assumptions, ambiguous selection, or could be irreversible, ask for confirmation before executing the tool.

tool_input must be a JSON string.

If your answers include a file path, wrap it as [FILE_PATH]/the_path_here[/FILE_PATH].

Return ONLY one of the following JSON shapes:
- {"type":"execute","function_name":"...","tool_input":"{...}"}
- {"type":"replan","functions":["toolkit_id.tool_id.function_name",...],"reason":"..."}
- {"type":"final","answer":"..."}

No other keys, no null values.`

const RESOLVE_FUNCTION_SYSTEM_PROMPT = `You are selecting a function from a tool to execute.

You are given the available functions for a specific tool. Choose the most appropriate function for the current step and provide the tool_input.

tool_input must be a JSON string.

If your answers include a file path, wrap it as [FILE_PATH]/the_path_here[/FILE_PATH].

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
}

interface ExecutionRecord {
  function: string
  status: string
  observation: string
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
      LogHelper.debug(`Catalog mode: ${catalog.mode} | Input: "${this.input}"`)
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

      // --- Phase 2: Execution loop ---
      LogHelper.title(this.name)
      LogHelper.debug('Phase 2: Execution loop...')

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

          await this.emitProgress(
            `Adjusting plan: ${stepResult.reason}. New steps: ${stepResult.functions.join(', ')}`
          )
          pendingSteps = stepResult.functions.map((f) => ({ function: f }))
          continue
        }

        // Record execution
        executionHistory.push(stepResult.execution)

        LogHelper.title(this.name)
        LogHelper.debug(
          `Execution result: ${stepResult.execution.function} [${stepResult.execution.status}] | Observation: ${stepResult.execution.observation.slice(0, 300)}`
        )

        // Emit progress
        const nextStep = pendingSteps[0]
        const progressMsg = nextStep
          ? `Completed: ${stepResult.execution.function}. Next: ${nextStep.function}`
          : `Completed: ${stepResult.execution.function}. Preparing final answer...`
        await this.emitProgress(progressMsg)

        // Check for short-circuit final answer from tool result
        if (stepResult.finalAnswer) {
          LogHelper.title(this.name)
          LogHelper.debug(`Tool returned final_answer, short-circuiting: "${stepResult.finalAnswer.slice(0, 200)}"`)
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
          functionLines.push(
            `- ${tool.toolkitId}.${tool.toolId}.${fnName}: ${fnConfig.description}`
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
                  function: { type: 'string' }
                },
                required: ['function'],
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

    let completionResult
    if (LLM_PROVIDER_NAME === LLMProviders.Local) {
      completionResult = await LLM_PROVIDER.prompt(prompt, {
        ...completionParams,
        session: ReActLLMDuty.session
      })
    } else {
      completionResult = await LLM_PROVIDER.prompt(prompt, completionParams)
    }

    LogHelper.title(this.name)
    LogHelper.debug(`Planning prompt: "${prompt.slice(0, 300)}..."`)
    LogHelper.debug(`Planning raw output: ${JSON.stringify(completionResult?.output).slice(0, 500)}`)

    const parsed = this.parseOutput(completionResult?.output)
    if (!parsed) {
      // If the LLM couldn't produce structured output, treat raw as final answer
      LogHelper.title(this.name)
      LogHelper.debug('Planning: failed to parse structured output, treating as final answer')
      const raw =
        typeof completionResult?.output === 'string'
          ? completionResult.output.trim()
          : ''
      return { type: 'final', answer: raw || 'I could not understand how to help with that request.' }
    }

    if (parsed['type'] === 'final' && parsed['answer']) {
      LogHelper.title(this.name)
      LogHelper.debug('Planning: LLM chose to answer directly (no tools needed)')
      return { type: 'final', answer: parsed['answer'] as string }
    }

    if (
      parsed['type'] === 'plan' &&
      Array.isArray(parsed['steps']) &&
      (parsed['steps'] as unknown[]).length > 0
    ) {
      const rawSteps = parsed['steps'] as Record<string, unknown>[]
      const steps = rawSteps
        .filter(
          (s) =>
            typeof s['function'] === 'string' && (s['function'] as string).trim()
        )
        .map((s) => ({
          function: (s['function'] as string).trim()
        }))

      if (steps.length > 0) {
        const summary =
          typeof parsed['summary'] === 'string' ? (parsed['summary'] as string) : ''
        if (summary) {
          await this.emitProgress(summary)
        }
        return { type: 'plan', steps, summary }
      }
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

    LogHelper.title(this.name)
    LogHelper.debug(
      `Running tool: ${qualifiedName} | Input: ${toolInput.slice(0, 200)}`
    )

    const toolExecutionResult =
      await TOOL_EXECUTOR.executeTool(toolExecutionInput)

    LogHelper.title(this.name)
    LogHelper.debug(
      `Tool result: ${qualifiedName} [${toolExecutionResult.status}] — ${toolExecutionResult.message}`
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
      'You are synthesizing a final answer from tool execution results. Provide a clear, helpful response to the user based on the observations collected.\n\nIf your answers include a file path, wrap it as [FILE_PATH]/the_path_here[/FILE_PATH].'
    )
    const prompt = `${historySection}\n\nUser Request: "${this.input}"\n\nBased on the execution results above, provide a final answer to the user.`

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
    schema: Record<string, unknown>
  ): Promise<{
    output: unknown
    usedInputTokens?: number
    usedOutputTokens?: number
  } | null> {
    const completionParams = {
      dutyType: LLMDuties.ReAct,
      systemPrompt,
      data: schema,
      temperature: REACT_TEMPERATURE
    }

    if (LLM_PROVIDER_NAME === LLMProviders.Local) {
      return LLM_PROVIDER.prompt(prompt, {
        ...completionParams,
        session: ReActLLMDuty.session
      })
    }

    return LLM_PROVIDER.prompt(prompt, completionParams)
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
    toolChoice: OpenAIToolChoice
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
      toolChoice
    })

    if (!completionResult) {
      LogHelper.debug('callLLMWithTools: no completion result returned')
      return null
    }

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
