import fs from 'node:fs'

import type {
  ChatHistoryItem,
  Llama,
  LlamaChatSession,
  LlamaContext,
  LlamaModel
} from 'node-llama-cpp'

import {
  HAS_LLM,
  HAS_LLM_ACTION_RECOGNITION,
  HAS_LLM_NLG,
  HAS_WARM_UP_LLM_DUTIES,
  IS_PRODUCTION_ENV,
  LLM_ACTIONS_CLASSIFIER_PATH,
  LLM_MINIMUM_FREE_VRAM,
  LLM_MINIMUM_TOTAL_VRAM,
  LLM_NAME_WITH_VERSION,
  LLM_PATH,
  LLM_PROVIDER,
  LLM_SKILL_ROUTER_DUTY_SKILL_LIST_PATH
} from '@/constants'
import { LogHelper } from '@/helpers/log-helper'
import { SystemHelper } from '@/helpers/system-helper'
import { ConversationLogger } from '@/conversation-logger'
import { LLMDuties, LLMProviders } from '@/core/llm-manager/types'
import warmUpLlmDuties from '@/core/llm-manager/warm-up-llm-duties'
import { SYSTEM_PROMPT as SKILL_ROUTER_SYSTEM_PROMPT } from '@/core/llm-manager/llm-duties/skill-router-llm-duty'
import { StringHelper } from '@/helpers/string-helper'

interface CoreLLMDutyConfig {
  contextSize: number
  maxTokens?: number
  temperature?: number
}
interface CoreLLMDuties {
  [LLMDuties.SkillRouter]: CoreLLMDutyConfig
  [LLMDuties.ActionCalling]: CoreLLMDutyConfig
  [LLMDuties.CustomNER]: CoreLLMDutyConfig
  [LLMDuties.ActionRecognition]?: CoreLLMDutyConfig
  [LLMDuties.Paraphrase]?: CoreLLMDutyConfig
}
type LLMManagerLlama = Llama | null
type LLMManagerModel = LlamaModel | null
type LLMManagerContext = LlamaContext | null
type ActionsClassifierContent = string | null
type SkillListContent = string | null

// Set to 0 to use the maximum threads supported by the current machine hardware
// export const LLM_THREADS = 6

// const TRAINED_CONTEXT_SIZE = 8_192
const DEFAULT_CORE_LLM_DUTIES_CONTEXT_SIZE = 2_048
// Give some VRAM space because the TCP server uses some VRAM too
// const TCP_SERVER_DELTA = 2_048
/**
 * Core LLM duties are the ones that rely on the same context.
 * Every core LLM duty counts as one sequence.
 * This allows to dynamically allocate the context size.
 * The conversation duty is not included because it needs a dedicated context to load history
 */
const CORE_LLM_DUTIES: CoreLLMDuties = {
  [LLMDuties.SkillRouter]: {
    // Dynamic context size according to the skill list
    contextSize: 0,
    maxTokens: 12,
    temperature: 0
  },
  [LLMDuties.ActionCalling]: {
    /**
     * An action may have ~128 tokens,
     * a skill may contain 10 actions,
     * we double that
     */
    contextSize: 2_048,
    maxTokens: 512,
    temperature: 0
  },
  [LLMDuties.CustomNER]: {
    contextSize: DEFAULT_CORE_LLM_DUTIES_CONTEXT_SIZE
  },
  [LLMDuties.ActionRecognition]: {
    contextSize: DEFAULT_CORE_LLM_DUTIES_CONTEXT_SIZE
  },
  [LLMDuties.Paraphrase]: {
    contextSize: DEFAULT_CORE_LLM_DUTIES_CONTEXT_SIZE,
    temperature: 0.8
  }
}

/**
 * node-llama-cpp beta 3 docs:
 * @see https://github.com/withcatai/node-llama-cpp/pull/105
 */
export default class LLMManager {
  private static instance: LLMManager
  private _isLLMEnabled = false
  private _isLLMNLGEnabled = false
  private _isLLMActionRecognitionEnabled = false
  private _shouldWarmUpLLMDuties = false
  private _areLLMDutiesWarmedUp = false
  private _llama: LLMManagerLlama = null
  private _model: LLMManagerModel = null
  private _context: LLMManagerContext = null
  private _llmActionsClassifierContent: ActionsClassifierContent = null
  private _skillListContent: SkillListContent = null
  private _coreLLMDuties = CORE_LLM_DUTIES

  get llama(): Llama {
    return this._llama as Llama
  }

  get model(): LlamaModel {
    return this._model as LlamaModel
  }

  get context(): LlamaContext {
    return this._context as LlamaContext
  }

  get llmActionsClassifierContent(): ActionsClassifierContent {
    return this._llmActionsClassifierContent
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

  get isLLMNLGEnabled(): boolean {
    return this._isLLMNLGEnabled
  }

  get isLLMActionRecognitionEnabled(): boolean {
    return this._isLLMActionRecognitionEnabled
  }

  get shouldWarmUpLLMDuties(): boolean {
    return this._shouldWarmUpLLMDuties
  }

  get areLLMDutiesWarmedUp(): boolean {
    return this._areLLMDutiesWarmedUp
  }

  constructor() {
    if (!LLMManager.instance) {
      LogHelper.title('LLM Manager')
      LogHelper.success('New instance')

      LLMManager.instance = this
    }
  }

  /**
   * Post checking after loading the LLM
   */
  private async postCheck(): Promise<void> {
    if (this._isLLMActionRecognitionEnabled) {
      const isActionsClassifierPathFound = fs.existsSync(
        LLM_ACTIONS_CLASSIFIER_PATH
      )

      if (!isActionsClassifierPathFound) {
        throw new Error(
          `The LLM action classifier is not found at "${LLM_ACTIONS_CLASSIFIER_PATH}". Please run "npm run train" and retry.`
        )
      }
    }
  }

  /**
   * Load the skill router skill list and other future
   * files that only need to be loaded once
   */
  private async singleLoad(): Promise<void> {
    if (!this._model) {
      throw new Error('LLM model is not loaded yet')
    }

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

    /**
     * Set dynamic context size for the skill router duty
     * according to the skill list content
     */
    const completeSkillRouterSystemPrompt = StringHelper.findAndMap(
      SKILL_ROUTER_SYSTEM_PROMPT,
      {
        '%SKILL_LIST%': this._skillListContent || ''
      }
    )
    const skillRouterSystemPromptLength = this._model.tokenize(
      completeSkillRouterSystemPrompt as string
    ).length
    const skillRouterContextSize =
      skillRouterSystemPromptLength +
      (this._coreLLMDuties[LLMDuties.SkillRouter].maxTokens ?? 0) +
      // For more history context safety buffer
      256

    this._coreLLMDuties[LLMDuties.SkillRouter].contextSize =
      skillRouterContextSize

    LogHelper.title('LLM Manager')
    LogHelper.info(
      `Allocated ${skillRouterContextSize} context size for ${LLMDuties.SkillRouter} duty`
    )

    // TODO: delete LLM action recognition
    if (this._isLLMActionRecognitionEnabled) {
      try {
        this._llmActionsClassifierContent = await fs.promises.readFile(
          LLM_ACTIONS_CLASSIFIER_PATH,
          'utf-8'
        )

        LogHelper.title('LLM Manager')
        LogHelper.success('LLM action classifier has been loaded')
      } catch (e) {
        throw new Error(`Failed to load the LLM action classifier: ${e}`)
      }
    }
  }

  public async loadLLM(): Promise<void> {
    /**
     * Get Llama even if LLM is not enabled because it provides good utilities
     * for graphics card information and other useful stuff
     */
    try {
      const { LlamaLogLevel, getLlama } = await Function(
        'return import("node-llama-cpp")'
      )()

      this._llama = await getLlama({
        // logLevel: LlamaLogLevel.disabled
        logLevel: LlamaLogLevel.debug
      })
    } catch (e) {
      LogHelper.title('LLM Manager')
      LogHelper.error(`LLM Manager failed to load. Cannot get model: ${e}`)
    }

    if (!HAS_LLM) {
      LogHelper.title('LLM Manager')
      LogHelper.warning(
        'LLM is not enabled because you have explicitly disabled it'
      )

      return
    }

    if (LLM_PROVIDER === LLMProviders.Local) {
      const [freeVRAMInGB, totalVRAMInGB] = await Promise.all([
        SystemHelper.getFreeVRAM(),
        SystemHelper.getTotalVRAM()
      ])
      const isLLMPathFound = fs.existsSync(LLM_PATH)
      const isCurrentFreeRAMEnough = LLM_MINIMUM_FREE_VRAM <= freeVRAMInGB
      const isTotalRAMEnough = LLM_MINIMUM_TOTAL_VRAM <= totalVRAMInGB

      /**
       * In case the LLM is not set up and
       * the current free RAM is enough to load the LLM
       */
      if (!isLLMPathFound && isCurrentFreeRAMEnough) {
        LogHelper.title('LLM Manager')
        LogHelper.warning(
          'The LLM is not set up yet whereas the current free RAM is enough to enable it. You can run the following command to set it up: "npm install"'
        )

        return
      }
      /**
       * In case the LLM is set up and
       * the current free RAM is not enough to load the LLM
       */
      if (isLLMPathFound && !isCurrentFreeRAMEnough) {
        LogHelper.title('LLM Manager')
        LogHelper.warning(
          'There is not enough free RAM to load the LLM. So the LLM will not be enabled.'
        )

        return
      }

      /**
       * In case the LLM is not found and
       * the total RAM is enough to load the LLM
       */
      if (!isLLMPathFound && isTotalRAMEnough) {
        LogHelper.title('LLM Manager')
        LogHelper.warning(
          `LLM is not enabled because it is not found at "${LLM_PATH}". Run the following command to set it up: "npm install"`
        )

        return
      }

      try {
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-expect-error
        this._model = await this._llama.loadModel({
          modelPath: LLM_PATH,
          // Option available from node-llama-cpp@3.0.0-beta.38 but cannot compile well yet (in 2024-08-01)
          defaultContextFlashAttention: true
        })

        if (HAS_LLM_NLG) {
          this._isLLMNLGEnabled = true
        } else {
          // Remove the paraphrase duty if the NLG is not enabled
          delete this._coreLLMDuties[LLMDuties.Paraphrase]

          /*this._coreLLMDuties.splice(
            this._coreLLMDuties.indexOf(LLMDuties.Paraphrase),
            1
          )*/
        }

        if (HAS_LLM_ACTION_RECOGNITION) {
          this._isLLMActionRecognitionEnabled = true
        } else {
          // Remove the action recognition duty if the action recognition is not enabled
          delete this._coreLLMDuties[LLMDuties.ActionRecognition]

          /*this._coreLLMDuties.splice(
            this._coreLLMDuties.indexOf(LLMDuties.ActionRecognition),
            1
          )*/
        }

        /**
         * TODO now:
         * [ok] 1. Dynamic context size (min and max) according to every LLM duty. If LLM duty does not have a specific context size, use the default one.
         *  To do this, hold a contextSize manager state in LLM Manager for every duty and set it from LLM manager. e.g. SkillRouterLLMDuty.contextSize = xxx, because LLM Manager isn't initialized yet.
         *  Use CORE_LLM_DUTIES and loop in, create a "new Set"?
         * [ok] 2. Skill router duty should have a dynamic context size according to the number of skills.
         * [ok] 3. Centralize LLM duties config in this file (maxTokens, contextSize, temperature, etc.)
         * 4. Create function calling LLM duty.
         *   [ok] 4.a. Provide more context (for skill router + action calling) to handle such cases: "Show me the groceries list" then "The lessons list too"
         *   4.b. Handle missing params:
         *     Start to reorganize everything correctly:
         *      Fully implement the skill router and action calling duties
         *      Implement duties correctly with the NLU class (create dedicated methods in NLU class)
         *      If a skill only has one action, then directly execute it after the skill router duty (no need to go through the action calling duty)
         *      Create new structure tools in bridges with skills folder; remove domains (no need to implement tools for now)
         *      Create the fake weather skill (implement tools)
         *      Implement locales/{lang}.json in skills with new properties, and dynamic translation %PLACEHOLDER%
         *      (PLAN CHANGED, DO NOT DO THIS) -> Implement config/{lang}.json in skills with new properties (cf. Trello card description)
         *      Implement slot filling duty > missing params > conversation state
         *      Research (redevelop next_action?) and create resolver duty / loop in skills (guess the number, rochambeau, MBTI test, etc.)
         *      If action is not found, then fallback to a duty for chitchat/help with Leon's personality
         *      Implement toolkits and tools (E.g. weather toolkit (folder) > several providers (each provider is a tool class, they must contain the same methods between each other as most as possible). Cf. MVP. And create the toolkit finder duty logic when the Leon instance includes +64 skills
         *      Create real weather skill with tools (one tool for each provider, can choose provider in skill settings)
         *      Pass NLP.js built-in entities (numbers, duration, etc.) to actions as well as the function calling arguments. Can merge them, so skill developers will have more data
         *      After everything is confirmed, then migrate all skills with the new configs
         *      Clean up NLU class, etc. if not used anymore
         *
         *     In DSL, at the same level as "type": "logic", need to add field: "optional_params": []
         *      If this param is missing, but is included in the optional_params array, then still execute the action and let the skill developer handles the logic
         *
         *     Create a conversation state
         *     Create a Slot Filling duty to fill slots and complete query before skill action execution
         *
         *     Develop slots/required params pre-hook before skill execution (human in the loop). Slots/required params should be handled by the core
         *     Skill developers can add a "executePreHook()" method that will be called before the skill execution
         *
         *     Handle new skill config props same as I mentioned in the Trello card description
         *
         *     Still need to create config/{lang}.json in skills to handle customized properties of the skill configs. E.g. missing params follow-up questions, etc.
         *   4.c. Add system prompt context size log info for each LLM duty
         * 5. Action calling duty warm up
         * 6. Multi-turn conversation (resolve LLM duty). Cf. MVP notes
         * 7. Once actions work well, then try to enable the history again for action calling and skill router duties. Because it will save messages in the history since actions aren't broken anymore. Just load 8 messages.
         *
         * Needed duties:
         * - skill router
         * - function calling
         * - resolver
         * - paraphrase
         * - custom NER
         * - conversation
         * - summarizer??? (skill developers can choose to make use of this duty from their skill, so it can take the original user query, all the data grabbed after the skill execution, and summarize it). E.g. "Did I added tomatoes to my shopping list?" > get_list_items response > "Yes, you added tomatoes to your shopping list."
         * - custom
         */

        try {
          // Load files that only need to be loaded once
          await this.singleLoad()
        } catch (e) {
          LogHelper.title('LLM Manager')
          LogHelper.error(`LLM Manager failed to single load: ${e}`)

          process.exit(1)
        }

        const coreLLMContextSizeValues = Object.values(this._coreLLMDuties).map(
          (duty) => duty.contextSize
        )
        const minCoreLLMContextSize = Math.min(...coreLLMContextSizeValues)
        const maxCoreLLMContextSize = Math.max(...coreLLMContextSizeValues)

        this._context = await this._model.createContext({
          sequences: Object.keys(this._coreLLMDuties).length,
          // threads: LLM_THREADS,
          contextSize: {
            min: minCoreLLMContextSize,
            max: maxCoreLLMContextSize
          }
        })
        this._isLLMEnabled = true

        LogHelper.title('LLM Manager')
        LogHelper.success(`${LLM_NAME_WITH_VERSION} LLM has been loaded`)
      } catch (e) {
        LogHelper.title('LLM Manager')
        LogHelper.error(`LLM Manager failed to load. Cannot load model: ${e}`)
      }
    } else {
      if (!Object.values(LLMProviders).includes(LLM_PROVIDER as LLMProviders)) {
        LogHelper.warning(
          `The LLM provider "${LLM_PROVIDER}" does not exist or is not yet supported`
        )

        return
      }

      this._isLLMEnabled = true

      if (HAS_LLM_NLG) {
        this._isLLMNLGEnabled = true
      }
      if (HAS_LLM_ACTION_RECOGNITION) {
        this._isLLMActionRecognitionEnabled = true
      }
    }

    this._shouldWarmUpLLMDuties =
      (IS_PRODUCTION_ENV || HAS_WARM_UP_LLM_DUTIES) &&
      this._isLLMEnabled &&
      LLM_PROVIDER === LLMProviders.Local

    try {
      // Post checking after loading the LLM
      await this.postCheck()
    } catch (e) {
      LogHelper.title('LLM Manager')
      LogHelper.error(`LLM Manager failed to post check: ${e}`)

      process.exit(1)
    }

    if (this._shouldWarmUpLLMDuties) {
      this.warmUpLLMDuties()
    }
  }

  public async warmUpLLMDuties(): Promise<void> {
    try {
      LogHelper.title('LLM Manager')
      LogHelper.info('Warming up LLM duties...')

      await warmUpLlmDuties(Object.keys(this._coreLLMDuties) as LLMDuties[])

      this._areLLMDutiesWarmedUp = true
    } catch (e) {
      LogHelper.title('LLM Manager')
      LogHelper.error(`LLM Manager failed to warm up LLM duties: ${e}`)

      this._areLLMDutiesWarmedUp = false
    }
  }

  public async loadHistory(
    conversationLogger: ConversationLogger,
    session: LlamaChatSession,
    options?: { nbOfLogsToLoad?: number }
  ): Promise<ChatHistoryItem[]> {
    const [systemMessage] = session.getChatHistory()
    let conversationLogs

    if (options) {
      conversationLogs = await conversationLogger.load(options)
    } else {
      conversationLogs = await conversationLogger.load()
    }

    if (!conversationLogs) {
      return [systemMessage] as ChatHistoryItem[]
    }

    const history =
      conversationLogs?.map((messageRecord) => {
        if (!messageRecord || !messageRecord.message) {
          messageRecord.message = ''
        }

        if (messageRecord.who === 'owner') {
          return {
            type: 'user',
            text: messageRecord.message
          }
        }

        return {
          type: 'model',
          response: [messageRecord.message]
        }
      }) ?? []

    return [systemMessage, ...history] as ChatHistoryItem[]
  }
}
