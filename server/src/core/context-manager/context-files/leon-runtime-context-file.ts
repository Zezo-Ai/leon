import {
  AGENT_LLM_TARGET,
  LEON_VERSION,
  WORKFLOW_LLM_TARGET,
  NODEJS_BRIDGE_VERSION,
  PYTHON_BRIDGE_VERSION,
  PYTHON_TCP_SERVER_VERSION
} from '@/constants'
import { DateHelper } from '@/helpers/date-helper'
import { RuntimeHelper } from '@/helpers/runtime-helper'
import { ContextFile } from '@/core/context-manager/context-file'
import { ContextProbeHelper } from '@/core/context-manager/context-probe-helper'
import { ROUTING_STATE } from '@/core/routing-state'
import {
  getActiveLLMTarget,
  getRoutingModeLLMDisplay
} from '@/core/llm-manager/llm-routing'

interface LeonRuntimeContextResolvers {
  getWorkflowLLMName: () => string
  getAgentLLMName: () => string
  getLocalLLMName: () => string
}

export class LeonRuntimeContextFile extends ContextFile {
  public readonly filename = 'LEON_RUNTIME.md'
  public readonly ttlMs: number

  public constructor(
    private readonly probeHelper: ContextProbeHelper,
    private readonly resolvers: LeonRuntimeContextResolvers,
    ttlMs: number
  ) {
    super()
    this.ttlMs = ttlMs
  }

  public generate(): string {
    const nodeProbe = this.probeHelper.probeCommandVersion(
      RuntimeHelper.getNodeBinPath(),
      ['--version']
    )
    const pnpmProbe = this.probeHelper.probeCommandVersion(
      RuntimeHelper.getPNPMBinPath(),
      ['--version']
    )
    const gitProbe = this.probeHelper.probeCommandVersion('git', ['--version'])
    const workflowLlmName = this.resolvers.getWorkflowLLMName()
    const agentLlmName = this.resolvers.getAgentLLMName()
    const localLlmName = this.resolvers.getLocalLLMName()
    const routingMode = ROUTING_STATE.getRoutingMode()
    const llmDisplay = getRoutingModeLLMDisplay(
      routingMode,
      WORKFLOW_LLM_TARGET,
      AGENT_LLM_TARGET
    )
    const activeLLMTarget = getActiveLLMTarget(
      routingMode,
      WORKFLOW_LLM_TARGET,
      AGENT_LLM_TARGET
    )

    return [
      `> Runtime versions, routing/providers, LLMs and bridge/toolchain availability. I am running Leon ${LEON_VERSION || 'unknown'} on Node ${process.version}; routing mode ${routingMode}; ${llmDisplay.heading.toLowerCase()} ${llmDisplay.value}; local LLM ${localLlmName}; managed node ${this.probeHelper.formatCommandProbe(nodeProbe)}, managed pnpm ${this.probeHelper.formatCommandProbe(pnpmProbe)}, git ${this.probeHelper.formatCommandProbe(gitProbe)}.`,
      '# LEON_RUNTIME',
      `- Generated at: ${DateHelper.getDateTime()}`,
      `- Leon version: ${LEON_VERSION || 'unknown'}`,
      `- Node.js version: ${process.version}`,
      `- Routing mode: ${routingMode}`,
      `- ${llmDisplay.heading}: ${llmDisplay.value}`,
      `- Active LLM provider: ${activeLLMTarget.provider}`,
      ...(routingMode === 'smart'
        ? [
            `- Workflow LLM provider: ${WORKFLOW_LLM_TARGET.provider}`,
            `- Agent LLM provider: ${AGENT_LLM_TARGET.provider}`,
            `- Workflow LLM: ${workflowLlmName}`,
            `- Agent LLM: ${agentLlmName}`
          ]
        : []),
      `- Local LLM: ${localLlmName}`,
      `- Managed Node.js: ${this.probeHelper.formatCommandProbe(nodeProbe)}`,
      `- Managed pnpm: ${this.probeHelper.formatCommandProbe(pnpmProbe)}`,
      `- git: ${this.probeHelper.formatCommandProbe(gitProbe)}`,
      `- Node.js bridge version: ${NODEJS_BRIDGE_VERSION}`,
      `- Python bridge version: ${PYTHON_BRIDGE_VERSION}`,
      `- Python TCP server version: ${PYTHON_TCP_SERVER_VERSION}`
    ].join('\n')
  }
}
