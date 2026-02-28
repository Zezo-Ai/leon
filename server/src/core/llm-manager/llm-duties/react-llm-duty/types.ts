import type { LLMDutyParams } from '@/core/llm-manager/llm-duty'
import type { MessageLog } from '@/types'
import type {
  OpenAITool,
  OpenAIToolChoice
} from '@/core/llm-manager/types'

export type ReactLLMDutyParams = LLMDutyParams

export interface FunctionConfig {
  description: string
  parameters: Record<string, unknown>
  output_schema?: Record<string, unknown>
}

export type ToolFunctionsMap = Record<string, FunctionConfig>

export interface PlanStep {
  function: string
  label: string
}

export interface ExecutionRecord {
  function: string
  status: string
  observation: string
  stepLabel?: string
  requestedToolInput?: string
}

export type PlanStepStatus = 'pending' | 'in_progress' | 'completed'

export interface TrackedPlanStep {
  label: string
  status: PlanStepStatus
}

export interface Catalog {
  text: string
  mode: 'function' | 'tool'
}

export type PlanResult =
  | { type: 'plan', steps: PlanStep[], summary: string }
  | { type: 'final', answer: string }

export type ExecutionStepResult =
  | { type: 'final', answer: string }
  | { type: 'replan', reason: string, functions: string[] }
  | {
      type: 'executed'
      execution: ExecutionRecord
      finalAnswer?: string
      missingSettingsMessage?: string
    }

export interface ToolExecutionResult {
  type: 'executed'
  execution: ExecutionRecord
  finalAnswer?: string
  missingSettingsMessage?: string
}

/**
 * Callback interface for LLM calls from phase functions.
 * This decouples the phase logic from the duty class instance.
 */
export interface LLMCaller {
  callLLM(
    prompt: string,
    systemPrompt: string,
    schema: Record<string, unknown>,
    history?: MessageLog[]
  ): Promise<{
    output: unknown
    usedInputTokens?: number
    usedOutputTokens?: number
  } | null>

  callLLMText(
    prompt: string,
    systemPrompt: string,
    history?: MessageLog[],
    shouldStream?: boolean
  ): Promise<{
    output: string
    usedInputTokens?: number
    usedOutputTokens?: number
  } | null>

  callLLMWithTools(
    prompt: string,
    systemPrompt: string,
    tools: OpenAITool[],
    toolChoice: OpenAIToolChoice,
    history?: MessageLog[],
    shouldStreamToUser?: boolean
  ): Promise<{
    toolCall?: { functionName: string, arguments: string }
    unexpectedToolCall?: { functionName: string, arguments: string }
    textContent?: string
    usedInputTokens?: number
    usedOutputTokens?: number
  } | null>

  readonly supportsNativeTools: boolean
  readonly input: string | object | null
  readonly history: MessageLog[]
  getContextForToolkit(toolkitId: string): string
  getPlanningMemoryPack(query: string, tokenBudget?: number): Promise<string>
  getExecutionMemoryPack(
    query: string,
    toolkitId: string,
    tokenBudget?: number
  ): Promise<string>
  consumeProviderErrorMessage(): string | null
}
