import { LogHelper } from '@/helpers/log-helper'

import type { PlanStep, ExecutionRecord } from './types'

export const formatFilePath = (filePath: string): string => {
  return `[FILE_PATH]${filePath}[/FILE_PATH]`
}

/**
 * Determines whether a catalog entry refers to a tool (toolkit.tool) rather
 * than a fully-qualified function (toolkit.tool.function).
 */
export const isToolLevel = (qualifiedName: string): boolean => {
  return qualifiedName.split('.').length <= 2
}

export function formatExecutionHistory(history: ExecutionRecord[]): string {
  if (history.length === 0) {
    return 'Previous Executions: none'
  }
  return `Previous Executions:\n${history
    .map(
      (exec, i) =>
        `Step ${i + 1}: ${exec.function} [${exec.status}]${
          exec.stepLabel ? ` | Label: "${exec.stepLabel}"` : ''
        }\n  Requested Input: ${
          exec.requestedToolInput || 'not available'
        }\n  Observation: ${exec.observation}`
    )
    .join('\n')}`
}

/**
 * Parses plan steps from raw tool call arguments (array of objects).
 * Handles missing labels gracefully.
 */
export function parseStepsFromArgs(
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
export function extractPlanFromParsed(
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
      steps = parseStepsFromArgs(
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
        LogHelper.title('ReAct LLM Duty')
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

// ---------------------------------------------------------------------------
// Output parsing
// ---------------------------------------------------------------------------

/**
 * Parses raw LLM output into a structured object, handling both JSON
 * objects from structured output and string responses from remote providers.
 */
export function parseOutput(
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
  const taggedJson = extractTaggedJson(trimmed)
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
  const extracted = extractJsonSubstring(trimmed)
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

export function extractTaggedJson(input: string): string | null {
  const tagMatch = input.match(/\[(TOOL|TOOLKIT|FUNCTION|FINAL|PLAN|EXECUTE|REPLAN)\]/i)
  if (!tagMatch || tagMatch.index === undefined) {
    return null
  }

  const startIndex = tagMatch.index + tagMatch[0].length
  const rest = input.slice(startIndex).trim()
  return extractJsonSubstring(rest)
}

export function extractJsonSubstring(input: string): string | null {
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

export function extractFinalAnswerFromToolResult(toolExecutionResult: {
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

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function validateToolInput(
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
    parsedFromRepair = tryRepairToolInput(toolInput)
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

export function tryRepairToolInput(
  toolInput: string
): { repaired: string, value: unknown } | null {
  const repaired = repairJsonStringLiterals(toolInput)
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

export function repairJsonStringLiterals(input: string): string {
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
