import fs from 'node:fs'

import {
  AGENT_LLM_TARGET,
  LEON_ROUTING_MODE,
  LLM_SKILL_ROUTER_DUTY_SKILL_LIST_PATH,
  WORKFLOW_LLM_TARGET
} from '@/constants'
import { ConversationLogger } from '@/conversation-logger'
import { SYSTEM_PROMPT as SKILL_ROUTER_SYSTEM_PROMPT } from '@/core/llm-manager/llm-duties/skill-router-llm-duty'
import { LLMDuties } from '@/core/llm-manager/types'
import { LogHelper } from '@/helpers/log-helper'
import { StringHelper } from '@/helpers/string-helper'
import { getRoutingModeLLMDisplay } from '@/core/llm-manager/llm-routing'

interface CoreLLMDutyConfig {
  contextSize: number
  maxTokens?: number
  temperature?: number
  thoughtTokensBudget?: number
}

interface CoreLLMDuties {
  [LLMDuties.SkillRouter]: CoreLLMDutyConfig
  [LLMDuties.ActionCalling]: CoreLLMDutyConfig
  [LLMDuties.SlotFilling]: CoreLLMDutyConfig
  [LLMDuties.Paraphrase]?: CoreLLMDutyConfig
}

type SkillListContent = string | null

const DEFAULT_CORE_LLM_DUTIES_CONTEXT_SIZE = 2_048

const CORE_LLM_DUTIES: CoreLLMDuties = {
  [LLMDuties.SkillRouter]: {
    contextSize: 0,
    maxTokens: 12,
    thoughtTokensBudget: 0,
    temperature: 0
  },
  [LLMDuties.ActionCalling]: {
    contextSize: 2_048,
    maxTokens: 512,
    thoughtTokensBudget: 64,
    temperature: 0.8
  },
  [LLMDuties.SlotFilling]: {
    contextSize: 1_024,
    maxTokens: 512,
    thoughtTokensBudget: 128,
    temperature: 0.2
  },
  [LLMDuties.Paraphrase]: {
    contextSize: DEFAULT_CORE_LLM_DUTIES_CONTEXT_SIZE,
    thoughtTokensBudget: 0,
    temperature: 0.8
  }
}

function cloneCoreDutyConfig(): CoreLLMDuties {
  return {
    [LLMDuties.SkillRouter]: { ...CORE_LLM_DUTIES[LLMDuties.SkillRouter] },
    [LLMDuties.ActionCalling]: {
      ...CORE_LLM_DUTIES[LLMDuties.ActionCalling]
    },
    [LLMDuties.SlotFilling]: { ...CORE_LLM_DUTIES[LLMDuties.SlotFilling] },
    ...(CORE_LLM_DUTIES[LLMDuties.Paraphrase]
      ? {
          [LLMDuties.Paraphrase]: {
            ...CORE_LLM_DUTIES[LLMDuties.Paraphrase]
          }
        }
      : {})
  }
}

export default class LLMManager {
  private static instance: LLMManager
  private _isLLMEnabled = false
  // These placeholders remain for compatibility with code paths that still
  // compile against the old local-session surface, even though Local is disabled.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _llama: any = null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _localModel: any = null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _context: any = null
  private _skillListContent: SkillListContent = null
  private _coreLLMDuties = cloneCoreDutyConfig()

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  get llama(): any {
    return this._llama
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  get model(): any {
    return this._localModel
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  get context(): any {
    return this._context
  }

  get skillListContent(): SkillListContent {
    return this._skillListContent
  }

  get coreLLMDuties(): CoreLLMDuties {
    return this._coreLLMDuties
  }

  get isLLMEnabled(): boolean {
    return this._isLLMEnabled
  }

  constructor() {
    if (!LLMManager.instance) {
      LogHelper.title('LLM Manager')
      LogHelper.success('New instance')

      LLMManager.instance = this
    }
  }

  /**
   * Load files that only need to be loaded once.
   */
  private async singleLoad(): Promise<void> {
    try {
      this._skillListContent = await fs.promises.readFile(
        LLM_SKILL_ROUTER_DUTY_SKILL_LIST_PATH,
        'utf-8'
      )

      LogHelper.title('LLM Manager')
      LogHelper.success('Skill router skill list has been loaded')
    } catch (e) {
      throw new Error(`Failed to load the skill router skill list: ${e}`)
    }

    const completeSkillRouterSystemPrompt = StringHelper.findAndMap(
      SKILL_ROUTER_SYSTEM_PROMPT,
      {
        '{{ SKILL_LIST }}': this._skillListContent || ''
      }
    )
    const estimatedPromptTokens = Math.ceil(
      completeSkillRouterSystemPrompt.length / 4
    )
    const skillRouterContextSize =
      estimatedPromptTokens +
      (this._coreLLMDuties[LLMDuties.SkillRouter].maxTokens ?? 0) +
      256

    this._coreLLMDuties[LLMDuties.SkillRouter].contextSize =
      skillRouterContextSize

    LogHelper.title('LLM Manager')
    LogHelper.info(
      `Allocated ${skillRouterContextSize} context size for ${LLMDuties.SkillRouter} duty`
    )
  }

  public async init(): Promise<void> {
    LogHelper.time('LLM Manager init')
    this._isLLMEnabled = true

    try {
      await this.singleLoad()
    } catch (e) {
      LogHelper.title('LLM Manager')
      LogHelper.error(`LLM Manager failed to single load: ${e}`)

      process.exit(1)
    }

    LogHelper.title('LLM Manager')
    const llmDisplay = getRoutingModeLLMDisplay(
      LEON_ROUTING_MODE,
      WORKFLOW_LLM_TARGET,
      AGENT_LLM_TARGET
    )
    LogHelper.success(`LLM manager initialized with ${llmDisplay.value}`)
    LogHelper.timeEnd('LLM Manager init')
  }

  public async loadHistory(
    conversationLogger: ConversationLogger,
    session: { getChatHistory?: () => unknown[] },
    options?: { nbOfLogsToLoad?: number }
  ): Promise<unknown[]> {
    const [systemMessage] = session.getChatHistory?.() ?? []
    const conversationLogs = options
      ? await conversationLogger.load(options)
      : await conversationLogger.load()

    if (!conversationLogs) {
      return systemMessage ? [systemMessage] : []
    }

    const history = conversationLogs.map((messageRecord) => {
      const message = messageRecord?.message || ''

      if (messageRecord?.who === 'owner') {
        return {
          type: 'user',
          text: message
        }
      }

      return {
        type: 'model',
        response: [message]
      }
    })

    return systemMessage ? [systemMessage, ...history] : history
  }
}
