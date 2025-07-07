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
import {
  ActionCallingOutput,
  ActionCallingStatus,
  LLMDuties,
  LLMProviders
} from '@/core/llm-manager/types'
import { LLM_PROVIDER as LLM_PROVIDER_NAME } from '@/constants'
import { SkillDomainHelper } from '@/helpers/skill-domain-helper'

interface ActionCallingLLMDutyParams {
  input: LLMDutyParams['input']
  skillName: string
}

const CHAT_HISTORY_SIZE = 8

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
  {"status": "${ActionCallingStatus.MissingParams}", "required_params": ["<param_name_1>", "<param_name_2>"], "name": "<function_name>"}
  \`\`\`
  Replace "<param_name>" with the name of the missing required parameter.
2. If the function is not found, you must return the JSON object:
  \`\`\`json
  {"status": "${ActionCallingStatus.NotFound}"}
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
   * This method parses the optional parameters from the skill configuration
   * and omits them from the required parameters if they are present
   */
  private parseOptionalParameters(
    skillConfig: SkillSchema,
    dutyOutput: ActionCallingOutput
  ): ActionCallingOutput {
    if (dutyOutput.status !== ActionCallingStatus.MissingParams) {
      return dutyOutput
    }

    const actionConfig = skillConfig.actions[dutyOutput.name]
    if (!actionConfig?.optional_parameters) {
      return dutyOutput
    }

    const optionalParams = actionConfig.optional_parameters
    const remainingRequiredParams = dutyOutput.required_params.filter(
      (param: string) => !optionalParams.includes(param)
    )

    if (remainingRequiredParams.length === 0) {
      return {
        status: ActionCallingStatus.Success,
        name: dutyOutput.name,
        /**
         * TODO: handle multi required/optional parameters
         * Because now no matter how many parameters are required and we have optional parameters,
         * it will return an empty object
         */
        arguments: {}
      }
    }

    dutyOutput.required_params = remainingRequiredParams
    return dutyOutput
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
        handler: (): void => undefined
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

      let prompt = `User Query: "${this.input}"`

      if (actionNotes.length > 0) {
        prompt = `You must pay attention to these notes: ${actionNotes.join(
          '; '
        )}\n${prompt}`
      }

      ActionCallingLLMDuty.chatHistory.push({
        type: 'user',
        text: prompt
      })
      ActionCallingLLMDuty.chatHistory.push({
        type: 'model',
        response: []
      })

      const functionsSchema = this.actionsToFunctionsSchema(actions)
      const config = LLM_MANAGER.coreLLMDuties[LLMDuties.ActionCalling]
      const completionParams = {
        functions: functionsSchema,
        dutyType: LLMDuties.ActionCalling,
        systemPrompt: this.systemPrompt as string,
        temperature: config.temperature,
        maxTokens: config.maxTokens
      }
      let completionResult
      let dutyOutput = null

      if (LLM_PROVIDER_NAME === LLMProviders.Local) {
        completionResult = await LLM_PROVIDER.prompt(
          ActionCallingLLMDuty.chatHistory,
          {
            ...completionParams,
            session: ActionCallingLLMDuty.session
          }
        )

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const response = completionResult?.output as any

        // Reset chat history to the last 8 messages
        ActionCallingLLMDuty.chatHistory =
          response.lastEvaluation.cleanHistory.slice(-CHAT_HISTORY_SIZE)

        /**
         * The model decided to call a function
         */
        if (response.functionCalls && response.functionCalls.length > 0) {
          const call = response.functionCalls[0]
          const functionName = call.functionName
          const params = call.params
          const functionDefinition = functionsSchema[functionName]

          if (!functionDefinition) {
            dutyOutput = {
              status: ActionCallingStatus.NotFound
            }
          } else {
            /**
             * Check if the parameters are provided
             */
            const requiredParams = functionDefinition?.params?.required || []
            const missingParams = requiredParams.filter(
              (required: string) => params[required] == null
            )

            if (missingParams.length > 0) {
              dutyOutput = {
                status: ActionCallingStatus.MissingParams,
                required_params: missingParams,
                name: functionName
              }
            } else {
              dutyOutput = {
                status: ActionCallingStatus.Success,
                name: functionName,
                arguments: params
              }
            }
          }
        } else {
          LogHelper.title(this.name)
          LogHelper.warning(
            'The duty did not call a function, trying manual parsing...'
          )

          /**
           * The model did not call a function, hence we need to parse the response manually
           */
          try {
            // In case it returned a JSON object
            const tmpResponse = JSON.parse(response.response)

            if (tmpResponse.status) {
              if (tmpResponse.status === ActionCallingStatus.MissingParams) {
                dutyOutput = {
                  status: ActionCallingStatus.MissingParams,
                  required_params: tmpResponse.required_params || [],
                  name: tmpResponse.name || ''
                }
              } else if (tmpResponse.status === ActionCallingStatus.NotFound) {
                dutyOutput = {
                  status: ActionCallingStatus.NotFound
                }
              }
            } else if (tmpResponse.name) {
              dutyOutput = {
                status: ActionCallingStatus.Success,
                name: tmpResponse.name,
                arguments: tmpResponse.arguments || {}
              }
            } else {
              dutyOutput = {
                status: ActionCallingStatus.NotFound
              }
            }
          } catch {
            dutyOutput = {
              status: ActionCallingStatus.NotFound
            }
          }
        }
      } else {
        completionResult = await LLM_PROVIDER.prompt(prompt, completionParams)
      }

      dutyOutput = this.parseOptionalParameters(
        skillConfig as SkillSchema,
        dutyOutput as ActionCallingOutput
      )

      if (completionResult) {
        completionResult.output = JSON.stringify(dutyOutput)
      }

      LogHelper.title(this.name)
      LogHelper.success('Duty executed')
      LogHelper.success(`Prompt — ${prompt}`)
      LogHelper.success(`Output — ${completionResult?.output}
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
