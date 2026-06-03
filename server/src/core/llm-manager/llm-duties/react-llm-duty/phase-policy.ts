import { PERSONA } from '@/core'
import type {
  LLMReasoningMode,
  LLMReasoningSummary,
  LLMTextVerbosity
} from '@/core/llm-manager/types'

import type { ReactPhase } from './types'

export interface ReactPhasePolicy {
  promptProfile: 'full' | 'lean'
  // Inject the persona style/voice block into the system prompt.
  includePersonality: boolean
  // Inject the dynamic mood block into the system prompt.
  includeMood: boolean
  // Provider-side thinking/reasoning mode (not UI rendering).
  reasoningMode: LLMReasoningMode
  // Request streaming from the provider API.
  streamToProvider: boolean
  // Forward streamed text tokens to the user UI in real time.
  streamToUser: boolean
  // Forward streamed reasoning chunks to reasoning logs/UI widgets.
  emitReasoning: boolean
  // Visible reasoning summary detail. This is observability, not reasoning depth.
  reasoningSummary?: LLMReasoningSummary
  // Provider-side response verbosity.
  textVerbosity?: LLMTextVerbosity
}

const REACT_PHASE_POLICIES: Record<ReactPhase, ReactPhasePolicy> = {
  planning: {
    promptProfile: 'lean',
    includePersonality: false,
    includeMood: false,
    reasoningMode: 'on',
    streamToProvider: true,
    streamToUser: false,
    emitReasoning: true,
    reasoningSummary: 'auto',
    textVerbosity: 'low'
  },
  execution: {
    promptProfile: 'lean',
    includePersonality: false,
    includeMood: false,
    reasoningMode: 'on',
    streamToProvider: true,
    streamToUser: false,
    emitReasoning: true,
    reasoningSummary: 'auto',
    textVerbosity: 'low'
  },
  recovery: {
    promptProfile: 'lean',
    includePersonality: false,
    includeMood: false,
    reasoningMode: 'on',
    streamToProvider: true,
    streamToUser: false,
    emitReasoning: true,
    reasoningSummary: 'detailed',
    textVerbosity: 'low'
  },
  final_answer: {
    promptProfile: 'full',
    includePersonality: true,
    includeMood: true,
    reasoningMode: 'off',
    streamToProvider: true,
    streamToUser: true,
    emitReasoning: false
  }
}

export function getPhasePolicy(phase?: ReactPhase): ReactPhasePolicy {
  if (!phase) {
    return REACT_PHASE_POLICIES.execution
  }

  return REACT_PHASE_POLICIES[phase]
}

export function buildPhaseSystemPrompt(
  basePrompt: string,
  phase: ReactPhase
): string {
  const policy = getPhasePolicy(phase)

  return PERSONA.getCompactDutySystemPrompt(basePrompt, {
    profile: policy.promptProfile,
    includePersonality: policy.includePersonality,
    includeMood: policy.includeMood
  })
}

export function formatPhasePolicyForLog(
  phase: ReactPhase,
  policy: ReactPhasePolicy
): string {
  return `phase=${phase} | profile=${policy.promptProfile} | persona=${policy.includePersonality ? 'on' : 'off'} | mood=${policy.includeMood ? 'on' : 'off'} | thinking=${policy.reasoningMode} | budget=provider_default | provider_stream=${policy.streamToProvider ? 'on' : 'off'} | user_stream=${policy.streamToUser ? 'on' : 'off'} | reasoning=${policy.emitReasoning ? 'on' : 'off'} | reasoning_summary=${policy.reasoningSummary ?? 'off'} | verbosity=${policy.textVerbosity ?? 'default'}`
}

export function formatEffectivePhasePolicyForLog(
  phase: ReactPhase,
  policy: ReactPhasePolicy,
  effective: {
    reasoningMode: LLMReasoningMode
    streamToProvider: boolean
    streamToUser?: boolean
    emitReasoning: boolean
  }
): string {
  const effectiveUserStream =
    typeof effective.streamToUser === 'boolean'
      ? ` | effective_user_stream=${effective.streamToUser ? 'on' : 'off'}`
      : ''

  return `${formatPhasePolicyForLog(phase, policy)} | effective_thinking=${effective.reasoningMode} | effective_provider_stream=${effective.streamToProvider ? 'on' : 'off'}${effectiveUserStream} | effective_reasoning=${effective.emitReasoning ? 'on' : 'off'}`
}
