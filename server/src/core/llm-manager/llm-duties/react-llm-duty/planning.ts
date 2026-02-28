import { LogHelper } from '@/helpers/log-helper'
import {
  PERSONA,
  CONTEXT_MANAGER
} from '@/core'
import type { OpenAITool } from '@/core/llm-manager/types'
import type { MessageLog } from '@/types'

import { PLAN_SYSTEM_PROMPT, DUTY_NAME } from './constants'
import type {
  Catalog,
  LLMCaller,
  PlanResult
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
  onPlanningStage?: (stage: 'recalling' | 'thinking') => void
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
  const inputQuery = String(caller.input || '')
  const shouldRecallMemory = caller.shouldRecallPlanningMemory(inputQuery)
  if (shouldRecallMemory) {
    onPlanningStage?.('recalling')
  }
  const memoryPack = shouldRecallMemory
    ? await caller.getPlanningMemoryPack(inputQuery)
    : ''
  if (memoryPack) {
    LogHelper.debug(
      `Planning memory injection: ${memoryPack.length} chars`
    )
  }
  const contextAwareInstruction = memoryPack.includes(
    'Relevant Context Files (full content):'
  )
    ? '\n\nImportant: If the injected context files already contain enough information to answer the user request, return type="final" and do not plan tool calls.'
    : ''
  const memorySection = memoryPack ? `\n\n${memoryPack}` : ''
  const prompt = `${catalog.text}${catalogNote}${contextManifestSection}${memorySection}${contextAwareInstruction}\n\nUser Request: "${caller.input}"`

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
      true
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
              memoryPack &&
              isOperatingSystemControlOnlyPlan(interpreted.steps)
            ) {
              LogHelper.debug(
                'Planning: detected operating_system_control-only plan with memory available; running memory-first validation'
              )
              const memoryValidationSchema = {
                type: 'object',
                properties: {
                  type: {
                    type: 'string',
                    enum: ['final', 'plan']
                  },
                  answer: {
                    type: 'string'
                  }
                },
                required: ['type'],
                additionalProperties: false
              }
              const memoryValidationPrompt = `User Request: "${caller.input}"

Memory Recall:
${memoryPack}

Proposed Plan:
${interpreted.steps.map((step) => `- ${step.function} (${step.label})`).join('\n')}

If the memory recall is sufficient, return type="final" with a direct user-facing answer.
If it is insufficient, return type="plan".`
              const memoryValidationResult = await caller.callLLM(
                memoryValidationPrompt,
                planSystemPrompt,
                memoryValidationSchema,
                history
              )
              const parsedMemoryValidation = parseOutput(
                memoryValidationResult?.output
              )
              LogHelper.debug(
                `Planning memory-first validation output: ${JSON.stringify(
                  parsedMemoryValidation
                )}`
              )
              if (
                parsedMemoryValidation &&
                parsedMemoryValidation['type'] === 'final' &&
                typeof parsedMemoryValidation['answer'] === 'string' &&
                String(parsedMemoryValidation['answer']).trim()
              ) {
                return {
                  type: 'final',
                  answer: String(parsedMemoryValidation['answer']).trim()
                }
              }
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
    onPlanningStage?.('thinking')
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
  onPlanningStage?.('thinking')
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
