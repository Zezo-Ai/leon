import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { LogHelper } from '@/helpers/log-helper'
import {
  PERSONA,
  TOOLKIT_REGISTRY,
  TOOL_EXECUTOR
} from '@/core'
import type { OpenAITool } from '@/core/llm-manager/types'
import type { MessageLog } from '@/types'

import {
  CATALOG_TOKEN_BUDGET,
  CHARS_PER_TOKEN,
  FORMATTING_RULES,
  PLAN_SYSTEM_PROMPT,
  EXECUTE_SYSTEM_PROMPT,
  RESOLVE_FUNCTION_SYSTEM_PROMPT,
  MAX_RETRIES_PER_FUNCTION,
  MAX_TOOL_FAILURE_RETRIES
} from './constants'
import type {
  PlanStep,
  ExecutionRecord,
  Catalog,
  PlanResult,
  ExecutionStepResult,
  ToolExecutionResult,
  LLMCaller,
  FunctionConfig
} from './types'
import {
  isToolLevel,
  formatExecutionHistory,
  parseStepsFromArgs,
  extractPlanFromParsed,
  parseOutput,
  validateToolInput,
  extractFinalAnswerFromToolResult,
  formatFilePath
} from './utils'

const DUTY_NAME = 'ReAct LLM Duty'

// ---------------------------------------------------------------------------
// Catalog building
// ---------------------------------------------------------------------------

export function buildCatalog(): Catalog {
  const flattenedTools = TOOLKIT_REGISTRY.getFlattenedTools()

  // First try function-level catalog
  const functionLines: string[] = []
  for (const tool of flattenedTools) {
    const toolFunctions = TOOLKIT_REGISTRY.getToolFunctions(
      tool.toolkitId,
      tool.toolId
    )
    if (toolFunctions) {
      for (const [fnName, fnConfig] of Object.entries(toolFunctions) as [string, FunctionConfig][]) {
        // Include required parameter names so the model can reason about
        // data flow between steps (e.g. search returns a URL -> download needs a URL)
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

export async function runPlanningPhase(
  caller: LLMCaller,
  catalog: Catalog,
  history: MessageLog[]
): Promise<PlanResult> {
  const catalogNote =
    catalog.mode === 'tool'
      ? '\nNote: The catalog lists tools, not individual functions. Use the format toolkit_id.tool_id in your plan steps.'
      : ''
  const planSystemPrompt = PERSONA.getCompactDutySystemPrompt(
    PLAN_SYSTEM_PROMPT
  )
  const prompt = `${catalog.text}${catalogNote}\n\nUser Request: "${caller.input}"`

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

  // --- Remote providers: use native tool calling to force structured output ---
  if (caller.supportsNativeTools) {
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
    const toolResult = await caller.callLLMWithTools(
      prompt,
      planSystemPrompt,
      planTools,
      { type: 'function', function: { name: 'create_plan' } },
      history
    )

    LogHelper.title(DUTY_NAME)
    LogHelper.debug(`Planning prompt: "${prompt.slice(0, 300)}..."`)
    LogHelper.debug(
      `Planning tool result: ${JSON.stringify(toolResult).slice(0, 500)}`
    )

    if (toolResult?.toolCall) {
      try {
        if (toolResult.toolCall.functionName !== 'create_plan') {
          LogHelper.debug(
            `Planning: unexpected tool call "${toolResult.toolCall.functionName}", falling back to JSON mode`
          )
        } else {
        const parsedArgs = JSON.parse(toolResult.toolCall.arguments)
        if (Array.isArray(parsedArgs.steps)) {
          const steps = parseStepsFromArgs(parsedArgs.steps)
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
        }
      } catch {
        LogHelper.debug('Planning: failed to parse create_plan arguments')
      }
    }

    // Fallback: if the model returned text instead of a tool call
    if (toolResult?.textContent) {
      const parsed = parseOutput(toolResult.textContent)
      const fallbackResult = extractPlanFromParsed(parsed)
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

    // Final fallback: JSON mode planning
    const jsonModeResult = await caller.callLLM(
      prompt,
      planSystemPrompt,
      planSchema,
      history
    )
    const parsed = parseOutput(jsonModeResult?.output)
    const planResult = extractPlanFromParsed(parsed)
    if (planResult) {
      return planResult
    }

    const raw =
      typeof jsonModeResult?.output === 'string'
        ? jsonModeResult.output.trim()
        : ''
    return { type: 'final', answer: raw || 'I could not determine what to do.' }
  }

  // --- Local provider: use grammar-constrained JSON mode ---
  const completionResult = await caller.callLLM(
    prompt,
    planSystemPrompt,
    planSchema,
    history
  )

  LogHelper.title(DUTY_NAME)
  LogHelper.debug(`Planning prompt: "${prompt.slice(0, 300)}..."`)
  LogHelper.debug(
    `Planning raw output: ${JSON.stringify(completionResult?.output).slice(0, 500)}`
  )

  const parsed = parseOutput(completionResult?.output)
  const planResult = extractPlanFromParsed(parsed)
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

export async function runExecutionStep(
  caller: LLMCaller,
  step: PlanStep,
  executionHistory: ExecutionRecord[],
  catalog: Catalog
): Promise<ExecutionStepResult> {
  const qualifiedName = step.function
  const parts = qualifiedName.split('.')

  // If the plan only has tool-level references (from tool-level catalog),
  // we need an extra resolution step to pick the right function.
  if (isToolLevel(qualifiedName) || catalog.mode === 'tool') {
    return runToolLevelExecution(
      caller,
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
  return executeFunction(
    caller,
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
async function runToolLevelExecution(
  caller: LLMCaller,
  qualifiedName: string,
  parts: string[],
  executionHistory: ExecutionRecord[],
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _catalog: Catalog
): Promise<ExecutionStepResult> {
  const toolkitId = parts[0] || ''
  const toolId = parts[1] || parts[0] || ''

  LogHelper.title(DUTY_NAME)
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

  const functionEntries = Object.entries(toolFunctions) as [string, FunctionConfig][]

  // If only one function, auto-select it
  if (functionEntries.length === 1) {
    const [fnName, fnConfig] = functionEntries[0]!
    LogHelper.debug(`Auto-selecting only function: ${fnName}`)
    return executeFunction(
      caller,
      effectiveToolkitId,
      effectiveToolId,
      fnName,
      fnConfig,
      executionHistory
    )
  }

  // Multiple functions — ask the LLM to pick one and provide input

  // --- Native tool calling path (OpenRouter) ---
  if (caller.supportsNativeTools) {
    return resolveToolFunctionWithNativeTools(
      caller,
      qualifiedName,
      effectiveToolkitId,
      effectiveToolId,
      toolFunctions as Record<string, FunctionConfig>,
      executionHistory
    )
  }

  // --- JSON mode fallback ---
  return resolveToolFunctionWithJSONMode(
    caller,
    qualifiedName,
    effectiveToolkitId,
    effectiveToolId,
    toolFunctions as Record<string, FunctionConfig>,
    functionEntries,
    executionHistory
  )
}

/**
 * Uses native tool calling with tool_choice='auto' to let the model pick
 * the right function from multiple options and provide arguments.
 */
async function resolveToolFunctionWithNativeTools(
  caller: LLMCaller,
  qualifiedName: string,
  toolkitId: string,
  toolId: string,
  toolFunctions: Record<string, FunctionConfig>,
  executionHistory: ExecutionRecord[]
): Promise<ExecutionStepResult> {
  const historySection = formatExecutionHistory(executionHistory)
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

  const prompt = `Tool: ${toolkitId}.${toolId}\n\n${historySection}\n\nUser Request: "${caller.input}"\n\nSelect the appropriate function and provide arguments.`

  const result = await caller.callLLMWithTools(
    prompt,
    resolveSystemPrompt,
    tools,
    'auto',
    caller.history
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
    return runToolExecution(
      toolkitId,
      toolId,
      fnName,
      toolInput,
      fnConfig
    )
  }

  // Text content fallback — parse for replan/final
  if (result.textContent) {
    const parsed = parseOutput(result.textContent)
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
async function resolveToolFunctionWithJSONMode(
  caller: LLMCaller,
  qualifiedName: string,
  effectiveToolkitId: string,
  effectiveToolId: string,
  toolFunctions: Record<string, FunctionConfig>,
  functionEntries: [string, FunctionConfig][],
  executionHistory: ExecutionRecord[]
): Promise<ExecutionStepResult> {
  const functionsSection = functionEntries
    .map(([fnName, fnConfig]) => {
      const params = JSON.stringify(fnConfig.parameters)
      return `- ${fnName}: ${fnConfig.description} ${params}`
    })
    .join('\n')

  const historySection = formatExecutionHistory(executionHistory)
  const resolveSystemPrompt = PERSONA.getCompactDutySystemPrompt(
    RESOLVE_FUNCTION_SYSTEM_PROMPT
  )
  const prompt = `Tool: ${effectiveToolkitId}.${effectiveToolId}\n\nAvailable Functions:\n${functionsSection}\n\n${historySection}\n\nUser Request: "${caller.input}"\n\nSelect the appropriate function and provide tool_input.`

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

  const completionResult = await caller.callLLM(
    prompt,
    resolveSystemPrompt,
    resolveSchema,
    caller.history
  )
  const parsed = parseOutput(completionResult?.output)

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
    return runToolExecution(
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
async function executeFunction(
  caller: LLMCaller,
  toolkitId: string,
  toolId: string,
  functionName: string,
  functionConfig: FunctionConfig,
  executionHistory: ExecutionRecord[]
): Promise<ExecutionStepResult> {
  // --- Native tool calling path (OpenRouter) ---
  if (caller.supportsNativeTools) {
    return executeFunctionWithNativeTools(
      caller,
      toolkitId,
      toolId,
      functionName,
      functionConfig,
      executionHistory
    )
  }

  // --- JSON mode fallback (Local, Groq, Cerebras, etc.) ---
  return executeFunctionWithJSONMode(
    caller,
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
async function executeFunctionWithNativeTools(
  caller: LLMCaller,
  toolkitId: string,
  toolId: string,
  functionName: string,
  functionConfig: FunctionConfig,
  executionHistory: ExecutionRecord[]
): Promise<ExecutionStepResult> {
  const qualifiedName = `${toolkitId}.${toolId}.${functionName}`
  const historySection = formatExecutionHistory(executionHistory)
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
  let toolFailureRetries = 0

  while (retries <= MAX_RETRIES_PER_FUNCTION) {
    const retryNote = lastError
      ? `\n\nPrevious attempt failed: ${lastError}. Please fix the arguments.`
      : ''
    const prompt = `${historySection}\n\nUser Request: "${caller.input}"${retryNote}`

    const result = await caller.callLLMWithTools(
      prompt,
      executeSystemPrompt,
      [tool],
      { type: 'function', function: { name: functionName } },
      caller.history
    )

    if (!result) {
      retries += 1
      lastError = 'Failed to produce output'
      continue
    }

    // Model returned a tool call — extract and validate arguments
    if (result.toolCall) {
      const toolInput = result.toolCall.arguments || '{}'

      const inputValidation = validateToolInput(
        toolInput,
        functionConfig.parameters
      )
      if (!inputValidation.isValid) {
        retries += 1
        lastError =
          inputValidation.message || 'tool arguments do not match schema'
        continue
      }

      const toolResult = await runToolExecution(
        toolkitId,
        toolId,
        functionName,
        inputValidation.repairedToolInput ?? toolInput,
        functionConfig,
        inputValidation.parsedValue
      )

      if (toolResult.missingSettingsMessage) {
        return toolResult
      }

      if (toolResult.finalAnswer) {
        return toolResult
      }

      if (toolResult.execution.status === 'error') {
        if (toolFailureRetries < 2) {
          toolFailureRetries += 1
          lastError = `Tool execution failed: ${toolResult.execution.observation}`
          continue
        }
      }

      return toolResult
    }

    // Model responded with text instead of a tool call — parse for replan/final
    if (result.textContent) {
      const parsed = parseOutput(result.textContent)
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
async function executeFunctionWithJSONMode(
  caller: LLMCaller,
  toolkitId: string,
  toolId: string,
  functionName: string,
  functionConfig: FunctionConfig,
  executionHistory: ExecutionRecord[]
): Promise<ExecutionStepResult> {
  const qualifiedName = `${toolkitId}.${toolId}.${functionName}`
  const paramsSchema = JSON.stringify(functionConfig.parameters)
  const historySection = formatExecutionHistory(executionHistory)
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
  let toolFailureRetries = 0

  while (retries <= MAX_RETRIES_PER_FUNCTION) {
    const retryNote = lastError
      ? `\n\nPrevious attempt failed: ${lastError}. Please fix the tool_input.`
      : ''
    const prompt = `Function: ${qualifiedName}\nDescription: ${functionConfig.description}\nParameters: ${paramsSchema}\n\n${historySection}\n\nUser Request: "${caller.input}"${retryNote}\n\nProvide the tool_input for this function.`

    const completionResult = await caller.callLLM(
      prompt,
      executeSystemPrompt,
      executeSchema,
      caller.history
    )
    const parsed = parseOutput(completionResult?.output)

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
      const inputValidation = validateToolInput(
        toolInput,
        functionConfig.parameters
      )
      if (!inputValidation.isValid) {
        retries += 1
        lastError =
          inputValidation.message || 'tool_input does not match schema'
        continue
      }

      const toolResult = await runToolExecution(
        toolkitId,
        toolId,
        functionName,
        inputValidation.repairedToolInput ?? toolInput,
        functionConfig,
        inputValidation.parsedValue
      )

      if (toolResult.missingSettingsMessage) {
        return toolResult
      }

      if (toolResult.finalAnswer) {
        return toolResult
      }

      if (toolResult.execution.status === 'error') {
        if (toolFailureRetries < MAX_TOOL_FAILURE_RETRIES) {
          toolFailureRetries += 1
          lastError = `Tool execution failed: ${toolResult.execution.observation}`
          continue
        }
      }

      return toolResult
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
export async function runToolExecution(
  toolkitId: string,
  toolId: string,
  functionName: string,
  toolInput: string,
  _functionConfig: FunctionConfig,
  parsedInput?: Record<string, unknown>
): Promise<ToolExecutionResult> {
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

  LogHelper.title(DUTY_NAME)
  LogHelper.debug(`Running tool: ${qualifiedName}`)
  LogHelper.debug(`Tool input: ${toolInput}`)

  const toolExecutionResult =
    await TOOL_EXECUTOR.executeTool(toolExecutionInput)

  LogHelper.title(DUTY_NAME)
  LogHelper.debug(
    `Tool result: ${qualifiedName} [${toolExecutionResult.status}] — ${toolExecutionResult.message}`
  )
  LogHelper.debug(
    `Tool output: ${JSON.stringify(toolExecutionResult.data?.output)}`
  )

  // Check for final_answer in tool result
  const finalAnswer =
    extractFinalAnswerFromToolResult(toolExecutionResult)
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

export async function runFinalAnswerPhase(
  caller: LLMCaller,
  executionHistory: ExecutionRecord[]
): Promise<string> {
  LogHelper.title(DUTY_NAME)
  LogHelper.debug('Synthesizing final answer from execution history...')

  const historySection = formatExecutionHistory(executionHistory)
  const systemPrompt = PERSONA.getCompactDutySystemPrompt(
    `You are synthesizing a final answer from tool execution results. Provide a clear, helpful, and complete response to the user based on the observations collected. Always include relevant details from the tool results.\n\n${FORMATTING_RULES}`
  )
  const prompt = `${historySection}\n\nUser Request: "${caller.input}"\n\nBased on the execution results above, provide a final answer to the user.`

  // Use native tool calling for remote providers to get a proper answer
  if (caller.supportsNativeTools) {
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

    const result = await caller.callLLMWithTools(
      prompt,
      systemPrompt,
      [answerTool],
      { type: 'function', function: { name: 'provide_answer' } },
      caller.history
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

    const completionResult = await caller.callLLM(
      prompt,
      systemPrompt,
      finalSchema,
      caller.history
    )

    if (completionResult?.output) {
      const parsed = parseOutput(completionResult.output)
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
