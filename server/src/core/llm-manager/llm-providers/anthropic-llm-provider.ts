import AISDKRemoteLLMProvider from '@/core/llm-manager/llm-providers/ai-sdk-remote-llm-provider'
import type { ResolvedLLMTarget } from '@/core/llm-manager/llm-routing'
import type {
  CompletionParams,
  LLMReasoningMode
} from '@/core/llm-manager/types'

type ClaudeModelFamily = 'haiku' | 'opus' | 'sonnet'

interface ClaudeModelVersion {
  family: ClaudeModelFamily
  major: number
  minor: number
}

const CLAUDE_MODEL_ID_PART_SEPARATOR = '-'
const CLAUDE_MODEL_ID_PREFIX = 'claude'
const CLAUDE_MODEL_DATE_PART_LENGTH = 8
const CLAUDE_MODEL_FAMILIES: ClaudeModelFamily[] = ['haiku', 'opus', 'sonnet']
const CLAUDE_ADAPTIVE_THINKING_MINIMUMS: Partial<
  Record<ClaudeModelFamily, { major: number, minor: number }>
> = {
  opus: {
    major: 4,
    minor: 6
  },
  sonnet: {
    major: 4,
    minor: 6
  }
}
const CLAUDE_SAMPLING_UNSUPPORTED_MINIMUMS: Partial<
  Record<ClaudeModelFamily, { major: number, minor: number }>
> = {
  opus: {
    major: 4,
    minor: 7
  }
}

function isClaudeModelDatePart(part: string | undefined): boolean {
  return (
    typeof part === 'string' &&
    part.length === CLAUDE_MODEL_DATE_PART_LENGTH &&
    Number.isInteger(Number(part))
  )
}

function parseClaudeModelVersion(model: string): ClaudeModelVersion | null {
  const parts = model
    .toLowerCase()
    .split(CLAUDE_MODEL_ID_PART_SEPARATOR)

  if (parts[0] !== CLAUDE_MODEL_ID_PREFIX) {
    return null
  }

  const familyIndex = parts.findIndex((part): part is ClaudeModelFamily =>
    CLAUDE_MODEL_FAMILIES.includes(part as ClaudeModelFamily)
  )

  if (familyIndex === -1) {
    return null
  }

  const major = Number(parts[familyIndex + 1])
  const minorPart = parts[familyIndex + 2]
  const minor = isClaudeModelDatePart(minorPart) ? 0 : Number(minorPart ?? 0)

  if (!Number.isInteger(major) || !Number.isInteger(minor)) {
    return null
  }

  return {
    family: parts[familyIndex] as ClaudeModelFamily,
    major,
    minor
  }
}

function isClaudeModelAtLeast(
  model: string,
  minimums: Partial<Record<ClaudeModelFamily, { major: number, minor: number }>>
): boolean {
  const version = parseClaudeModelVersion(model)

  if (!version) {
    return false
  }

  const minimum = minimums[version.family]

  if (!minimum) {
    return false
  }

  return (
    version.major > minimum.major ||
    (version.major === minimum.major && version.minor >= minimum.minor)
  )
}

function shouldOmitTemperature(model: string): boolean {
  return isClaudeModelAtLeast(model, CLAUDE_SAMPLING_UNSUPPORTED_MINIMUMS)
}

function supportsAdaptiveThinking(model: string): boolean {
  return isClaudeModelAtLeast(model, CLAUDE_ADAPTIVE_THINKING_MINIMUMS)
}

function isForcedToolChoice(
  toolChoice: CompletionParams['toolChoice']
): boolean {
  return toolChoice === 'required' || typeof toolChoice !== 'string'
}

function buildManualThinkingOptions(
  completionParams: CompletionParams
): Record<string, unknown> {
  const budget = completionParams.thoughtTokensBudget

  return {
    anthropic: {
      thinking: {
        type: 'enabled',
        ...(typeof budget === 'number' && Number.isFinite(budget)
          ? { budgetTokens: Math.max(1_024, Math.floor(budget)) }
          : { budgetTokens: 1_024 })
      },
      sendReasoning: true
    }
  }
}

function buildAnthropicProviderOptions(
  model: string,
  reasoningMode: LLMReasoningMode | null,
  completionParams: CompletionParams
): Record<string, unknown> {
  const effectiveReasoningMode = completionParams.disableThinking === true
    || (
      Array.isArray(completionParams.tools) &&
      completionParams.tools.length > 0 &&
      completionParams.toolChoice !== undefined &&
      isForcedToolChoice(completionParams.toolChoice)
    )
    ? 'off'
    : reasoningMode

  if (effectiveReasoningMode === 'off' || effectiveReasoningMode === 'guarded') {
    return {
      anthropic: {
        thinking: { type: 'disabled' },
        sendReasoning: true
      }
    }
  }

  if (!supportsAdaptiveThinking(model)) {
    return buildManualThinkingOptions(completionParams)
  }

  return {
    anthropic: {
      thinking: {
        type: 'adaptive',
        display: 'summarized'
      },
      effort: 'high',
      sendReasoning: true
    }
  }
}

export default class AnthropicLLMProvider extends AISDKRemoteLLMProvider {
  constructor(target: ResolvedLLMTarget) {
    super({
      name: 'Anthropic LLM Provider',
      providerName: 'anthropic',
      apiKeyEnv: 'LEON_ANTHROPIC_API_KEY',
      model: target.model,
      baseURL: 'https://api.anthropic.com/v1',
      flavor: 'anthropic',
      buildProviderOptions: ({ completionParams, reasoningMode }) =>
        buildAnthropicProviderOptions(
          target.model,
          reasoningMode,
          completionParams
        ),
      shouldOmitTemperature: () => shouldOmitTemperature(target.model)
    })
  }
}
