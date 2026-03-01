import { LogHelper } from '@/helpers/log-helper'
import {
  PERSONA,
  CONTEXT_MANAGER
} from '@/core'
import type { OpenAITool } from '@/core/llm-manager/types'
import type { MessageLog } from '@/types'

import { RECOVERY_PLAN_SYSTEM_PROMPT, DUTY_NAME } from './constants'
import type {
  Catalog,
  ExecutionRecord,
  LLMCaller,
  PlanResult,
  PlanStep,
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

function buildRecoveryPromptSections(params: {
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
      name: 'RECOVERY_PLAN_PROMPT',
      source: 'server/src/core/llm-manager/llm-duties/react-llm-duty/constants.ts',
      content: RECOVERY_PLAN_SYSTEM_PROMPT
    },
    {
      name: 'RECOVERY_INPUT',
      source:
        'server/src/core/llm-manager/llm-duties/react-llm-duty/recovery-planning.ts',
      content: params.prompt
    }
  ]

  if (params.tools) {
    sections.push({
      name: 'TOOLS_SCHEMA',
      source:
        'server/src/core/llm-manager/llm-duties/react-llm-duty/recovery-planning.ts',
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
      history,
      false,
      buildRecoveryPromptSections({
        prompt,
        systemPrompt: recoverySystemPrompt,
        tools: planTools
      })
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
    history,
    buildRecoveryPromptSections({
      prompt,
      systemPrompt: recoverySystemPrompt,
      includeSchema: true
    })
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
