import {
  type ChatSessionModelFunctions,
  type ChatHistoryItem,
  LlamaChat,
  defineChatSessionFunction
} from 'node-llama-cpp'

import {
  DEFAULT_INIT_PARAMS,
  LLMDuty,
  type LLMDutyInitParams,
  type LLMDutyParams,
  type LLMDutyResult
} from '@/core/llm-manager/llm-duty'
import { type SkillSchema } from '@/schemas/skill-schemas'
import { LogHelper } from '@/helpers/log-helper'
import { LLM_MANAGER, LLM_PROVIDER } from '@/core'
import { LLMDuties, LLMProviders } from '@/core/llm-manager/types'
import { LLM_PROVIDER as LLM_PROVIDER_NAME } from '@/constants'
import { SkillDomainHelper } from '@/helpers/skill-domain-helper'

interface ActionCallingLLMDutyParams {
  input: LLMDutyParams['input']
  skillName: string
}

export class ActionCallingLLMDuty extends LLMDuty {
  private static instance: ActionCallingLLMDuty
  /**
   * We use LlamaChat to have more control over the session (before function calling)
   * @see https://github.com/withcatai/node-llama-cpp/issues/471
   */
  private static session: LlamaChat = null as unknown as LlamaChat
  private static chatHistory: ChatHistoryItem[] = []
  /**
   * This system prompt is designed to enforce strict rules for function calling with a good balance between
   * context understanding and parameter resolution.
   *
   * E.g. if the owner says "Add apple juice to the list" without any context, it will return a missing parameter.
   * However, if the owner already mentioned the list name in the conversation, it will resolve it correctly.
   * But if the list name is "device" it will be smart enough to not resolve it as "list_name: device" because
   * "apple juice" is not a "device". So it can resolve parameters according to the named entity meaning
   */
  protected readonly systemPrompt: LLMDutyParams['systemPrompt'] = `You are a specialized AI assistant that exclusively performs function calling. Your sole purpose is to analyze a user's query and translate it into a structured function call based on a provided list of functions.

You must adhere to the following rules without exception:

1. If parameters are missing, you must return a JSON object indicating which parameters are required:
  \`\`\`json
  {"status": "missing_params", "required_params": ["<param_name_1>", "<param_name_2>"], "name": "<function_name>"}
  \`\`\`
  Replace "<param_name>" with the name of the missing required parameter.
2. If the function is not found, you must return the JSON object:
  \`\`\`json
  {"status": "not_found"}
  \`\`\`
3. You must not invent, assume, create, or infer any value for a parameter that is not explicitly provided by the user.
4. You must only return JSON format. Do not provide any explanations, apologies, greetings, or any other conversational text.`
  protected readonly name = 'Action Calling LLM Duty'
  private readonly skillName: string | null = null
  protected input: LLMDutyParams['input'] = null

  constructor(params: ActionCallingLLMDutyParams) {
    super()

    if (!ActionCallingLLMDuty.instance) {
      LogHelper.title(this.name)
      LogHelper.success('New instance')

      ActionCallingLLMDuty.instance = this
    }

    this.input = params.input
    this.skillName = params.skillName
  }

  /**
   * This method converts the action schema from the skill configuration
   * to a function schema that can be used by the LLM provider
   */
  private actionsToFunctionsSchema(
    actions: SkillSchema['actions']
  ): ChatSessionModelFunctions {
    const actionsEntries = Object.entries(actions)
    const functions: ChatSessionModelFunctions = {}

    actionsEntries.forEach(([actionName, action]) => {
      if (!action || !action.type) {
        LogHelper.error(
          `Action "${actionName}" is not valid or does not have a type`
        )
        return
      }

      const { description, parameters } = action
      let functionSchema = {
        description,
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-expect-error
        handler: async (params): Promise<boolean> => {
          /**
           * Sometimes the model will call the functions. It was more stable with the 3.8.1 version.
           * It started to break since this change: https://github.com/withcatai/node-llama-cpp/issues/471
           */
          console.log(`function handler from "${actionName}"`, params)
          console.log(
            JSON.stringify(
              {
                name: actionName,
                arguments: params
              },
              null,
              2
            )
          )
          return true
        }
      }

      if (parameters) {
        functionSchema = {
          ...functionSchema,
          // eslint-disable-next-line @typescript-eslint/ban-ts-comment
          // @ts-expect-error
          params: {
            type: 'object',
            properties: parameters
          }
        }
      }

      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-expect-error
      // functions[actionName] = functionSchema
      functions[actionName] = defineChatSessionFunction(functionSchema)
    })

    return functions
  }

  public async init(
    params: LLMDutyInitParams = DEFAULT_INIT_PARAMS
  ): Promise<void> {
    if (LLM_PROVIDER_NAME === LLMProviders.Local) {
      if (!ActionCallingLLMDuty.session || params.force) {
        LogHelper.title(this.name)
        LogHelper.info('Initializing...')

        try {
          /**
           * Dispose the previous session and sequence
           * to give space for the new one
           */
          if (params.force) {
            ActionCallingLLMDuty.session.dispose({ disposeSequence: true })
            LogHelper.info('Session disposed')
          }

          /**
           * We use LlamaChat to have more control over the session (before function calling)
           * @see https://github.com/withcatai/node-llama-cpp/issues/471
           */
          ActionCallingLLMDuty.session = new LlamaChat({
            contextSequence: LLM_MANAGER.context.getSequence(),
            autoDisposeSequence: true
          })
          /*ActionCallingLLMDuty.session = new LlamaChatSession({
            contextSequence: LLM_MANAGER.context.getSequence(),
            autoDisposeSequence: true,
            systemPrompt: this.systemPrompt as string
          })*/

          ActionCallingLLMDuty.chatHistory =
            ActionCallingLLMDuty.session.chatWrapper.generateInitialChatHistory(
              {
                systemPrompt: this.systemPrompt as string
              }
            )

          LogHelper.info(
            `System prompt size: ${
              LLM_MANAGER.model.tokenize(this.systemPrompt as string).length
            }`
          )
          LogHelper.success('Initialized')
        } catch (e) {
          LogHelper.title(this.name)
          LogHelper.error(`Failed to initialize: ${e}`)
        }
      }
    }
  }

  public async execute(): Promise<LLMDutyResult | null> {
    LogHelper.title(this.name)
    LogHelper.info('Executing...')

    try {
      const skillConfig = await SkillDomainHelper.getNewSkillConfig(
        this.skillName as string
      )
      const { action_notes: actionNotes = [], actions } = skillConfig || {}

      if (!actions || Object.keys(actions).length === 0) {
        LogHelper.title(this.name)
        LogHelper.error(
          `No actions found in the "${this.skillName}" skill configuration`
        )

        return null
      }

      ActionCallingLLMDuty.chatHistory.push({
        type: 'user',
        text: ''
      })
      ActionCallingLLMDuty.chatHistory.push({
        type: 'model',
        response: []
      })

      // TODO: if function calling, then use ".generateResponse()" in the local-provider; set thinking budget to 0, etc.

      // TODO: only get the last 8 messages from cleanHistory
      // ActionCallingLLMDuty.chatHistory = response.lastEvaluation.cleanHistory

      /////////////

      const functionsSchema = this.actionsToFunctionsSchema(actions)
      let prompt = `User Query: "${this.input}"`

      if (actionNotes.length > 0) {
        prompt = `You must pay attention to these notes: ${actionNotes.join(
          '; '
        )}\n${prompt}`
      }

      const config = LLM_MANAGER.coreLLMDuties[LLMDuties.ActionCalling]
      const completionParams = {
        functions: functionsSchema,
        dutyType: LLMDuties.ActionCalling,
        systemPrompt: this.systemPrompt as string,
        temperature: config.temperature,
        maxTokens: config.maxTokens
      }
      let completionResult

      if (LLM_PROVIDER_NAME === LLMProviders.Local) {
        console.log('BEFORE PROMPT')
        completionResult = await LLM_PROVIDER.prompt(prompt, {
          ...completionParams
          // TODO?
          // session: ActionCallingLLMDuty.session
        })
        console.log('AFTER PROMPT')

        // console.log('CURRENT CONTEXT', ActionCallingLLMDuty.session.

        /*const create_list = defineChatSessionFunction({
          description: 'Create a new to-do list based on the given list name.',
          params: {
            type: 'object',
            properties: {
              list_name: {
                type: 'string',
                description: 'The name of the to-do list to create.'
              }
            }
          },
          handler: async (params) => {
            console.log('function handler', params)
          }
        })
        const get_all_lists = defineChatSessionFunction({
          description: 'Retrieve all existing to-do lists.',
          handler: async (params) => {
            console.log('function handler', params)
          }
        })
        const get_list_items = defineChatSessionFunction({
          description: 'Retrieve all items from a specific to-do list.',
          params: {
            type: 'object',
            properties: {
              list_name: {
                type: 'string',
                description: 'The name of the to-do list to retrieve items from.'
              }
            }
          },
          handler: async (params) => {
            console.log('function handler', params)
          }
        })
        const add_todos = defineChatSessionFunction({
          description: 'Add items to a specific to-do list.',
          params: {
            type: 'object',
            properties: {
              list_name: {
                type: 'string',
                description: 'The name of the to-do list to add items to.'
              },
              items: {
                type: 'array',
                items: {
                  type: 'string'
                },
                description: 'The items to add to the list.'
              }
            }
          },
          handler: async (params) => {
            console.log('function handler', params)
          }
        })
        const delete_list = defineChatSessionFunction({
          description: 'Delete a specific to-do list.',
          params: {
            type: 'object',
            properties: {
              list_name: {
                type: 'string',
                description: 'The name of the to-do list to delete.'
              }
            }
          },
          handler: async (params) => {
            console.log('function handler', params)
          }
        })*/
        /*const get_weather = defineChatSessionFunction({
          description: 'Get the current weather.',
          params: {
            type: 'object',
            properties: {
              location: {
                type: 'string',
                description: 'The location to get the weather for.'
              }
            }
          },
          handler: async (params) => {
            console.log('function handler', params)
          }
        })
        const get_temperature = defineChatSessionFunction({
          description: 'Get the current temperature.',
          params: {
            type: 'object',
            properties: {
              location: {
                type: 'string',
                description: 'The location to get the temperature for.'
              }
            }
          },
          handler: async (params) => {
            console.log('function handler', params)
          }
        })
        const get_humidity = defineChatSessionFunction({
          description: 'Get the current humidity.',
          params: {
            type: 'object',
            properties: {
              location: {
                type: 'string',
                description: 'The location to get the humidity for.'
              }
            }
          },
          handler: async (params) => {
            console.log('function handler', params)
          }
        })
        const get_wind_speed = defineChatSessionFunction({
          description: 'Get the current wind speed.',
          params: {
            type: 'object',
            properties: {
              location: {
                type: 'string',
                description: 'The location to get the wind speed for.'
              }
            }
          },
          handler: async (params) => {
            console.log('function handler', params)
          }
        })*/

        /**
         * @see https://node-llama-cpp.withcat.ai/api/type-aliases/GbnfJsonSchema
         */
        /*const zodSchema = z.object({
          status: z.enum(['valid', 'missing_params', 'not_found']),
          name: z.string().optional(),
          required_params: z.array(z.string()).optional()
        })*/
        // const jsonSchema = z.toJSONSchema(zodSchema)
        // const grammar = new LlamaJsonSchemaGrammar(LLM_MANAGER.llama, jsonSchema)
        /**
         * @see https://qwen.readthedocs.io/en/latest/framework/function_call.html
         * @see https://platform.openai.com/docs/guides/function-calling?api-mode=responses&lang=javascript
         */
        /*const res = await ActionCallingLLMDuty.session.prompt(
          prompt as string,
          {
            temperature: 0,
            // grammar,
            functions: {
              create_list,
            get_all_lists,
            get_list_items,
            add_todos,
            delete_list
              /!*get_weather,
              get_temperature,
              get_humidity,
              get_wind_speed*!/
            }
          }
        )*/

        /**
         * TODO
         * If res has "<tool_call>" and "</tool_call>"
         * then parse the action call
         */

        // console.log('res', res)

        /*completionResult = await LLM_PROVIDER.prompt(prompt, {
          ...completionParams,
          session: ActionCallingLLMDuty.session
        })*/
      } else {
        // completionResult = await LLM_PROVIDER.prompt(prompt, completionParams)
      }

      // TODO: handle optional_params and structure output format

      LogHelper.title(this.name)
      LogHelper.success('Duty executed')
      LogHelper.success(`Prompt — ${prompt}`)
      LogHelper.success(`Output — ${JSON.stringify(completionResult?.output)}
usedInputTokens: ${completionResult?.usedInputTokens}
usedOutputTokens: ${completionResult?.usedOutputTokens}`)

      return completionResult as unknown as LLMDutyResult
    } catch (e) {
      LogHelper.title(this.name)
      LogHelper.error(`Failed to execute: ${e}`)
    }

    return null
  }
}
