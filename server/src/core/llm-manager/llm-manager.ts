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
  thoughtTokensBudget?: number
}
interface CoreLLMDuties {
  [LLMDuties.SkillRouter]: CoreLLMDutyConfig
  [LLMDuties.ActionCalling]: CoreLLMDutyConfig
  [LLMDuties.SlotFilling]: CoreLLMDutyConfig
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
    thoughtTokensBudget: 0,
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
    thoughtTokensBudget: 64,
    /**
     * Allow creative thinking. E.g. "Think of 3 snacks I can buy for Max, and add them to the list of your choice"
     */
    temperature: 0.8
  },
  [LLMDuties.SlotFilling]: {
    contextSize: 1_024,
    maxTokens: 512,
    thoughtTokensBudget: 128,
    temperature: 0.2
  },
  [LLMDuties.CustomNER]: {
    contextSize: DEFAULT_CORE_LLM_DUTIES_CONTEXT_SIZE
  },
  [LLMDuties.ActionRecognition]: {
    contextSize: DEFAULT_CORE_LLM_DUTIES_CONTEXT_SIZE
  },
  [LLMDuties.Paraphrase]: {
    contextSize: DEFAULT_CORE_LLM_DUTIES_CONTEXT_SIZE,
    thoughtTokensBudget: 0,
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
         *      [ok] Fully implement the skill router and action calling duties
         *      [ok] Implement duties correctly with the NLU class (create dedicated methods in NLU class)
         *      [ok] Pass NLP.js built-in entities (numbers, duration, etc.) to actions as well as the function calling arguments. Can merge them, so skill developers will have more data
         *      [ok] Update NLU result object to pass to the brain execution
         *      [ok] newEntities, contextEntities, newArguments, contextArguments, newSentiment, contextSentiment, etc.
         *        - new = new utterance; context = all previous utterances within the same context
         *      [ok] Update NLU result to get the current skill config (to get flow later) and current action config
         *      [ok] "actionFunction" in main.ts and main.py bridges. actionFunction() + TS -> use camelCase; PY -> use snake_case for params naming. Correctly name params, just use single object, same as React component signature
         *      [ok] Continue on "handleLogicActionSkill"
         *      [ok] Use esbuild instead of ncc. Try to compile but has error need to follow up
         *      [ok] Fix Python skill execution. Somehow the action file name needed to be renamed from "run.py" to "greet.py"
         *      [ok] Implement helper getSkillActionLocaleConfig
         *      [ok] Fix context duplicate data because of "await this.updateNLUProcessResult(...)"
         *      [ok] Copy the "good_bye" skill and implement the dialog type. Need to handle the "locales/{lang}.json" structure first since it's based on the answers
         *      [ok] In dialog skills answers, check from the context if there is any actionArgument or entities that would match any {{ PLACEHOLDER }} and replace it with the actual value
         *      [ok] Refactor brain with logic/dialog static class handlers + cf. Copilot chat for how to split static methods within the dialog action handler class
         *      [ok] Implement the locale to the timer skill. And verify all actions
         *      [ok] In bridges/nodejs/src/constants.ts and bridges/python/src/constants.py, change the SKILL_CONFIG by removing the config/{lang}.json and only use the locale config. Need to add "variables" and "widget_contents" to the local config too. When implementing variables, check for dialog skill answers if it has conflict
         *      [ok] When action calling, also need to provide non-missing action arguments or need to set the active state with collected params OR fix the slot filling, it needs to push the slots into the context, not only the active state
         *      [ok] Fix skill output chunk parsing. Add new line and read line by line in the brain. skillOutput is empty on data end, need to check; long stdout output because now we send much more data? leon.py, fix widgets (test with todo list skill, etc.) "Add 1l of water, a pillow and a pair of socks to my shopping list please"
         *      [ok] Verify to_do list widget onChange (entities -> action argument) when click checkbox
         *      [ok] Reimplement HTTP APIs for watch (fetch [to do now] + run action [ok]) as per core rewrite changes
         *      [ok] Related to the issue below. For the action calling duty, it tries to run multiple tools: "Create a computer list, think of the main components of a computer and add them to the list". Need to create an action call queue that will run the actions one by one, and wait for the previous action to finish before running the next one. This will allow to run multiple actions in a single utterance, e.g. "Create a computer list, think of the main components of a computer and add them to the list" -> should run 2 actions:
         *      (only allow sequential actions calling within the same skill; for other skills we need to work on the autonomous mode later)
         *      <tool_call>
         * {"name": "create_list", "arguments": {"list_name": "computer"}}
         * </tool_call>
         * <tool_call>
         * {"name": "add_todos", "arguments": {"list_name": "computer", "items": ["CPU", "RAM", "Hard Drive", "Motherboard", "Power Supply"]}}
         * </tool_call>
         *      [ok] (related to below issue 2025-08-19) when "clean active state", should we also clean action router duty and skill router duty? The action router duty seems to be overloaded after a while, cf. usedInputTokens
         *      [ok] "Add tomatoes, potatoes, 1kg of rice to the shopping list" -> issue, it will grab previous list. "Check potatoes from the shopping list" -> does not check because does not go through end data, only on data
         *      [ok] Add "common_answers" to locale config for reusable answers across actions (leon.ts + leon.py); test it with the todo list skill (list_does_not_exist, list_already_exists, etc.)
         *      TODO NEXT 2025-08-22: instead of creating a new multi-tasking duty, maybe we can use the next action arguments? E.g. for "replay" we could have a boolean. By using param description, should automatically set true or false when the param type is boolean so skill devs don't need to care about this. Or just use our global resolver?
         *      TODO NEXT 2025-08-03: maybe there is no need for a flow for the translator skill? A simple action should be enough with the 2 params (target_language and text_to_translate). Maybe I should just implement the loop concept for this case? Test the following cases: flow -> 1. "Can you please help me to translate some text into French?" > "The sky is blue"; 2. "Please help me to translate some text" > "Into French please" > "The sky is blue"; 3. "Please translate this text into French: the sky is blue"; 4. Please translate this text "the sky is blue" > "Into French"
         *      TODO NEXT 2025-07-30: continue to rebuild the translator-poc skill. Need to implement the flow and think carefully about the whole set_up answers system, etc.
         *      TODO NEXT 2025-07-23: rebuild the "good_bye", "partner_assistant", "color" and "translator-poc" skills
         *      TODO NEXT 2025-07-29: todo list skill does not work properly. E.g. "Please add a book to my shopping list". It does not do slot filling well anymore
         *      TODO NEXT 2025-07-18: copy translator-poc skill (do this later since it involves the loop concept), handle dialog action logic. Need to handle the "locales/{lang}.json" structure first since it's based on the answers
         *      TODO NEXT 2025-08-03: fix bridge main.py with optional params (params and params_helper), e.g. with partner assistant action
         *      In fetch-widget/get.ts, need to execute new brain method; and replace "currentEntities", "classification" with the new structure
         *      Delete or refactor the chunks where there are "TODO: core rewrite" comments
         *      Rename all Python actions from "run.py" to actual action name, e.g. "greet.py", etc. Because with the LLM approach we need to provide better meaningful names for the actions
         *      Replace "%owner_name%" placeholder with {{ owner_name }} syntax in skill answers and all generic answers (e.g. %skill_name%, etc.); check "wernicke(" calls
         *      Create schema for locales/{lang}.json files. With limited action key config (only "answers" and "missing_params_follow_ups" for now?)
         *      Create new "runSkillAction" brain method and remove legacy "execute" method
         *      Then continue to rewrite the logic of the brain execution; then continue on the flow and loop
         *      Build bridges + rewrite all skills with the new params
         *      Remove "next_action" and implement "flow" (skill schema, get first action of the flow and ignore all other actions within the flow)
         *      Replace "getSkillConfig", etc. helpers from SkillDomainHelper with new helpers + rename SkillDomainHelper to SkillHelper
         *      Handle "is_loop"
         *      Delete all "config" folders in skills, and replace with "locales/{lang}.json" files
         *      Should delete legacy code?
         *      Make sure telemetry is working well with the new core
         *      Guess The Number skill: rework on loop logic (create "resolving" duty for very custom inputs, cf. MBTI?)
         *      Rochambeau skill
         *      Rework the MBTI skill with resolver skill. Once done, from there we can consider the rewrite of the core as nearly completed
         *      Check suggestions. Already done with widgets before? Need to check previous progress in Trello cards
         *        - Re-enable them from brain.ts, search for "// Send suggestions to the client"
         *      "dialog" skill type: rework it with new core. It is a good solution for Q&A. E.g. specific knowledge base, etc. Create a dialog skill for Leon itself about general questions (what it can do, why Leon has been created, who created Leon, when was the last update, how to develop new skill, how to contribute, some Easter eggs, etc.)
         *      Recreate all "dialog" skills with the new core. Remove feature for nested data such as in partner_assistant skill (not very useful, medium code complexity, poor ROI)
         *      Allow "missing_param_follow_ups" in skill config to handle customized missing params follow-ups
         *      Delete all legacy core code
         *      Delete .extractEntities method from NER class to replace with new one (extractBuiltInEntities)
         *      Create new structure tools in bridges with skills folder; remove domains (no need to implement tools for now)
         *      Create the fake weather skill (implement tools)
         *      Implement locales/{lang}.json in skills with new properties, and dynamic translation %PLACEHOLDER%
         *      (PLAN CHANGED, DO NOT DO THIS) -> Implement config/{lang}.json in skills with new properties (cf. Trello card description)
         *      [ok] Implement slot filling duty > missing params > conversation state
         *      Research (redevelop next_action?) and create resolver duty / loop in skills (guess the number, rochambeau, MBTI test, etc.)
         *      If action is not found, then fallback to a duty for chitchat/help with Leon's personality
         *      If a skill only has one action, then directly execute it after the skill router duty (no need to go through the action calling duty)
         *      Implement toolkits and tools (E.g. weather toolkit (folder) > several providers (each provider is a tool class, they must contain the same methods between each other as most as possible). Cf. MVP. And create the toolkit finder duty logic when the Leon instance includes +64 skills
         *      Create real weather skill with tools (one tool for each provider, can choose provider in skill settings)
         *      After everything is confirmed, then migrate all skills with the new configs
         *      Clean up NLU class, etc. if not used anymore
         *      Add this to do list to the Trello card description for history and future references (blog post, etc.)
         *
         *     [ok] In DSL, at the same level as "type": "logic", need to add field: "optional_params": []
         *      If this param is missing, but is included in the optional_params array, then still execute the action and let the skill developer handles the logic
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
