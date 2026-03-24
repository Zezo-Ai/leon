import type { FastifyPluginAsync } from 'fastify'

import type { APIOptions } from '@/core/http-server/http-server'
import {
  AGENT_LLM_TARGET,
  LEON_VERSION,
  HAS_AFTER_SPEECH,
  HAS_STT,
  HAS_TTS,
  STT_PROVIDER,
  TTS_PROVIDER,
  IS_TELEMETRY_ENABLED,
  LEON_ROUTING_MODE,
  SHOULD_START_PYTHON_TCP_SERVER,
  WORKFLOW_LLM_TARGET
} from '@/constants'
import { LLM_PROVIDER, PERSONA } from '@/core'
import { LogHelper } from '@/helpers/log-helper'
import { DateHelper } from '@/helpers/date-helper'
import { SystemHelper } from '@/helpers/system-helper'
import {
  getActiveLLMTarget,
  getRoutingModeLLMDisplay
} from '@/core/llm-manager/llm-routing'

export const getInfo: FastifyPluginAsync<APIOptions> = async (
  fastify,
  options
) => {
  fastify.route({
    method: 'GET',
    url: `/api/${options.apiVersion}/info`,
    handler: async (_request, reply) => {
      LogHelper.title('GET /info')
      const message = 'Information pulled.'
      LogHelper.success(message)

      const [
        gpuDeviceNames,
        graphicsComputeAPI,
        totalVRAM,
        freeVRAM,
        usedVRAM
      ] = await Promise.all([
        SystemHelper.getGPUDeviceNames(),
        SystemHelper.getGraphicsComputeAPI(),
        SystemHelper.getTotalVRAM(),
        SystemHelper.getFreeVRAM(),
        SystemHelper.getUsedVRAM()
      ])
      const activeLLMTarget = getActiveLLMTarget(
        LEON_ROUTING_MODE,
        WORKFLOW_LLM_TARGET,
        AGENT_LLM_TARGET
      )
      const llmDisplay = getRoutingModeLLMDisplay(
        LEON_ROUTING_MODE,
        WORKFLOW_LLM_TARGET,
        AGENT_LLM_TARGET
      )

      reply.send({
        success: true,
        status: 200,
        code: 'info_pulled',
        message,
        after_speech: HAS_AFTER_SPEECH,
        telemetry: IS_TELEMETRY_ENABLED,
        timeZone: DateHelper.getTimeZone(),
        gpu: gpuDeviceNames[0],
        graphicsComputeAPI,
        totalVRAM,
        freeVRAM,
        usedVRAM,
        llm: {
          enabled: WORKFLOW_LLM_TARGET.isEnabled || AGENT_LLM_TARGET.isEnabled,
          heading: llmDisplay.heading,
          display: llmDisplay.value,
          provider: activeLLMTarget.provider,
          model: activeLLMTarget.model,
          workflow: WORKFLOW_LLM_TARGET.label,
          agent: AGENT_LLM_TARGET.label,
          workflowEnabled: WORKFLOW_LLM_TARGET.isEnabled,
          agentEnabled: AGENT_LLM_TARGET.isEnabled,
          workflowProvider: WORKFLOW_LLM_TARGET.provider,
          agentProvider: AGENT_LLM_TARGET.provider,
          workflowModel: LLM_PROVIDER.workflowLLMName,
          agentModel: LLM_PROVIDER.agentLLMName,
          localModel: LLM_PROVIDER.localLLMName
        },
        stt: {
          enabled: HAS_STT,
          provider: STT_PROVIDER
        },
        tts: {
          enabled: HAS_TTS,
          provider: TTS_PROVIDER
        },
        routingMode: LEON_ROUTING_MODE,
        tcpServer: {
          enabled: SHOULD_START_PYTHON_TCP_SERVER
        },
        mood: {
          type: PERSONA.mood.type,
          emoji: PERSONA.mood.emoji
        },
        version: LEON_VERSION
      })
    }
  })
}
