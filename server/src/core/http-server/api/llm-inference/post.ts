import type { FastifyPluginAsync } from 'fastify'

import type { APIOptions } from '@/core/http-server/http-server'
import type { LLMDutyResult } from '@/core/llm-manager/llm-duty'
import { LLMDuties } from '@/core/llm-manager/types'
import { CustomNERLLMDuty } from '@/core/llm-manager/llm-duties/custom-ner-llm-duty'
import { ParaphraseLLMDuty } from '@/core/llm-manager/llm-duties/paraphrase-llm-duty'
import { ConversationLLMDuty } from '@/core/llm-manager/llm-duties/conversation-llm-duty'
import { ActionRecognitionLLMDuty } from '@/core/llm-manager/llm-duties/action-recognition-llm-duty'
import { SlotFillingLLMDuty } from '@/core/llm-manager/llm-duties/slot-filling-llm-duty'
import { SkillRouterLLMDuty } from '@/core/llm-manager/llm-duties/skill-router-llm-duty'
import { ActionCallingLLMDuty } from '@/core/llm-manager/llm-duties/action-calling-llm-duty'
import { CustomLLMDuty } from '@/core/llm-manager/llm-duties/custom-llm-duty'
import { LLM_MANAGER } from '@/core'

interface PostLLMInferenceSchema {
  body: {
    dutyType: LLMDuties
    input: string
    data: Record<string, unknown>
  }
}

const LLM_DUTIES_MAP = {
  [LLMDuties.SkillRouter]: SkillRouterLLMDuty,
  [LLMDuties.ActionCalling]: ActionCallingLLMDuty,
  [LLMDuties.SlotFilling]: SlotFillingLLMDuty,
  [LLMDuties.ActionRecognition]: ActionRecognitionLLMDuty,
  [LLMDuties.CustomNER]: CustomNERLLMDuty,
  [LLMDuties.Paraphrase]: ParaphraseLLMDuty,
  [LLMDuties.Conversation]: ConversationLLMDuty,
  [LLMDuties.Custom]: CustomLLMDuty
}

async function resolveLLMDuty(
  dutyType: LLMDuties
): Promise<(new (params: PostLLMInferenceSchema['body']) => {
  init: () => Promise<void>
  execute: () => Promise<LLMDutyResult | null>
}) | null> {
  if (dutyType === LLMDuties.ReAct) {
    /**
     * ReAct imports "@/core", which already instantiates the HTTP server stack.
     * Lazy-loading it here avoids a module-init cycle through this route file.
     */
    const { ReActLLMDuty } = await import(
      '@/core/llm-manager/llm-duties/react-llm-duty'
    )
    return ReActLLMDuty as new (params: PostLLMInferenceSchema['body']) => {
      init: () => Promise<void>
      execute: () => Promise<LLMDutyResult | null>
    }
  }

  return (LLM_DUTIES_MAP[dutyType] as (new (
    params: PostLLMInferenceSchema['body']
  ) => {
    init: () => Promise<void>
    execute: () => Promise<LLMDutyResult | null>
  }) | undefined) || null
}

export const postLLMInference: FastifyPluginAsync<APIOptions> = async (
  fastify,
  options
) => {
  fastify.route<{
    Body: PostLLMInferenceSchema['body']
  }>({
    method: 'POST',
    url: `/api/${options.apiVersion}/llm-inference`,
    handler: async (request, reply) => {
      const params = request.body

      try {
        if (!LLM_MANAGER.isLLMEnabled) {
          reply.statusCode = 400
          reply.send({
            success: false,
            status: reply.statusCode,
            code: 'llm_not_enabled',
            message: 'LLM is not enabled.'
          })

          return
        }

        const DutyClass = await resolveLLMDuty(params.dutyType)

        if (!DutyClass) {
          reply.statusCode = 400
          reply.send({
            success: false,
            status: reply.statusCode,
            code: 'llm_duty_not_supported',
            message: `LLM duty type "${params.dutyType}" not supported.`
          })

          return
        }

        let llmResult: LLMDutyResult | null = null

        if (params.dutyType === LLMDuties.Conversation) {
          const chitChatLLMDuty = new ConversationLLMDuty()

          if (params.data && params.data['useLoopHistory'] !== undefined) {
            await chitChatLLMDuty.init({
              useLoopHistory: params.data['useLoopHistory'] as boolean
            })
          } else {
            await chitChatLLMDuty.init()
          }

          llmResult = await chitChatLLMDuty.execute()
        } else {
          const duty = new DutyClass(params)
          await duty.init()
          llmResult = await duty.execute()
        }

        const responsePayload = llmResult || {}

        reply.send({
          success: true,
          status: 200,
          code: 'llm_duty_executed',
          message: 'LLM duty executed.',
          ...responsePayload
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : error
        reply.statusCode = 500
        reply.send({
          success: false,
          status: reply.statusCode,
          code: 'llm_duty_execution_error',
          message
        })
      }
    }
  })
}
