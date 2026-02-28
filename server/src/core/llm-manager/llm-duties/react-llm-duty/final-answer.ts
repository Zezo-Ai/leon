import { LogHelper } from '@/helpers/log-helper'
import { PERSONA } from '@/core'
import type { OpenAITool } from '@/core/llm-manager/types'

import {
  FORMATTING_RULES,
  FINAL_ANSWER_RETRY_DURATION_MS,
  FINAL_ANSWER_MAX_RETRIES,
  DUTY_NAME
} from './constants'
import type {
  ExecutionRecord,
  LLMCaller
} from './types'
import { formatExecutionHistory, parseOutput, parseToolCallArguments } from './utils'

export async function runFinalAnswerPhase(
  caller: LLMCaller,
  executionHistory: ExecutionRecord[]
): Promise<string> {
  LogHelper.title(DUTY_NAME)
  LogHelper.debug('Synthesizing final answer from execution history...')

  const historySection = formatExecutionHistory(executionHistory)
  const systemPrompt = PERSONA.getCompactDutySystemPrompt(
    `You are synthesizing a final answer from tool execution results. Provide a clear, helpful, and complete response to the user based on the observations collected. Always include relevant details from the tool results.

Important:
- The execution loop is already finished.
- Do not promise additional actions.
- Do not say "let me", "I will", or any future-step phrasing.
- Return a completed answer based only on available observations.

${FORMATTING_RULES}`
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
          candidateAnswer = String(parsed['answer']).trim()
        } else if (typeof completionResult.output === 'string') {
          candidateAnswer = completionResult.output.trim()
        }
      }
    }

    const elapsedMs = Date.now() - attemptStart
    if (!candidateAnswer) {
      continue
    }

    if (candidateAnswer.trim().endsWith(':') && attempt < FINAL_ANSWER_MAX_RETRIES) {
      LogHelper.title(DUTY_NAME)
      LogHelper.warning(
        `Final answer looked incomplete (trailing colon); retrying (${attempt + 1}/${FINAL_ANSWER_MAX_RETRIES})`
      )
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
