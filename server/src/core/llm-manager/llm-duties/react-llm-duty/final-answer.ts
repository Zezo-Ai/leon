import { LogHelper } from '@/helpers/log-helper'
import type { OpenAITool } from '@/core/llm-manager/types'

import {
  FORMATTING_RULES,
  FINAL_ANSWER_RETRY_DURATION_MS,
  FINAL_ANSWER_MAX_RETRIES,
  DUTY_NAME
} from './constants'
import type {
  ExecutionRecord,
  LLMCaller,
  PromptLogSection,
  FinalResponseSignal
} from './types'
import { formatExecutionHistory, parseOutput, parseToolCallArguments } from './utils'
import { buildPhaseSystemPrompt } from './phase-policy'

export async function runFinalAnswerPhase(
  caller: LLMCaller,
  executionHistory: ExecutionRecord[],
  handoffSignal?: FinalResponseSignal | null
): Promise<string> {
  LogHelper.title(`${DUTY_NAME} / final_answer`)
  LogHelper.debug('Synthesizing final answer from execution history...')

  const historySection = formatExecutionHistory(executionHistory)
  const defaultBaseSystemPrompt = `You are synthesizing a final answer from tool execution results. Provide a clear, helpful, and complete response to the user based on the observations collected.

Important:
- The execution loop is already finished.
- Do not promise additional actions.
- Do not say "let me", "I will", or any future-step phrasing.
- Return a completed answer based only on available observations.

${FORMATTING_RULES}`
  const defaultSystemPrompt = buildPhaseSystemPrompt(
    defaultBaseSystemPrompt,
    'final_answer'
  )
  const handoffBaseSystemPrompt = `You are producing the final user response from a phase handoff.

The handoff intent and factual payload are authoritative.
The draft is raw material, not final wording.

Rules:
- Keep the same user-facing intent:
  - clarification: ask one concise clarification question.
  - cancelled: confirm that execution is stopped.
  - blocked: explain what blocks completion and what must be configured.
  - error: explain the failure concisely and safely.
  - answer: provide the completed answer.
- Preserve the request-relevant facts, constraints, and commitments from the draft and execution history.
- Rewrite the response fully in your current mood, tone and present state.
- Do not treat tone, emotional framing, or self-assessments in the draft as authoritative content.
- When there is no execution history, rely primarily on the user request and your current persona. Use the draft only as a semantic hint.
- If the draft sounds generic or stylistically mismatched, transform it while keeping the same meaning.
- Do not invent unobserved facts.
- Return plain text only.

${FORMATTING_RULES}`
  const handoffSystemPrompt = buildPhaseSystemPrompt(
    handoffBaseSystemPrompt,
    'final_answer'
  )
  const prompt = handoffSignal
    ? `${historySection}\n\nUser Request: "${caller.input}"\n\nHandoff intent: "${handoffSignal.intent}"\nHandoff draft: "${handoffSignal.draft}"\nHandoff source: "${handoffSignal.source}"\n\nProduce the final user-facing response.`
    : `${historySection}\n\nUser Request: "${caller.input}"\n\nBased on the execution results above, provide a final answer to the user.`
  const systemPrompt = handoffSignal ? handoffSystemPrompt : defaultSystemPrompt

  const buildFinalAnswerPromptSections = (
    currentPrompt: string,
    currentSystemPrompt: string,
    extras?: PromptLogSection[]
  ): PromptLogSection[] => {
    return [
      {
        name: 'SYSTEM_PROMPT_FULL',
        source: 'server/src/core/llm-manager/persona.ts',
        content: currentSystemPrompt
      },
      {
        name: 'FINAL_ANSWER_INPUT',
        source: 'server/src/core/llm-manager/llm-duties/react-llm-duty/final-answer.ts',
        content: currentPrompt
      },
      {
        name: 'BASE_SYSTEM_PROMPT',
        source: 'server/src/core/llm-manager/llm-duties/react-llm-duty/final-answer.ts',
        content: handoffSignal
          ? handoffBaseSystemPrompt
          : defaultBaseSystemPrompt
      },
      ...(extras || [])
    ]
  }

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
        true,
        buildFinalAnswerPromptSections(prompt, systemPrompt),
        {
          phase: 'final_answer'
        }
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
          caller.history,
          false,
          buildFinalAnswerPromptSections(prompt, systemPrompt, [
            {
              name: 'TOOLS_SCHEMA',
              source:
                'server/src/core/llm-manager/llm-duties/react-llm-duty/final-answer.ts',
              content: JSON.stringify([answerTool])
            }
          ]),
          {
            phase: 'final_answer'
          }
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
        caller.history,
        buildFinalAnswerPromptSections(prompt, systemPrompt, [
          {
            name: 'FINAL_SCHEMA',
            source:
              'server/src/core/llm-manager/llm-duties/react-llm-duty/final-answer.ts',
            content: JSON.stringify(finalSchema)
          }
        ]),
        {
          phase: 'final_answer'
        }
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
      LogHelper.title(`${DUTY_NAME} / final_answer`)
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
      LogHelper.title(`${DUTY_NAME} / final_answer`)
      LogHelper.warning(
        `Final answer inference took ${elapsedMs}ms (> ${currentSlowThresholdMs}ms); retrying (${attempt + 1}/${FINAL_ANSWER_MAX_RETRIES})`
      )
      continue
    }

    return candidateAnswer
  }

  // Last resort: summarize from execution history
  if (handoffSignal?.draft?.trim()) {
    return handoffSignal.draft.trim()
  }

  const lastSuccess = executionHistory
    .filter((e) => e.status === 'success')
    .pop()
  if (lastSuccess) {
    return lastSuccess.observation
  }

  return 'I completed the requested actions but could not generate a summary.'
}
