import axios, { type AxiosError, type AxiosResponse } from 'axios'

import type {
  CompletionParams,
  OpenAITool,
  OpenAIToolChoice,
  PromptOrChatHistory
} from '@/core/llm-manager/types'
import { LogHelper } from '@/helpers/log-helper'

/**
 * @see https://inference-docs.cerebras.ai/api-reference/chat-completions
 */
interface CerebrasMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
  name?: string
}
interface CerebrasChatCompletionParams {
  model: string
  messages: CerebrasMessage[]
  max_completion_tokens?: number
  top_p?: number
  stream?: boolean
  stop?: string | null
  thinking?: unknown
  response_format?: {
    type: 'json_object'
  }
  tools?: OpenAITool[]
  tool_choice?: OpenAIToolChoice
}
type CerebrasCompletionParams = Omit<CompletionParams, ''>

export default class CerebrasLLMProvider {
  protected readonly name = 'Cerebras LLM Provider'
  protected readonly apiKey = process.env['LEON_CEREBRAS_API_KEY']
  protected readonly model =
    process.env['LEON_CEREBRAS_MODEL'] || 'gpt-oss-120b'
  private readonly axios = axios.create({
    baseURL: 'https://api.cerebras.ai/v1',
    timeout: 120_000
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

  public runChatCompletion(
    prompt: PromptOrChatHistory,
    completionParams: CerebrasCompletionParams
  ): Promise<AxiosResponse> {
    return new Promise(async (resolve, reject) => {
      try {
        this.checkAPIKey()

        const isJSONMode = completionParams.data !== null

        let { systemPrompt } = completionParams
        if (isJSONMode) {
          systemPrompt = `${
            completionParams.systemPrompt
          }. Use a JSON format by following this schema: ${JSON.stringify(
            completionParams.data
          )}`
        }

        let messagesHistory: CerebrasMessage[] = []
        if (completionParams.history) {
          messagesHistory = completionParams.history.map((message) => {
            if (message.who === 'leon') {
              return {
                role: 'assistant',
                content: message.message
              }
            }

            return {
              role: 'user',
              content: message.message
            }
          })
        }

        messagesHistory = [
          {
            role: 'system',
            content: systemPrompt
          },
          ...messagesHistory
        ]

        // Make sure to add the new prompt (message) to the history
        const lastMessage = messagesHistory[messagesHistory.length - 1]
        if (messagesHistory.length === 0 || lastMessage?.content !== prompt) {
          messagesHistory.push({
            role: 'user',
            content: prompt as string
          })
        }

        let chatCompletionParams: CerebrasChatCompletionParams = {
          messages: messagesHistory,
          model: this.model,
          ...(completionParams.disableThinking === true
            ? {
                thinking: { type: 'disabled' }
              }
            : {}),
          stream: completionParams.shouldStream === true
        }

        if (completionParams.tools && completionParams.tools.length > 0) {
          chatCompletionParams = {
            ...chatCompletionParams,
            tools: completionParams.tools
          }
          if (completionParams.toolChoice !== undefined) {
            chatCompletionParams = {
              ...chatCompletionParams,
              tool_choice: completionParams.toolChoice
            }
          }
        } else if (isJSONMode) {
          chatCompletionParams = {
            ...chatCompletionParams,
            response_format: {
              type: 'json_object'
            }
          }
        }

        const promise = this.axios.request({
          url: '/chat/completions',
          method: 'POST',
          data: chatCompletionParams,
          ...(typeof completionParams.timeout === 'number'
            ? { timeout: completionParams.timeout }
            : {}),
          ...(completionParams.shouldStream === true
            ? { responseType: 'stream' as const }
            : {}),
          ...(completionParams.signal
            ? { signal: completionParams.signal }
            : {}),
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`
          }
        })

        return resolve(promise)
      } catch (e) {
        const err = e as Error | AxiosError
        let errorMessage = `Failed to run completion: ${err}`

        if (axios.isAxiosError(err)) {
          errorMessage = `Failed to run completion (AxiosError): ${err.response?.data}`
        }

        LogHelper.title(this.name)
        LogHelper.error(errorMessage)
        return reject(new Error(errorMessage))
      }
    })
  }
}
