import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { LogHelper } from '@/helpers/log-helper'
import {
  PERSONA,
  TOOLKIT_REGISTRY,
  TOOL_EXECUTOR,
  CONTEXT_MANAGER
} from '@/core'
import type { OpenAITool } from '@/core/llm-manager/types'
import type { MessageLog } from '@/types'

import {
  CATALOG_TOKEN_BUDGET,
  CHARS_PER_TOKEN,
  FORMATTING_RULES,
  PLAN_SYSTEM_PROMPT,
  RECOVERY_PLAN_SYSTEM_PROMPT,
  EXECUTE_SYSTEM_PROMPT,
  RESOLVE_FUNCTION_SYSTEM_PROMPT,
  MAX_RETRIES_PER_FUNCTION,
  MAX_TOOL_FAILURE_RETRIES,
  FINAL_ANSWER_RETRY_DURATION_MS,
  FINAL_ANSWER_MAX_RETRIES
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
  extractPlanFromParsed,
  parseOutput,
  parseToolCallArguments,
  extractPlanResultFromCreatePlanArgs,
  validateToolInput,
  extractFinalAnswerFromToolResult,
  formatFilePath
} from './utils'

const DUTY_NAME = 'ReAct LLM Duty'

const PLAN_STEP_PROPERTIES_SCHEMA = {
  function: { type: 'string' },
  label: { type: 'string' }
}

const PLAN_STEP_SCHEMA = {
  type: 'object',
  properties: PLAN_STEP_PROPERTIES_SCHEMA,
  required: ['function', 'label'],
  additionalProperties: false
}

const PLAN_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: ['plan', 'final'] },
    steps: {
      type: 'array',
      items: PLAN_STEP_SCHEMA
    },
    summary: { type: 'string' },
    answer: { type: 'string' }
  },
  required: ['type'],
  additionalProperties: false
}

interface DuplicateInputMatch {
  stepNumber: number
  stepLabel: string | null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }

  return value as Record<string, unknown>
}

function normalizeStepLabel(label: string | null | undefined): string {
  if (!label) {
    return ''
  }

  return label.trim().toLowerCase().replace(/\s+/g, ' ')
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(',')}]`
  }

  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, val]) => `"${key}":${stableSerialize(val)}`)
    return `{${entries.join(',')}}`
  }

  return JSON.stringify(value)
}

function normalizeToolInputForComparison(toolInput: string): string {
  const trimmed = toolInput.trim()
  if (!trimmed) {
    return ''
  }

  try {
    const parsed = JSON.parse(trimmed)
    return stableSerialize(parsed)
  } catch {
    return trimmed.replace(/\s+/g, ' ')
  }
}

function extractRequestedToolInputFromObservation(
  observation: string
): string | null {
  try {
    const parsedObservation = JSON.parse(observation) as Record<string, unknown>
    const requestedInput = parsedObservation['requested_input']
    if (typeof requestedInput === 'string' && requestedInput.trim()) {
      return requestedInput
    }
  } catch {
    // Ignore malformed observation payload
  }

  return null
}

function extractFailureMessageFromObservation(
  observation: string
): string {
  if (!observation) {
    return 'Tool execution failed.'
  }

  try {
    const parsedObservation = JSON.parse(observation) as Record<string, unknown>
    const toolOutputFailure = asRecord(parsedObservation['tool_output_failure'])
    if (
      toolOutputFailure &&
      typeof toolOutputFailure['error'] === 'string' &&
      toolOutputFailure['error'].trim()
    ) {
      return toolOutputFailure['error'].trim()
    }

    if (
      typeof parsedObservation['message'] === 'string' &&
      parsedObservation['message'].trim()
    ) {
      return parsedObservation['message'].trim()
    }
  } catch {
    // Ignore malformed observation payload.
  }

  const trimmedObservation = observation.trim()
  if (!trimmedObservation) {
    return 'Tool execution failed.'
  }

  return trimmedObservation.slice(0, 400)
}

function getExecutionRequestedToolInput(execution: ExecutionRecord): string | null {
  if (execution.requestedToolInput && execution.requestedToolInput.trim()) {
    return execution.requestedToolInput
  }

  return extractRequestedToolInputFromObservation(execution.observation)
}

function findDuplicateToolInputMatch(
  executionHistory: ExecutionRecord[],
  qualifiedName: string,
  stepLabel: string,
  candidateToolInput: string
): DuplicateInputMatch | null {
  const normalizedCandidateInput = normalizeToolInputForComparison(
    candidateToolInput
  )
  if (!normalizedCandidateInput) {
    return null
  }

  const normalizedCurrentLabel = normalizeStepLabel(stepLabel)

  for (let i = executionHistory.length - 1; i >= 0; i -= 1) {
    const previousExecution = executionHistory[i]!
    if (previousExecution.function !== qualifiedName) {
      continue
    }

    const previousInput = getExecutionRequestedToolInput(previousExecution)
    if (!previousInput) {
      continue
    }

    const normalizedPreviousInput = normalizeToolInputForComparison(previousInput)
    if (normalizedPreviousInput !== normalizedCandidateInput) {
      continue
    }

    const previousLabel = normalizeStepLabel(previousExecution.stepLabel)
    if (
      normalizedCurrentLabel &&
      previousLabel &&
      normalizedCurrentLabel === previousLabel
    ) {
      continue
    }

    return {
      stepNumber: i + 1,
      stepLabel: previousExecution.stepLabel || null
    }
  }

  return null
}

function buildPreviouslyUsedInputsSection(
  executionHistory: ExecutionRecord[],
  qualifiedName: string
): string {
  const previousInputs = executionHistory
    .map((execution, index) => ({
      execution,
      stepNumber: index + 1
    }))
    .filter(({ execution }) => execution.function === qualifiedName)
    .map(({ execution, stepNumber }) => {
      const requestedToolInput = getExecutionRequestedToolInput(execution)
      if (!requestedToolInput) {
        return null
      }

      const labelPart = execution.stepLabel
        ? ` | label="${execution.stepLabel}"`
        : ''
      return `- Step ${stepNumber}${labelPart}: ${requestedToolInput}`
    })
    .filter((line): line is string => Boolean(line))

  if (previousInputs.length === 0) {
    return ''
  }

  return `\nPreviously executed inputs for this function in this run:\n${previousInputs.join('\n')}\nDo not reuse the exact same tool_input unless the current step explicitly asks to repeat it.`
}

function buildToolkitContextSection(
  caller: LLMCaller,
  toolkitId: string
): string {
  const injectedContextFiles = [
    ...new Set(TOOLKIT_REGISTRY.getToolkitContextFiles(toolkitId))
  ]
  const toolkitContext = caller.getContextForToolkit(toolkitId).trim()

  const contextCharCount = toolkitContext.length
  const estimatedContextTokens = Math.ceil(
    contextCharCount / CHARS_PER_TOKEN
  )

  LogHelper.title(DUTY_NAME)
  LogHelper.debug(
    `Toolkit context injection [${toolkitId}] files=${injectedContextFiles.length > 0 ? injectedContextFiles.join(', ') : 'none'} | chars=${contextCharCount} | est_tokens=${estimatedContextTokens}`
  )

  if (!toolkitContext) {
    return 'Toolkit Context: none'
  }

  return `Toolkit Context:\n${toolkitContext}`
}

function stripInlineToolMarkup(text: string): string {
  if (!text) {
    return ''
  }

  return text
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '')
    .replace(/<function=[^>]+>/gi, '')
    .replace(/<\/function>/gi, '')
    .replace(/<parameter=[^>]+>[\s\S]*?<\/parameter>/gi, '')
    .trim()
}

function shouldTreatPlanningTextAsFinalAnswer(text: string): boolean {
  const trimmedText = text.trim()
  if (!trimmedText) {
    return false
  }

  if (
    /^(\{|\[)/.test(trimmedText) ||
    /<tool_call>|<function=|<parameter=/i.test(trimmedText) ||
    /([a-z_]+\.[a-z_]+\.[a-zA-Z_]+)/.test(trimmedText)
  ) {
    return false
  }

  return true
}

function humanizeIdentifier(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

function normalizeStepLabelFromFunction(functionName: string): string {
  const lastPart = functionName.split('.').pop() || functionName
  const readable = humanizeIdentifier(lastPart)
  if (!readable) {
    return 'Run tool step'
  }

  return `Run ${readable}`
}

function getFunctionDescription(functionName: string): string {
  const parts = functionName.split('.')
  if (parts.length !== 3) {
    return ''
  }

  const [toolkitId, toolId, fnName] = parts
  if (!toolkitId || !toolId || !fnName) {
    return ''
  }

  const functions = TOOLKIT_REGISTRY.getToolFunctions(toolkitId, toolId)
  const fnConfig = functions?.[fnName]
  return typeof fnConfig?.description === 'string' ? fnConfig.description.trim() : ''
}

function descriptionToStepLabel(description: string): string {
  const cleaned = description
    .replace(/^[\s"'`]+|[\s"'`]+$/g, '')
    .replace(/[.]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!cleaned) {
    return ''
  }

  const words = cleaned.split(' ')
  const limited = words.slice(0, 8).join(' ')
  return limited.charAt(0).toUpperCase() + limited.slice(1)
}

function commandTokenFromArgs(rawArguments: string): string {
  const parsedArgs = parseToolCallArguments(rawArguments)
  if (!parsedArgs) {
    return ''
  }

  const rawCommand =
    typeof parsedArgs['command'] === 'string'
      ? (parsedArgs['command'] as string).trim()
      : ''
  if (!rawCommand) {
    return ''
  }

  const firstToken = rawCommand.split(/\s+/)[0] || ''
  if (!firstToken) {
    return ''
  }

  const basename = firstToken.includes('/')
    ? firstToken.split('/').pop() || ''
    : firstToken
  return basename.replace(/[^a-zA-Z0-9._-]/g, '')
}

function buildRecoveredStepLabel(
  functionName: string,
  rawArguments: string
): string {
  const commandToken = commandTokenFromArgs(rawArguments)
  if (commandToken) {
    return `Run ${commandToken} command`
  }

  const functionDescription = getFunctionDescription(functionName)
  if (functionDescription) {
    const descriptionLabel = descriptionToStepLabel(functionDescription)
    if (descriptionLabel) {
      return descriptionLabel
    }
  }

  return normalizeStepLabelFromFunction(functionName)
}

function resolveFunctionNameForPlan(functionName: string): string | null {
  const trimmed = functionName.trim()
  if (!trimmed) {
    return null
  }

  const parts = trimmed.split('.')
  if (parts.length === 3) {
    const [toolkitId, toolId, fnName] = parts
    if (!toolkitId || !toolId || !fnName) {
      return null
    }

    const functions = TOOLKIT_REGISTRY.getToolFunctions(toolkitId, toolId)
    if (functions && fnName in functions) {
      return trimmed
    }

    return null
  }

  if (parts.length === 2) {
    const resolvedTool = TOOLKIT_REGISTRY.resolveToolById(trimmed)
    return resolvedTool ? trimmed : null
  }

  if (parts.length !== 1) {
    return null
  }

  const fnName = parts[0]
  if (!fnName) {
    return null
  }

  const matches: string[] = []
  const tools = TOOLKIT_REGISTRY.getFlattenedTools()
  for (const tool of tools) {
    const functions = TOOLKIT_REGISTRY.getToolFunctions(tool.toolkitId, tool.toolId)
    if (!functions || !(fnName in functions)) {
      continue
    }

    matches.push(`${tool.toolkitId}.${tool.toolId}.${fnName}`)
    if (matches.length > 1) {
      return null
    }
  }

  return matches[0] || null
}

function createPlanFromUnexpectedToolCall(
  unexpectedToolCall: { functionName: string, arguments: string },
  textFallback: string
): PlanResult | null {
  const resolvedFunction = resolveFunctionNameForPlan(
    unexpectedToolCall.functionName
  )
  if (!resolvedFunction) {
    return null
  }

  const sanitizedSummary = stripInlineToolMarkup(textFallback).replace(/\s+/g, ' ').trim()
  const label = buildRecoveredStepLabel(
    resolvedFunction,
    unexpectedToolCall.arguments
  )
  const summary = sanitizedSummary || `I will ${label.charAt(0).toLowerCase()}${label.slice(1)}.`

  return {
    type: 'plan',
    summary,
    steps: [
      {
        function: resolvedFunction,
        label
      }
    ]
  }
}

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
  const contextManifest = CONTEXT_MANAGER.getManifest()
  LogHelper.title(DUTY_NAME)
  LogHelper.debug(
    `Planning context manifest injected:\n${
      contextManifest || '- none'
    }`
  )

  const contextManifestSection = contextManifest
    ? `\n\nEnvironment Context Manifest:\n${contextManifest}`
    : ''
  const prompt = `${catalog.text}${catalogNote}${contextManifestSection}\n\nUser Request: "${caller.input}"`

  const planSchema = PLAN_RESPONSE_SCHEMA

  // --- Remote providers: use native tool calling to force structured output ---
  if (caller.supportsNativeTools) {
    const planTools: OpenAITool[] = [
      {
        type: 'function',
        function: {
          name: 'create_plan',
          description:
            'Create either an execution plan or a direct conversational answer. Use type="plan" when tools are needed, or type="final" for purely conversational messages. For type="final", answer must be directly user-facing (not meta reasoning about what you will do).',
          parameters: {
            type: 'object',
            properties: {
              type: {
                type: 'string',
                enum: ['plan', 'final'],
                description:
                  'Use "plan" when tools are needed, "final" for direct conversational answer.'
              },
              steps: {
                type: 'array',
                items: {
                  ...PLAN_STEP_SCHEMA,
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
                  }
                },
                description:
                  'Required when type="plan". Keep empty or omit for type="final".'
              },
              summary: {
                type: 'string',
                description:
                  'Required when type="plan". Short user-facing plan summary.'
              },
              answer: {
                type: 'string',
                description:
                  'Required when type="final". Direct user-facing final answer.'
              }
            },
            required: ['type'],
            additionalProperties: false
          }
        }
      }
    ]

    const toolResult = await caller.callLLMWithTools(
      prompt,
      planSystemPrompt,
      planTools,
      { type: 'function', function: { name: 'create_plan' } },
      history
    )

    LogHelper.title(DUTY_NAME)
    LogHelper.debug(
      `Planning tool result: ${JSON.stringify(toolResult)}`
    )

    if (!toolResult) {
      const providerError = caller.consumeProviderErrorMessage()
      if (providerError) {
        LogHelper.debug(
          `Planning aborted due to provider error: "${providerError}"`
        )
        return { type: 'final', answer: providerError }
      }
    }

    const textFallback = toolResult?.textContent?.trim() || ''

    if (toolResult?.toolCall) {
      if (toolResult.toolCall.functionName === 'create_plan') {
        const parsedArgs = parseToolCallArguments(
          toolResult.toolCall.arguments
        )
        if (parsedArgs) {
          const interpreted = extractPlanResultFromCreatePlanArgs(parsedArgs, {
            allowLegacySummaryAsFinal: true
          })
          if (interpreted) {
            return interpreted
          }

          LogHelper.debug(
            'Planning: create_plan payload did not satisfy plan contract; falling back to JSON mode'
          )
        } else {
          LogHelper.debug('Planning: failed to parse create_plan arguments')
        }
      } else {
        const directPlan = createPlanFromUnexpectedToolCall(
          {
            functionName: toolResult.toolCall.functionName,
            arguments: toolResult.toolCall.arguments
          },
          textFallback
        )
        if (directPlan) {
          LogHelper.debug(
            `Planning: recovered direct tool call "${toolResult.toolCall.functionName}" into a single-step plan`
          )
          return directPlan
        }

        LogHelper.debug(
          `Planning: unexpected tool call "${toolResult.toolCall.functionName}" (expected "create_plan"), falling back to JSON mode`
        )
      }
    } else if (toolResult?.unexpectedToolCall) {
      const directPlan = createPlanFromUnexpectedToolCall(
        toolResult.unexpectedToolCall,
        textFallback
      )
      if (directPlan) {
        LogHelper.debug(
          `Planning: recovered unexpected tool call "${toolResult.unexpectedToolCall.functionName}" into a single-step plan`
        )
        return directPlan
      }

      LogHelper.debug(
        `Planning: unexpected tool call "${toolResult.unexpectedToolCall.functionName}" while forcing "create_plan", falling back to JSON mode`
      )
    } else {
      LogHelper.debug('Planning: no tool call returned, falling back to JSON mode')
    }

    if (
      textFallback &&
      shouldTreatPlanningTextAsFinalAnswer(textFallback)
    ) {
      LogHelper.debug(
        'Planning: using direct conversational text answer from tool-calling attempt'
      )
      return {
        type: 'final',
        answer: stripInlineToolMarkup(textFallback) || textFallback
      }
    }

    // Final fallback: JSON mode planning
    const jsonModeResult = await caller.callLLM(
      prompt,
      planSystemPrompt,
      planSchema,
      history
    )
    if (!jsonModeResult) {
      const providerError = caller.consumeProviderErrorMessage()
      if (providerError) {
        LogHelper.debug(
          `Planning JSON fallback aborted due to provider error: "${providerError}"`
        )
        return { type: 'final', answer: providerError }
      }
    }
    const parsed = parseOutput(jsonModeResult?.output)
    const planResult =
      (parsed
        ? extractPlanResultFromCreatePlanArgs(parsed, {
            allowLegacySummaryAsFinal: true
          })
        : null) || extractPlanFromParsed(parsed)
    if (planResult) {
      return planResult
    }

    const textFallbackParsed = parseOutput(textFallback)
    const textFallbackPlan =
      (textFallbackParsed
        ? extractPlanResultFromCreatePlanArgs(textFallbackParsed, {
            allowLegacySummaryAsFinal: true
          })
        : null) || extractPlanFromParsed(textFallbackParsed)
    if (textFallbackPlan) {
      LogHelper.debug('Planning: recovered structured output from text fallback')
      return textFallbackPlan
    }

    if (
      textFallback &&
      shouldTreatPlanningTextAsFinalAnswer(textFallback)
    ) {
      LogHelper.debug(
        'Planning: treating plain text fallback as final conversational answer'
      )
      return {
        type: 'final',
        answer: stripInlineToolMarkup(textFallback) || textFallback
      }
    }

    const raw =
      typeof jsonModeResult?.output === 'string'
        ? jsonModeResult.output.trim()
        : ''
    if (raw) {
      const parsedRaw = parseOutput(raw)
      const parsedRawPlan =
        (parsedRaw
          ? extractPlanResultFromCreatePlanArgs(parsedRaw, {
              allowLegacySummaryAsFinal: true
            })
          : null) || extractPlanFromParsed(parsedRaw)
      if (parsedRawPlan) {
        return parsedRawPlan
      }

      if (shouldTreatPlanningTextAsFinalAnswer(raw)) {
        return { type: 'final', answer: stripInlineToolMarkup(raw) || raw }
      }
    }

    if (textFallback) {
      const sanitizedTextFallback = stripInlineToolMarkup(textFallback)
      return {
        type: 'final',
        answer:
          sanitizedTextFallback ||
          'I could not produce a structured plan. Please rephrase your request.'
      }
    }

    return { type: 'final', answer: raw || 'I could not determine what to do.' }
  }

  // --- Local provider: use grammar-constrained JSON mode ---
  const completionResult = await caller.callLLM(
    prompt,
    planSystemPrompt,
    planSchema,
    history
  )
  if (!completionResult) {
    const providerError = caller.consumeProviderErrorMessage()
    if (providerError) {
      return { type: 'final', answer: providerError }
    }
  }

  LogHelper.title(DUTY_NAME)
  LogHelper.debug(`Planning prompt: "${prompt}..."`)
  LogHelper.debug(
    `Planning raw output: ${JSON.stringify(completionResult?.output)}`
  )

  const parsed = parseOutput(completionResult?.output)
  const planResult =
    (parsed
      ? extractPlanResultFromCreatePlanArgs(parsed, {
          allowLegacySummaryAsFinal: true
        })
      : null) || extractPlanFromParsed(parsed)
  if (planResult) {
    return planResult
  }

  // Fallback
  const raw =
    typeof completionResult?.output === 'string'
      ? completionResult.output.trim()
      : ''
  if (raw) {
    const parsedRaw = parseOutput(raw)
    const parsedRawPlan =
      (parsedRaw
        ? extractPlanResultFromCreatePlanArgs(parsedRaw, {
            allowLegacySummaryAsFinal: true
          })
        : null) || extractPlanFromParsed(parsedRaw)
    if (parsedRawPlan) {
      return parsedRawPlan
    }

    if (shouldTreatPlanningTextAsFinalAnswer(raw)) {
      return { type: 'final', answer: raw }
    }
  }

  return {
    type: 'final',
    answer: 'I could not produce a structured plan. Please rephrase your request.'
  }
}

// ---------------------------------------------------------------------------
// Recovery re-planning
// ---------------------------------------------------------------------------

export async function runRecoveryPlanningPhase(
  caller: LLMCaller,
  catalog: Catalog,
  history: MessageLog[],
  executionHistory: ExecutionRecord[],
  failedStep: PlanStep,
  pendingSteps: PlanStep[]
): Promise<PlanResult | null> {
  const catalogNote =
    catalog.mode === 'tool'
      ? '\nNote: The catalog lists tools, not individual functions. Use the format toolkit_id.tool_id in your plan steps.'
      : ''
  const recoverySystemPrompt = PERSONA.getCompactDutySystemPrompt(
    RECOVERY_PLAN_SYSTEM_PROMPT
  )
  const contextManifest = CONTEXT_MANAGER.getManifest()
  const failedExecution = executionHistory[executionHistory.length - 1]
  const historySection = formatExecutionHistory(executionHistory)
  const pendingStepsSection =
    pendingSteps.length > 0
      ? pendingSteps
          .map(
            (step, index) => `- ${index + 1}. ${step.function} | "${step.label}"`
          )
          .join('\n')
      : '- none'
  const contextManifestSection = contextManifest
    ? `\n\nEnvironment Context Manifest:\n${contextManifest}`
    : ''

  const prompt = `${catalog.text}${catalogNote}${contextManifestSection}

Recovery Context:
- Failed Step Function: ${failedStep.function}
- Failed Step Label: ${failedStep.label}
- Failed Observation: ${failedExecution?.observation || 'No observation available'}

Current Remaining Steps:
${pendingStepsSection}

${historySection}

User Request: "${caller.input}"

Create a revised plan from this point to complete the user request.`

  const planSchema = PLAN_RESPONSE_SCHEMA

  LogHelper.title(DUTY_NAME)
  LogHelper.debug(
    `Recovery planning triggered after failed step "${failedStep.label}" (${failedStep.function})`
  )

  if (caller.supportsNativeTools) {
    const planTools: OpenAITool[] = [
      {
        type: 'function',
        function: {
          name: 'create_plan',
          description:
            'Create a revised execution plan or direct clarification answer. Use type="plan" with steps+summary, or type="final" with answer when user clarification is needed.',
          parameters: {
            type: 'object',
            properties: {
              type: {
                type: 'string',
                enum: ['plan', 'final']
              },
              steps: {
                type: 'array',
                items: {
                  ...PLAN_STEP_SCHEMA,
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
                  'Short natural language summary of the revised plan.'
              },
              answer: {
                type: 'string',
                description:
                  'Direct user-facing clarification message when type="final".'
              }
            },
            required: ['type'],
            additionalProperties: false
          }
        }
      }
    ]

    const toolResult = await caller.callLLMWithTools(
      prompt,
      recoverySystemPrompt,
      planTools,
      { type: 'function', function: { name: 'create_plan' } },
      history
    )

    if (!toolResult) {
      const providerError = caller.consumeProviderErrorMessage()
      if (providerError) {
        return { type: 'final', answer: providerError }
      }
    }

    LogHelper.title(DUTY_NAME)
    LogHelper.debug(
      `Recovery planning tool result: ${JSON.stringify(toolResult)}`
    )

    if (toolResult?.toolCall?.functionName === 'create_plan') {
      const parsedArgs = parseToolCallArguments(
        toolResult.toolCall.arguments
      )
      if (parsedArgs) {
        const interpreted = extractPlanResultFromCreatePlanArgs(parsedArgs, {
          allowLegacySummaryAsFinal: true
        })
        if (interpreted) {
          return interpreted
        }

        LogHelper.debug(
          'Recovery planning: create_plan payload did not satisfy plan contract; falling back to JSON mode'
        )
      } else {
        LogHelper.debug('Recovery planning: failed to parse create_plan arguments')
      }
    } else if (toolResult?.toolCall) {
      const directPlan = createPlanFromUnexpectedToolCall(
        {
          functionName: toolResult.toolCall.functionName,
          arguments: toolResult.toolCall.arguments
        },
        toolResult.textContent?.trim() || ''
      )
      if (directPlan) {
        LogHelper.debug(
          `Recovery planning: recovered direct tool call "${toolResult.toolCall.functionName}" into a single-step plan`
        )
        return directPlan
      }
    } else if (toolResult?.unexpectedToolCall) {
      const directPlan = createPlanFromUnexpectedToolCall(
        toolResult.unexpectedToolCall,
        toolResult.textContent?.trim() || ''
      )
      if (directPlan) {
        LogHelper.debug(
          `Recovery planning: recovered unexpected tool call "${toolResult.unexpectedToolCall.functionName}" into a single-step plan`
        )
        return directPlan
      }
    }

    const textFallback = toolResult?.textContent?.trim() || ''
    const parsedTextFallback = parseOutput(textFallback)
    const extractedPlan =
      (parsedTextFallback
        ? extractPlanResultFromCreatePlanArgs(parsedTextFallback, {
            allowLegacySummaryAsFinal: true
          })
        : null) || extractPlanFromParsed(parsedTextFallback)
    if (extractedPlan) {
      return extractedPlan
    }

    if (textFallback && shouldTreatPlanningTextAsFinalAnswer(textFallback)) {
      return {
        type: 'final',
        answer: stripInlineToolMarkup(textFallback) || textFallback
      }
    }
  }

  const jsonModeResult = await caller.callLLM(
    prompt,
    recoverySystemPrompt,
    planSchema,
    history
  )
  if (!jsonModeResult) {
    const providerError = caller.consumeProviderErrorMessage()
    if (providerError) {
      return { type: 'final', answer: providerError }
    }
  }
  const parsed = parseOutput(jsonModeResult?.output)
  const planResult =
    (parsed
      ? extractPlanResultFromCreatePlanArgs(parsed, {
          allowLegacySummaryAsFinal: true
        })
      : null) || extractPlanFromParsed(parsed)
  if (planResult) {
    return planResult
  }

  const raw =
    typeof jsonModeResult?.output === 'string'
      ? jsonModeResult.output.trim()
      : ''

  if (raw && shouldTreatPlanningTextAsFinalAnswer(raw)) {
    return { type: 'final', answer: stripInlineToolMarkup(raw) || raw }
  }

  return null
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
      step.label,
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
    step.label,
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
  stepLabel: string,
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
      stepLabel,
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
      stepLabel,
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
    stepLabel,
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
  stepLabel: string,
  toolkitId: string,
  toolId: string,
  toolFunctions: Record<string, FunctionConfig>,
  executionHistory: ExecutionRecord[]
): Promise<ExecutionStepResult> {
  const toolkitContextSection = buildToolkitContextSection(caller, toolkitId)
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

  const prompt = `Tool: ${toolkitId}.${toolId}\nCurrent Plan Step: "${stepLabel}"\n\n${toolkitContextSection}\n\n${historySection}\n\nUser Request: "${caller.input}"\n\nSelect the appropriate function for the current plan step and provide arguments.`

  const result = await caller.callLLMWithTools(
    prompt,
    resolveSystemPrompt,
    tools,
    'auto',
    caller.history
  )

  if (!result) {
    const providerError = caller.consumeProviderErrorMessage()
    if (providerError) {
      return {
        type: 'executed',
        execution: {
          function: qualifiedName,
          status: 'error',
          observation: providerError
        }
      }
    }

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
      fnConfig,
      undefined,
      stepLabel
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
  stepLabel: string,
  effectiveToolkitId: string,
  effectiveToolId: string,
  toolFunctions: Record<string, FunctionConfig>,
  functionEntries: [string, FunctionConfig][],
  executionHistory: ExecutionRecord[]
): Promise<ExecutionStepResult> {
  const toolkitContextSection = buildToolkitContextSection(
    caller,
    effectiveToolkitId
  )
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
  const prompt = `Tool: ${effectiveToolkitId}.${effectiveToolId}\nCurrent Plan Step: "${stepLabel}"\n\n${toolkitContextSection}\n\nAvailable Functions:\n${functionsSection}\n\n${historySection}\n\nUser Request: "${caller.input}"\n\nSelect the appropriate function for the current plan step and provide tool_input.`

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
      fnConfig,
      undefined,
      stepLabel
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
  stepLabel: string,
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
      stepLabel,
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
    stepLabel,
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
  stepLabel: string,
  functionConfig: FunctionConfig,
  executionHistory: ExecutionRecord[]
): Promise<ExecutionStepResult> {
  const qualifiedName = `${toolkitId}.${toolId}.${functionName}`
  const currentStepLabel = stepLabel || qualifiedName
  const currentStepNumber = executionHistory.length + 1
  const previousInputsSection = buildPreviouslyUsedInputsSection(
    executionHistory,
    qualifiedName
  )
  const toolkitContextSection = buildToolkitContextSection(caller, toolkitId)
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
  let lastFailedToolInput: string | null = null
  const attemptedInputsInCurrentStep = new Set<string>()

  while (retries <= MAX_RETRIES_PER_FUNCTION) {
    const retryNote = lastError
      ? `\n\nPrevious attempt failed: ${lastError}.${lastFailedToolInput ? `\nPrevious failed tool_input: ${lastFailedToolInput}\nDo not reuse the same tool_input. Change the arguments to address the failure.` : ' Please fix the arguments.'}`
      : ''
    const prompt = `Current Plan Step #${currentStepNumber}: "${currentStepLabel}"\nExecute only this step now and focus on this step objective.${previousInputsSection}\n\n${toolkitContextSection}\n\n${historySection}\n\nUser Request: "${caller.input}"${retryNote}`

    const result = await caller.callLLMWithTools(
      prompt,
      executeSystemPrompt,
      [tool],
      { type: 'function', function: { name: functionName } },
      caller.history
    )

    if (!result) {
      const providerError = caller.consumeProviderErrorMessage()
      if (providerError) {
        LogHelper.title(DUTY_NAME)
        LogHelper.warning(
          `Execution aborted for "${qualifiedName}": ${providerError}`
        )
        return {
          type: 'executed',
          execution: {
            function: qualifiedName,
            status: 'error',
            observation: providerError
          }
        }
      }

      const providerFailureObservation =
        'Provider did not return a response (timeout or network issue).'
      LogHelper.title(DUTY_NAME)
      LogHelper.warning(
        `Execution aborted for "${qualifiedName}": ${providerFailureObservation}`
      )
      return {
        type: 'executed',
        execution: {
          function: qualifiedName,
          status: 'error',
          observation: providerFailureObservation
        }
      }
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

      const validatedToolInput =
        inputValidation.repairedToolInput ?? toolInput
      const duplicateInputMatch = findDuplicateToolInputMatch(
        executionHistory,
        qualifiedName,
        currentStepLabel,
        validatedToolInput
      )
      if (duplicateInputMatch) {
        retries += 1
        const previousStepLabel = duplicateInputMatch.stepLabel
          ? `"${duplicateInputMatch.stepLabel}"`
          : '(no label)'
        lastError = `tool_input duplicates Step ${duplicateInputMatch.stepNumber} ${previousStepLabel}; provide different arguments for the current step`
        LogHelper.title(DUTY_NAME)
        LogHelper.debug(
          `Rejected duplicate tool_input for "${qualifiedName}" at step ${currentStepNumber}: matches step ${duplicateInputMatch.stepNumber}`
        )
        continue
      }
      const normalizedCurrentAttempt = normalizeToolInputForComparison(
        validatedToolInput
      )
      if (
        normalizedCurrentAttempt &&
        attemptedInputsInCurrentStep.has(normalizedCurrentAttempt)
      ) {
        retries += 1
        lastError =
          'tool_input duplicates a previous attempt for the current step'
        LogHelper.title(DUTY_NAME)
        LogHelper.debug(
          `Rejected duplicate retry tool_input for "${qualifiedName}" at step ${currentStepNumber}`
        )
        continue
      }
      if (normalizedCurrentAttempt) {
        attemptedInputsInCurrentStep.add(normalizedCurrentAttempt)
      }

      const toolResult = await runToolExecution(
        toolkitId,
        toolId,
        functionName,
        validatedToolInput,
        functionConfig,
        inputValidation.parsedValue,
        currentStepLabel
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
          lastError = extractFailureMessageFromObservation(
            toolResult.execution.observation
          )
          lastFailedToolInput = validatedToolInput
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
  stepLabel: string,
  functionConfig: FunctionConfig,
  executionHistory: ExecutionRecord[]
): Promise<ExecutionStepResult> {
  const qualifiedName = `${toolkitId}.${toolId}.${functionName}`
  const currentStepLabel = stepLabel || qualifiedName
  const currentStepNumber = executionHistory.length + 1
  const previousInputsSection = buildPreviouslyUsedInputsSection(
    executionHistory,
    qualifiedName
  )
  const paramsSchema = JSON.stringify(functionConfig.parameters)
  const toolkitContextSection = buildToolkitContextSection(caller, toolkitId)
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
  let lastFailedToolInput: string | null = null
  const attemptedInputsInCurrentStep = new Set<string>()

  while (retries <= MAX_RETRIES_PER_FUNCTION) {
    const retryNote = lastError
      ? `\n\nPrevious attempt failed: ${lastError}.${lastFailedToolInput ? `\nPrevious failed tool_input: ${lastFailedToolInput}\nDo not reuse the same tool_input. Change the arguments to address the failure.` : ' Please fix the tool_input.'}`
      : ''
    const prompt = `Function: ${qualifiedName}\nDescription: ${functionConfig.description}\nCurrent Plan Step #${currentStepNumber}: "${currentStepLabel}"\nExecute only this step now and focus on this step objective.${previousInputsSection}\nParameters: ${paramsSchema}\n\n${toolkitContextSection}\n\n${historySection}\n\nUser Request: "${caller.input}"${retryNote}\n\nProvide the tool_input for this function.`

    const completionResult = await caller.callLLM(
      prompt,
      executeSystemPrompt,
      executeSchema,
      caller.history
    )
    if (!completionResult) {
      const providerFailureObservation =
        'Provider did not return a response (timeout or network issue).'
      LogHelper.title(DUTY_NAME)
      LogHelper.warning(
        `Execution aborted for "${qualifiedName}": ${providerFailureObservation}`
      )
      return {
        type: 'executed',
        execution: {
          function: qualifiedName,
          status: 'error',
          observation: providerFailureObservation
        }
      }
    }

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

      const validatedToolInput =
        inputValidation.repairedToolInput ?? toolInput
      const duplicateInputMatch = findDuplicateToolInputMatch(
        executionHistory,
        qualifiedName,
        currentStepLabel,
        validatedToolInput
      )
      if (duplicateInputMatch) {
        retries += 1
        const previousStepLabel = duplicateInputMatch.stepLabel
          ? `"${duplicateInputMatch.stepLabel}"`
          : '(no label)'
        lastError = `tool_input duplicates Step ${duplicateInputMatch.stepNumber} ${previousStepLabel}; provide different arguments for the current step`
        LogHelper.title(DUTY_NAME)
        LogHelper.debug(
          `Rejected duplicate tool_input for "${qualifiedName}" at step ${currentStepNumber}: matches step ${duplicateInputMatch.stepNumber}`
        )
        continue
      }
      const normalizedCurrentAttempt = normalizeToolInputForComparison(
        validatedToolInput
      )
      if (
        normalizedCurrentAttempt &&
        attemptedInputsInCurrentStep.has(normalizedCurrentAttempt)
      ) {
        retries += 1
        lastError =
          'tool_input duplicates a previous attempt for the current step'
        LogHelper.title(DUTY_NAME)
        LogHelper.debug(
          `Rejected duplicate retry tool_input for "${qualifiedName}" at step ${currentStepNumber}`
        )
        continue
      }
      if (normalizedCurrentAttempt) {
        attemptedInputsInCurrentStep.add(normalizedCurrentAttempt)
      }

      const toolResult = await runToolExecution(
        toolkitId,
        toolId,
        functionName,
        validatedToolInput,
        functionConfig,
        inputValidation.parsedValue,
        currentStepLabel
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
          lastError = extractFailureMessageFromObservation(
            toolResult.execution.observation
          )
          lastFailedToolInput = validatedToolInput
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
  parsedInput?: Record<string, unknown>,
  stepLabel?: string
): Promise<ToolExecutionResult> {
  const qualifiedName = `${toolkitId}.${toolId}.${functionName}`
  const requestedToolInput = toolInput
  const requestedParsedInput = parsedInput
    ? { ...parsedInput }
    : undefined

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
  const toolOutput = toolExecutionResult.data?.output || {}
  const nestedResult = asRecord(toolOutput['result'])
  const toolOutputSuccess = toolOutput['success']
  const nestedResultSuccess = nestedResult?.['success']
  const toolOutputError =
    typeof toolOutput['error'] === 'string'
      ? toolOutput['error']
      : null
  const nestedResultError =
    typeof nestedResult?.['error'] === 'string'
      ? nestedResult['error']
      : null
  const hasDomainFailure =
    toolExecutionResult.status === 'success' &&
    (toolOutputSuccess === false || nestedResultSuccess === false)
  const effectiveStatus = hasDomainFailure
    ? 'error'
    : toolExecutionResult.status
  const effectiveMessage =
    (hasDomainFailure && (nestedResultError || toolOutputError)) ||
    toolExecutionResult.message

  LogHelper.title(DUTY_NAME)
  if (hasDomainFailure) {
    LogHelper.warning(
      'Tool result normalized to [error]: tool output reported success=false'
    )
  }
  LogHelper.debug(
    `Tool result: ${qualifiedName} [${effectiveStatus}] — ${effectiveMessage}`
  )
  LogHelper.debug(
    `Tool output: ${JSON.stringify(toolExecutionResult.data?.output)}`
  )

  // Check for final_answer in tool result
  const finalAnswer =
    effectiveStatus === 'success'
      ? extractFinalAnswerFromToolResult(toolExecutionResult)
      : null
  if (finalAnswer) {
    return {
      type: 'executed',
      execution: {
        function: qualifiedName,
        status: 'success',
        observation: finalAnswer,
        requestedToolInput,
        ...(stepLabel ? { stepLabel } : {})
      },
      finalAnswer
    }
  }

  // Check for missing settings
  const missingSettings =
    effectiveStatus === 'error'
      ? ((toolOutput['missing_settings'] as
          | string[]
          | undefined) ??
        (nestedResult?.['missing_settings'] as
          | string[]
          | undefined))
      : undefined
  const settingsPath =
    effectiveStatus === 'error'
      ? ((toolOutput['settings_path'] as
          | string
          | undefined) ??
        (nestedResult?.['settings_path'] as
          | string
          | undefined))
      : undefined
  if (missingSettings && missingSettings.length > 0 && settingsPath) {
    const formattedPath = formatFilePath(settingsPath)
    return {
      type: 'executed',
      execution: {
        function: qualifiedName,
        status: 'error',
        observation: `Missing settings: ${missingSettings.join(', ')}`,
        requestedToolInput,
        ...(stepLabel ? { stepLabel } : {})
      },
      missingSettingsMessage: `Missing tool settings: ${missingSettings.join(
        ', '
      )}. Please set them in ${formattedPath}.`
    }
  }

  const observation = JSON.stringify({
    status: effectiveStatus,
    ...(effectiveStatus !== toolExecutionResult.status
      ? { raw_status: toolExecutionResult.status }
      : {}),
    message: effectiveMessage,
    data: toolExecutionResult.data,
    ...(hasDomainFailure
      ? {
          tool_output_failure: {
            success: nestedResultSuccess ?? toolOutputSuccess,
            error: nestedResultError || toolOutputError || effectiveMessage
          }
        }
      : {}),
    requested_input: requestedToolInput,
    ...(requestedParsedInput
      ? { requested_parsed_input: requestedParsedInput }
      : {})
  })

  return {
    type: 'executed',
    execution: {
      function: qualifiedName,
      status: effectiveStatus,
      observation,
      requestedToolInput,
      ...(stepLabel ? { stepLabel } : {})
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

  const finalAnswerRetryIncrementMs = 30_000

  for (
    let attempt = 0;
    attempt <= FINAL_ANSWER_MAX_RETRIES;
    attempt += 1
  ) {
    let candidateAnswer: string | null = null
    const attemptStart = Date.now()

    // Use streaming text generation for remote providers when synthesizing
    // user-facing final answers. Fallback to tool calling if needed.
    if (caller.supportsNativeTools) {
      const textResult = await caller.callLLMText(
        prompt,
        systemPrompt,
        caller.history,
        true
      )

      if (textResult?.output?.trim()) {
        candidateAnswer = textResult.output.trim()
      }

      if (!candidateAnswer) {
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
          const parsed = parseToolCallArguments(
            result.toolCall.arguments
          )
          if (parsed && typeof parsed['answer'] === 'string') {
            const answer = parsed['answer'].trim()
            if (answer) {
              candidateAnswer = answer
            }
          }
        }

        if (!candidateAnswer && result?.textContent?.trim()) {
          candidateAnswer = result.textContent.trim()
        }
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
          candidateAnswer = parsed['answer'] as string
        } else if (typeof completionResult.output === 'string') {
          candidateAnswer = completionResult.output.trim()
        }
      }
    }

    const elapsedMs = Date.now() - attemptStart
    if (!candidateAnswer) {
      continue
    }

    const currentSlowThresholdMs =
      FINAL_ANSWER_RETRY_DURATION_MS +
      attempt * finalAnswerRetryIncrementMs

    if (
      elapsedMs > currentSlowThresholdMs &&
      attempt < FINAL_ANSWER_MAX_RETRIES
    ) {
      LogHelper.title(DUTY_NAME)
      LogHelper.warning(
        `Final answer inference took ${elapsedMs}ms (> ${currentSlowThresholdMs}ms); retrying (${attempt + 1}/${FINAL_ANSWER_MAX_RETRIES})`
      )
      continue
    }

    return candidateAnswer
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
