import type { AxiosResponse } from 'axios'
import OpenAI from 'openai'
import type {
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageParam,
  ChatCompletionTool,
  ChatCompletionToolChoiceOption
} from 'openai/resources/chat/completions/completions'

import type {
  CompletionParams,
  OpenAITool,
  OpenAIToolChoice,
  PromptOrChatHistory
} from '@/core/llm-manager/types'
import { LogHelper } from '@/helpers/log-helper'

type MoonshotAICompletionParams = Omit<CompletionParams, ''>

export default class MoonshotAILLMProvider {
  protected readonly name = 'MoonshotAI LLM Provider'
  protected readonly apiKey = process.env['LEON_MOONSHOTAI_API_KEY']
  protected readonly model =
    process.env['LEON_MOONSHOTAI_MODEL'] || 'moonshot-v1-8k'
  private readonly client = new OpenAI({
    apiKey: this.apiKey,
    baseURL: 'https://api.moonshot.ai/v1',
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

  private toMessages(
    prompt: PromptOrChatHistory,
    completionParams: MoonshotAICompletionParams
  ): ChatCompletionMessageParam[] {
    let systemPrompt = completionParams.systemPrompt
    if (completionParams.data !== null) {
      systemPrompt = `${
        completionParams.systemPrompt
      }. Use a JSON format by following this schema: ${JSON.stringify(
        completionParams.data
      )}`
    }

    const messages: ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt }
    ]

    if (completionParams.history) {
      for (const message of completionParams.history) {
        messages.push({
          role: message.who === 'leon' ? 'assistant' : 'user',
          content: message.message
        })
      }
    }

    const lastMessage = messages[messages.length - 1]
    if (messages.length === 0 || !lastMessage || lastMessage.content !== prompt) {
      messages.push({
        role: 'user',
        content: prompt as string
      })
    }

    return messages
  }

  private toChatTools(tools: OpenAITool[]): ChatCompletionTool[] {
    return tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.function.name,
        description: tool.function.description || '',
        parameters: tool.function.parameters as Record<string, unknown>,
        strict: false
      }
    }))
  }

  private toToolChoice(
    toolChoice: OpenAIToolChoice
  ): ChatCompletionToolChoiceOption {
    if (typeof toolChoice === 'string') {
      return toolChoice
    }

    return {
      type: 'function',
      function: {
        name: toolChoice.function.name
      }
    }
  }

  public runChatCompletion(
    prompt: PromptOrChatHistory,
    completionParams: MoonshotAICompletionParams
  ): Promise<AxiosResponse> {
    return new Promise(async (resolve, reject) => {
      try {
        this.checkAPIKey()

        const messages = this.toMessages(prompt, completionParams)
        const hasTools =
          Array.isArray(completionParams.tools) &&
          completionParams.tools.length > 0
        const shouldDisableThinking = completionParams.disableThinking === true
        const thinkingControlFields: Record<string, unknown> =
          shouldDisableThinking
            ? {
                thinking: { type: 'disabled' }
              }
            : {}

        if (shouldDisableThinking) {
          LogHelper.title(this.name)
          LogHelper.debug('Thinking disabled for this request')
        }

        const baseParams = {
          messages,
          model: this.model,
          ...thinkingControlFields,
          ...(typeof completionParams.maxTokens === 'number'
            ? { max_tokens: completionParams.maxTokens }
            : {})
        }

        if (hasTools) {
          Object.assign(baseParams, {
            tools: this.toChatTools(completionParams.tools as OpenAITool[])
          })
          if (completionParams.toolChoice !== undefined) {
            Object.assign(baseParams, {
              tool_choice: this.toToolChoice(completionParams.toolChoice)
            })
          }
        }

        const requestOptions = {
          ...(typeof completionParams.timeout === 'number'
            ? { timeout: completionParams.timeout }
            : {}),
          ...(completionParams.signal
            ? { signal: completionParams.signal }
            : {})
        }

        if (completionParams.shouldStream === true) {
          const streamingParams: ChatCompletionCreateParamsStreaming = {
            ...baseParams,
            stream: true
          }
          const response = await this.client.chat.completions.create(
            streamingParams,
            requestOptions
          )
          return resolve({
            data: response
          } as AxiosResponse)
        }

        const nonStreamingParams: ChatCompletionCreateParamsNonStreaming = {
          ...baseParams,
          stream: false
        }
        const response = await this.client.chat.completions.create(
          nonStreamingParams,
          requestOptions
        )

        return resolve({
          data: response
        } as AxiosResponse)
      } catch (e) {
        const errorMessage = `Failed to run completion: ${String(e)}`

        LogHelper.title(this.name)
        LogHelper.error(errorMessage)
        return reject(new Error(errorMessage))
      }
    })
  }
}
