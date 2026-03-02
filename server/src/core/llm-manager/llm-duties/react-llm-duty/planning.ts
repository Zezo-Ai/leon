import { LogHelper } from '@/helpers/log-helper'
import {
  PERSONA,
  CONTEXT_MANAGER
} from '@/core'
import type { OpenAITool } from '@/core/llm-manager/types'
import type { MessageLog } from '@/types'

import {
  PLAN_SYSTEM_PROMPT,
  DUTY_NAME
} from './constants'
import type {
  Catalog,
  LLMCaller,
  PlanResult,
  PromptLogSection
} from './types'
import {
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

function buildPlanningPromptSections(params: {
  prompt: string
  systemPrompt: string
  includeTools?: boolean
  includeSchema?: boolean
  tools?: OpenAITool[]
}): PromptLogSection[] {
  const sections: PromptLogSection[] = [
    {
      name: 'PERSONA',
      source: 'server/src/core/llm-manager/persona.ts',
      content: params.systemPrompt
    },
    {
      name: 'PLANNING_PROMPT',
      source: 'server/src/core/llm-manager/llm-duties/react-llm-duty/constants.ts',
      content: PLAN_SYSTEM_PROMPT
    },
    {
      name: 'PLANNING_INPUT',
      source: 'server/src/core/llm-manager/llm-duties/react-llm-duty/planning.ts',
      content: params.prompt
    }
  ]

  if (params.includeTools && params.tools) {
    sections.push({
      name: 'TOOLS_SCHEMA',
      source:
        'server/src/core/llm-manager/llm-duties/react-llm-duty/planning.ts',
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

function isOperatingSystemControlOnlyPlan(steps: { function: string }[]): boolean {
  if (steps.length === 0) {
    return false
  }

  return steps.every((step) =>
    step.function.startsWith('operating_system_control.')
  )
}

export async function runPlanningPhase(
  caller: LLMCaller,
  catalog: Catalog,
  history: MessageLog[],
  onPlanningStage?: (stage: 'thinking') => void
): Promise<PlanResult> {
  const catalogNote =
    catalog.mode === 'tool'
      ? '\nNote: The catalog lists tools, not individual functions. Use the format toolkit_id.tool_id in your plan steps.'
      : ''
  const planSystemPrompt = PERSONA.getCompactDutySystemPrompt(
    PLAN_SYSTEM_PROMPT,
    {
      includePersonality: true,
      includeMood: true
    }
  )
  const contextManifest = CONTEXT_MANAGER.getManifest()

  const contextManifestSection = contextManifest
    ? `\n\nAvailable context files right now (Environment Context Manifest):\n${contextManifest}\nIf useful for the request or personalization, use structured_knowledge.context.searchContext/readContextFile before shell tools.`
    : ''
  const prompt = `${catalog.text}${catalogNote}${contextManifestSection}\n\nUser Request: "${caller.input}"`

  const planSchema = PLAN_RESPONSE_SCHEMA

  // --- Remote providers: use native tool calling to force structured output ---
  if (caller.supportsNativeTools) {
    onPlanningStage?.('thinking')
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
      history,
      false,
      buildPlanningPromptSections({
        prompt,
        systemPrompt: planSystemPrompt,
        includeTools: true,
        tools: planTools
      })
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
            if (
              interpreted.type === 'plan' &&
              isOperatingSystemControlOnlyPlan(interpreted.steps)
            ) {
              LogHelper.debug(
                'Planning: operating_system_control-only plan returned; memory access should use structured_knowledge.memory.read when relevant.'
              )
            }
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

    // Final fallback: JSON mode planning
    onPlanningStage?.('thinking')
    const jsonModeResult = await caller.callLLM(
      prompt,
      planSystemPrompt,
      planSchema,
      history,
      buildPlanningPromptSections({
        prompt,
        systemPrompt: planSystemPrompt,
        includeSchema: true
      })
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
  onPlanningStage?.('thinking')
  const completionResult = await caller.callLLM(
    prompt,
    planSystemPrompt,
    planSchema,
    history,
    buildPlanningPromptSections({
      prompt,
      systemPrompt: planSystemPrompt,
      includeSchema: true
    })
  )
  if (!completionResult) {
    const providerError = caller.consumeProviderErrorMessage()
    if (providerError) {
      return { type: 'final', answer: providerError }
    }
  }

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
