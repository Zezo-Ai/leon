import type { AxiosResponse } from 'axios'
import OpenAI from 'openai'
import type {
  ResponseCreateParamsBase,
  FunctionTool,
  ResponseCreateParamsNonStreaming,
  ResponseCreateParamsStreaming,
  ResponseFormatTextJSONSchemaConfig,
  ToolChoiceFunction,
  ToolChoiceOptions
} from 'openai/resources/responses/responses'

import type {
  CompletionParams,
  OpenAITool,
  OpenAIToolChoice,
  PromptOrChatHistory
} from '@/core/llm-manager/types'
import { LogHelper } from '@/helpers/log-helper'

type OpenAICompletionParams = Omit<CompletionParams, ''>

export default class OpenAILLMProvider {
  protected readonly name = 'OpenAI LLM Provider'
  protected readonly apiKey = process.env['LEON_OPENAI_API_KEY']
  protected readonly model = process.env['LEON_OPENAI_MODEL'] || 'gpt-4o-mini'
  private readonly client = new OpenAI({
    apiKey: this.apiKey,
    baseURL: 'https://api.openai.com/v1',
    timeout: 120_000,
    maxRetries: 0
  })

  constructor() {
    LogHelper.title(this.name)
    LogHelper.success('New instance')

    this.checkAPIKey()
  }

  private checkAPIKey(): void {
    if (!this.apiKey || this.apiKey === '') {
      LogHelper.title(this.name)

      const errorMessage = `${this.name} API key is not defined. Please define it in the .env file`
      LogHelper.error(errorMessage)
      throw new Error(errorMessage)
    }
  }

  private toResponsesTools(tools: OpenAITool[]): FunctionTool[] {
    return tools.map((tool) => {
      const responseTool: FunctionTool = {
        type: 'function',
        name: tool.function.name,
        parameters: tool.function.parameters as {
          [key: string]: unknown
        },
        strict: false
      }

      if (tool.function.description) {
        responseTool.description = tool.function.description
      }

      return responseTool
    })
  }

  private toResponsesToolChoice(
    toolChoice: OpenAIToolChoice
  ): ToolChoiceOptions | ToolChoiceFunction {
    if (typeof toolChoice === 'string') {
      return toolChoice
    }

    return {
      type: 'function',
      name: toolChoice.function.name
    }
  }

  private toResponsesJSONSchema(
    schema: Record<string, unknown> | null | undefined
  ): ResponseFormatTextJSONSchemaConfig | null {
    if (!schema) {
      return null
    }

    const effectiveSchema =
      ('type' in schema || 'oneOf' in schema)
        ? schema
        : {
            type: 'object',
            properties: schema
          }

    return {
      type: 'json_schema',
      name: 'structured_output',
      schema: effectiveSchema as Record<string, unknown>,
      strict: false
    }
  }

  public runChatCompletion(
    prompt: PromptOrChatHistory,
    completionParams: OpenAICompletionParams
  ): Promise<AxiosResponse> {
    return new Promise(async (resolve, reject) => {
      try {
        this.checkAPIKey()

        const isJSONMode = completionParams.data !== null

        const messagesHistory: Array<{
          role: 'assistant' | 'user'
          content: string
        }> = []
        if (completionParams.history) {
          for (const message of completionParams.history) {
            if (message.who === 'leon') {
              messagesHistory.push({
                role: 'assistant',
                content: message.message
              })
            } else {
              messagesHistory.push({
                role: 'user',
                content: message.message
              })
            }
          }
        }

        const lastMessage = messagesHistory[messagesHistory.length - 1]
        if (messagesHistory.length === 0 || lastMessage?.content !== prompt) {
          messagesHistory.push({
            role: 'user',
            content: prompt as string
          })
        }

        const requestOptions = {
          ...(typeof completionParams.timeout === 'number'
            ? { timeout: completionParams.timeout }
            : {}),
          ...(completionParams.signal
            ? { signal: completionParams.signal }
            : {})
        }

        const runResponseCreate = async (): Promise<AxiosResponse> => {
          const baseResponseParams: ResponseCreateParamsBase = {
            input: messagesHistory,
            model: this.model,
            instructions: completionParams.systemPrompt,
            ...(typeof completionParams.maxTokens === 'number'
              ? { max_output_tokens: completionParams.maxTokens }
              : {})
          }

          if (completionParams.tools && completionParams.tools.length > 0) {
            baseResponseParams.tools = this.toResponsesTools(completionParams.tools)
            if (completionParams.toolChoice !== undefined) {
              baseResponseParams.tool_choice = this.toResponsesToolChoice(
                completionParams.toolChoice
              )
            }
          }

          if (isJSONMode) {
            const jsonSchema = this.toResponsesJSONSchema(completionParams.data)
            if (jsonSchema) {
              baseResponseParams.text = {
                format: jsonSchema
              }
            }
          }

          if (completionParams.shouldStream === true) {
            const streamingParams: ResponseCreateParamsStreaming = {
              ...baseResponseParams,
              stream: true
            }
            const response = await this.client.responses.create(
              streamingParams,
              requestOptions
            )
            return {
              data: response
            } as AxiosResponse
          }

          const nonStreamingParams: ResponseCreateParamsNonStreaming = {
            ...baseResponseParams,
            stream: false
          }
          const response = await this.client.responses.create(
            nonStreamingParams,
            requestOptions
          )
          return {
            data: response
          } as AxiosResponse
        }

        const response = await runResponseCreate()
        return resolve(response)
      } catch (e) {
        const errorMessage = `Failed to run completion: ${String(e)}`

        LogHelper.title(this.name)
        LogHelper.error(errorMessage)
        return reject(new Error(errorMessage))
      }
    })
  }
}
