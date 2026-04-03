import fs from 'node:fs'
import { execFileSync } from 'node:child_process'

import {
  AGENT_LLM_TARGET,
  API_VERSION,
  GITHUB_URL,
  HAS_STT,
  HAS_TTS,
  INSTANCE_ID,
  IS_TELEMETRY_ENABLED,
  LEON_FILE_PATH,
  LEON_VERSION,
  STT_PROVIDER,
  TTS_PROVIDER,
  WORKFLOW_LLM_TARGET
} from '@/constants'
import {
  BuiltInCommand,
  type BuiltInCommandExecutionContext,
  type BuiltInCommandExecutionResult
} from '@/commands/built-in-command'
import { createListResult } from '@/commands/built-in-command-renderer'
import { CONFIG_STATE } from '@/core/config-states/config-state'
import { DateHelper } from '@/helpers/date-helper'
import { SystemHelper } from '@/helpers/system-helper'
import {
  getActiveLLMTarget,
  getRoutingModeLLMDisplay
} from '@/core/llm-manager/llm-routing'

interface LeonMetadata {
  birthDate?: number
}

const ENABLED_LABEL = 'enabled'
const DISABLED_LABEL = 'disabled'
const SHORT_COMMIT_HASH_ARGS = ['rev-parse', '--short', 'HEAD']

function getLeonMetadata(): LeonMetadata {
  if (!fs.existsSync(LEON_FILE_PATH)) {
    return {}
  }

  try {
    return JSON.parse(fs.readFileSync(LEON_FILE_PATH, 'utf8')) as LeonMetadata
  } catch {
    return {}
  }
}

function formatBooleanStatus(isEnabled: boolean): string {
  return isEnabled ? ENABLED_LABEL : DISABLED_LABEL
}

function formatUptime(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3_600)
  const minutes = Math.floor((totalSeconds % 3_600) / 60)
  const seconds = Math.floor(totalSeconds % 60)

  return `${hours}h ${minutes}m ${seconds}s`
}

function getShortCommitHash(): string {
  try {
    return execFileSync('git', SHORT_COMMIT_HASH_ARGS, {
      cwd: process.cwd(),
      encoding: 'utf8'
    }).trim()
  } catch {
    return 'unknown'
  }
}

export class StatusCommand extends BuiltInCommand {
  protected override description =
    'Display Leon runtime information, versions, and active routing details.'
  protected override icon_name = 'ri-pulse-line'
  protected override supported_usages = ['/status']

  public constructor() {
    super('status')
  }

  public override async execute(
    context: BuiltInCommandExecutionContext
  ): Promise<BuiltInCommandExecutionResult> {
    void context

    const routingModeState = CONFIG_STATE.getRoutingModeState()
    const leonMetadata = getLeonMetadata()
    const routingMode = routingModeState.getRoutingMode()
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
    const { LLM_PROVIDER } = await import('@/core')
    const currentUsedModelName =
      routingMode === 'smart'
        ? `workflow=${LLM_PROVIDER.workflowLLMName || 'unknown'}, agent=${LLM_PROVIDER.agentLLMName || 'unknown'}`
        : routingMode === 'agent'
          ? LLM_PROVIDER.agentLLMName
          : LLM_PROVIDER.workflowLLMName
    const items = [
      {
        label: 'Instance ID',
        value: INSTANCE_ID || 'unknown'
      },
      {
        label: 'Instance birth date',
        value: leonMetadata.birthDate
          ? DateHelper.getDateTime(leonMetadata.birthDate)
          : 'unknown'
      },
      {
        label: 'Leon version',
        value: `${LEON_VERSION || 'unknown'} (${getShortCommitHash()})`
      },
      {
        label: 'Routing mode',
        value: routingMode
      },
      {
        label: llmDisplay.heading,
        value: llmDisplay.value
      },
      {
        label: 'Current used model name',
        value: currentUsedModelName || 'unknown'
      },
      {
        label: 'Active LLM provider',
        value: activeLLMTarget.provider
      },
      {
        label: 'Active LLM target',
        value: activeLLMTarget.label
      },
      {
        label: 'Workflow model name',
        value: LLM_PROVIDER.workflowLLMName || 'unknown'
      },
      {
        label: 'Agent model name',
        value: LLM_PROVIDER.agentLLMName || 'unknown'
      },
      {
        label: 'Local model name',
        value: LLM_PROVIDER.localLLMName || 'unknown'
      },
      {
        label: 'STT',
        value: `${formatBooleanStatus(HAS_STT)} (${STT_PROVIDER || 'none'})`
      },
      {
        label: 'TTS',
        value: `${formatBooleanStatus(HAS_TTS)} (${TTS_PROVIDER || 'none'})`
      },
      {
        label: 'Telemetry',
        value: formatBooleanStatus(IS_TELEMETRY_ENABLED)
      },
      {
        label: 'Time zone',
        value: DateHelper.getTimeZone()
      },
      {
        label: 'Node.js version',
        value: SystemHelper.getNodeJSVersion()
      },
      {
        label: 'Process ID',
        value: String(process.pid)
      },
      {
        label: 'Uptime',
        value: formatUptime(process.uptime())
      },
      {
        label: 'Platform',
        value: `${process.platform}/${process.arch}`
      },
      {
        label: 'HTTP API version',
        value: API_VERSION
      },
      {
        label: 'Repository',
        value: GITHUB_URL
      }
    ]

    return {
      status: 'completed',
      result: createListResult({
        title: 'Leon Status',
        tone: 'info',
        items
      })
    }
  }
}
