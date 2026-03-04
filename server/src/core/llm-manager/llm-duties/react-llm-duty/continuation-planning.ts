import { LogHelper } from '@/helpers/log-helper'
import {
  CONTEXT_MANAGER
} from '@/core'
import type { OpenAITool } from '@/core/llm-manager/types'
import type { MessageLog } from '@/types'

import { CONTINUATION_PLAN_SYSTEM_PROMPT, DUTY_NAME } from './constants'
import type {
  Catalog,
  ExecutionRecord,
  LLMCaller,
  PlanResult,
  PromptLogSection
} from './types'
import {
  formatExecutionHistory,
  extractPlanFromParsed,
  parseOutput,
  parseToolCallArguments,
  extractPlanResultFromCreatePlanArgs
} from './utils'
import {
  stripInlineToolMarkup,
  shouldTreatPlanningTextAsFinalAnswer,
  createPlanFromUnexpectedToolCall
} from './phase-helpers'
import {
  PLAN_RESPONSE_SCHEMA,
  PLAN_STEP_SCHEMA
} from './plan-contract'
import { buildPhaseSystemPrompt } from './phase-policy'

function buildContinuationPromptSections(params: {
  prompt: string
  systemPrompt: string
  tools?: OpenAITool[]
  includeSchema?: boolean
}): PromptLogSection[] {
  const sections: PromptLogSection[] = [
    {
      name: 'PERSONA',
      source: 'server/src/core/llm-manager/persona.ts',
      content: params.systemPrompt
    },
    {
      name: 'CONTINUATION_PLAN_PROMPT',
      source: 'server/src/core/llm-manager/llm-duties/react-llm-duty/constants.ts',
      content: CONTINUATION_PLAN_SYSTEM_PROMPT
    },
    {
      name: 'CONTINUATION_INPUT',
      source:
        'server/src/core/llm-manager/llm-duties/react-llm-duty/continuation-planning.ts',
      content: params.prompt
    }
  ]

  if (params.tools) {
    sections.push({
      name: 'TOOLS_SCHEMA',
      source:
        'server/src/core/llm-manager/llm-duties/react-llm-duty/continuation-planning.ts',
      content: JSON.stringify(params.tools)
    })
  }

  if (params.includeSchema) {
    sections.push({
      name: 'PLAN_SCHEMA',
      source:
        'server/src/core/llm-manager/llm-duties/react-llm-duty/plan-contract.ts',
      content: JSON.stringify(PLAN_RESPONSE_SCHEMA)
    })
  }

  return sections
}

export async function runContinuationPlanningPhase(
  caller: LLMCaller,
  catalog: Catalog,
  history: MessageLog[],
  executionHistory: ExecutionRecord[]
): Promise<PlanResult | null> {
  const catalogNote =
    catalog.mode === 'tool'
      ? '\nNote: The catalog lists tools, not individual functions. Use the format toolkit_id.tool_id in your plan steps.'
      : ''
  const continuationSystemPrompt = buildPhaseSystemPrompt(
    CONTINUATION_PLAN_SYSTEM_PROMPT,
    'recovery'
  )
  const contextManifest = CONTEXT_MANAGER.getManifest()
  const lastExecution = executionHistory[executionHistory.length - 1]
  const historySection = formatExecutionHistory(executionHistory)
  const contextManifestSection = contextManifest
    ? `\n\nEnvironment Context Manifest:\n${contextManifest}`
    : ''

  const prompt = `${catalog.text}${catalogNote}${contextManifestSection}

Execution Context:
- Last Step Function: ${lastExecution?.function || 'none'}
- Last Step Status: ${lastExecution?.status || 'none'}
- Last Observation: ${lastExecution?.observation || 'No observation available'}

${historySection}

User Request: "${caller.input}"

Decide whether the request is already complete or if additional tool steps are needed from this point.
If additional steps are needed, return only the missing next steps.`

  const planSchema = PLAN_RESPONSE_SCHEMA

  LogHelper.title(DUTY_NAME)
  LogHelper.debug('Continuation planning triggered after successful step')

  if (caller.supportsNativeTools) {
    const planTools: OpenAITool[] = [
      {
        type: 'function',
        function: {
          name: 'create_plan',
          description:
            'Decide whether execution is complete or should continue. Use type="plan" with steps+summary for remaining work, or type="final" with a completed answer.',
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
                  'Short natural language summary of the continuation plan.'
              },
              answer: {
                type: 'string',
                description:
                  'Direct user-facing final answer when type="final".'
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
      continuationSystemPrompt,
      planTools,
      { type: 'function', function: { name: 'create_plan' } },
      history,
      false,
      buildContinuationPromptSections({
        prompt,
        systemPrompt: continuationSystemPrompt,
        tools: planTools
      }),
      {
        phase: 'recovery'
      }
    )

    if (!toolResult) {
      const providerError = caller.consumeProviderErrorMessage()
      if (providerError) {
        return { type: 'final', answer: providerError }
      }
    }

    LogHelper.title(DUTY_NAME)
    LogHelper.debug(
      `Continuation planning tool result: ${JSON.stringify(toolResult)}`
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
          'Continuation planning: create_plan payload did not satisfy plan contract; falling back to JSON mode'
        )
      } else {
        LogHelper.debug(
          'Continuation planning: failed to parse create_plan arguments'
        )
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
          `Continuation planning: recovered direct tool call "${toolResult.toolCall.functionName}" into a single-step plan`
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
          `Continuation planning: recovered unexpected tool call "${toolResult.unexpectedToolCall.functionName}" into a single-step plan`
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
    continuationSystemPrompt,
    planSchema,
    history,
    buildContinuationPromptSections({
      prompt,
      systemPrompt: continuationSystemPrompt,
      includeSchema: true
    }),
    {
      phase: 'recovery'
    }
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
