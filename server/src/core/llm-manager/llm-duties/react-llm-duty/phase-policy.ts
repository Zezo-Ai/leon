import { PERSONA } from '@/core'

import type { ReactPhase } from './types'

export interface ExecutionThinkingRule {
  toolkitId: string
  toolId: string
  functionNames?: string[]
}

export interface ReactPhasePolicy {
  // Inject the persona style/voice block into the system prompt.
  includePersonality: boolean
  // Inject the dynamic mood block into the system prompt.
  includeMood: boolean
  // Provider-side thinking/reasoning mode toggle (not UI rendering).
  thinkingEnabled: boolean
  // Request streaming from the provider API.
  streamToProvider: boolean
  // Forward streamed text tokens to the user UI in real time.
  streamToUser: boolean
  // Forward streamed reasoning chunks to reasoning logs/UI widgets.
  emitReasoning: boolean
  // Execution-only overrides for enabling thinking by tool/function.
  executionThinkingRules?: ExecutionThinkingRule[]
}

const REACT_PHASE_POLICIES: Record<ReactPhase, ReactPhasePolicy> = {
  planning: {
    includePersonality: true,
    includeMood: true,
    thinkingEnabled: true,
    streamToProvider: true,
    streamToUser: false,
    emitReasoning: true
  },
  execution: {
    includePersonality: false,
    includeMood: false,
    thinkingEnabled: false,
    streamToProvider: true,
    streamToUser: false,
    emitReasoning: true,
    executionThinkingRules: [
      {
        toolkitId: 'structured_knowledge',
        toolId: 'memory',
        functionNames: ['read']
      },
      {
        toolkitId: 'structured_knowledge',
        toolId: 'context',
        functionNames: ['searchContext', 'readContextFile', 'listContextFiles']
      },
      {
        toolkitId: 'operating_system_control',
        toolId: 'bash'
      }
    ]
  },
  recovery: {
    includePersonality: false,
    includeMood: false,
    thinkingEnabled: true,
    streamToProvider: true,
    streamToUser: false,
    emitReasoning: true
  },
  final_answer: {
    includePersonality: true,
    includeMood: true,
    thinkingEnabled: false,
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

export function shouldEnableThinkingForExecution(params: {
  toolkitId: string
  toolId: string
  functionName: string
}): boolean {
  const executionPolicy = getPhasePolicy('execution')
  const rules = executionPolicy.executionThinkingRules || []

  return rules.some((rule) => {
    if (rule.toolkitId !== params.toolkitId || rule.toolId !== params.toolId) {
      return false
    }

    if (!rule.functionNames || rule.functionNames.length === 0) {
      return true
    }

    return rule.functionNames.includes(params.functionName)
  })
}

export function buildPhaseSystemPrompt(
  basePrompt: string,
  phase: ReactPhase
): string {
  const policy = getPhasePolicy(phase)

  return PERSONA.getCompactDutySystemPrompt(basePrompt, {
    includePersonality: policy.includePersonality,
    includeMood: policy.includeMood
  })
}

export function formatPhasePolicyForLog(
  phase: ReactPhase,
  policy: ReactPhasePolicy
): string {
  return `phase=${phase} | persona=${policy.includePersonality ? 'on' : 'off'} | mood=${policy.includeMood ? 'on' : 'off'} | thinking=${policy.thinkingEnabled ? 'on' : 'off'} | provider_stream=${policy.streamToProvider ? 'on' : 'off'} | user_stream=${policy.streamToUser ? 'on' : 'off'} | reasoning=${policy.emitReasoning ? 'on' : 'off'}`
}
