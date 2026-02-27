import type { AxiosResponse } from 'axios'
import { OpenRouter } from '@openrouter/sdk'

import type {
  CompletionParams,
  OpenAITool,
  OpenAIToolChoice,
  PromptOrChatHistory
} from '@/core/llm-manager/types'
import { LogHelper } from '@/helpers/log-helper'

/**
 * @see https://openrouter.ai/docs
 */
type OpenRouterSendRequest = Parameters<OpenRouter['chat']['send']>[0]
type OpenRouterChatGenerationParams = OpenRouterSendRequest['chatGenerationParams']
type OpenRouterMessage = OpenRouterChatGenerationParams['messages'][number]
type OpenRouterTool = NonNullable<OpenRouterChatGenerationParams['tools']>[number]
type OpenRouterToolChoice = NonNullable<
  OpenRouterChatGenerationParams['toolChoice']
>
type OpenRouterCompletionParams = Omit<CompletionParams, ''>

export default class OpenRouterLLMProvider {
  protected readonly name = 'OpenRouter LLM Provider'
  protected readonly apiKey = process.env['LEON_OPENROUTER_API_KEY']
  protected readonly model =
    process.env['LEON_OPENROUTER_AGENT_LLM'] ||
    process.env['LEON_OPENROUTER_MODEL'] ||
    'openrouter/auto'
  private readonly client = new OpenRouter({
    apiKey: this.apiKey,
    timeoutMs: 120_000,
    retryConfig: {
      strategy: 'backoff',
      retryConnectionErrors: true,
      backoff: {
        initialInterval: 400,
        maxInterval: 2_500,
        exponent: 2,
        maxElapsedTime: 8_000
      }
    }
  })

  constructor() {
    LogHelper.title(this.name)
    LogHelper.success('New instance')

    this.checkAPIKey()
  }

  public get modelName(): string {
    return this.model
  }

  private checkAPIKey(): void {
    if (!this.apiKey || this.apiKey === '') {
      LogHelper.title(this.name)

      const errorMessage = `${this.name} API key is not defined. Please define it in the .env file`
      LogHelper.error(errorMessage)
      throw new Error(errorMessage)
    }
  }

  private formatErrorForLog(error: unknown): string {
    if (!error || typeof error !== 'object') {
      return String(error)
    }

    const errorObject = error as Record<string, unknown>
    const details: Record<string, unknown> = {
      name:
        typeof errorObject['name'] === 'string'
          ? (errorObject['name'] as string)
          : 'Error',
      message:
        typeof errorObject['message'] === 'string'
          ? (errorObject['message'] as string)
          : String(error)
    }

    if (typeof errorObject['statusCode'] === 'number') {
      details['statusCode'] = errorObject['statusCode']
    }
    if (errorObject['body'] !== undefined) {
      details['body'] = errorObject['body']
    }
    if (errorObject['error'] !== undefined) {
      details['error'] = errorObject['error']
    }
    if (errorObject['cause'] !== undefined) {
      details['cause'] = String(errorObject['cause'])
    }

    try {
      return JSON.stringify(details)
    } catch {
      return String(error)
    }
  }

  private toTools(tools: OpenAITool[]): OpenRouterTool[] {
    return tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.function.name,
        ...(tool.function.description
          ? { description: tool.function.description }
          : {}),
        parameters: tool.function.parameters as Record<string, unknown>,
        strict: false
      }
    }))
  }

  private toToolChoice(toolChoice: OpenAIToolChoice): OpenRouterToolChoice {
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

  private toMessages(
    prompt: PromptOrChatHistory,
    completionParams: OpenRouterCompletionParams
  ): OpenRouterMessage[] {
    let { systemPrompt } = completionParams
    if (completionParams.data !== null) {
      systemPrompt = `${
        completionParams.systemPrompt
      }. Use a JSON format by following this schema: ${JSON.stringify(
        completionParams.data
      )}`
    }

    const messages: OpenRouterMessage[] = [
      {
        role: 'system',
        content: systemPrompt
      }
    ]

    if (completionParams.history) {
      for (const message of completionParams.history) {
        messages.push({
          role: message.who === 'leon' ? 'assistant' : 'user',
          content: message.message
        } as OpenRouterMessage)
      }
    }

    const lastMessage = messages[messages.length - 1]
    if (
      messages.length === 0 ||
      !lastMessage ||
      typeof lastMessage.content !== 'string' ||
      lastMessage.content !== prompt
    ) {
      messages.push({
        role: 'user',
        content: prompt as string
      } as OpenRouterMessage)
    }

    return messages
  }

  public runChatCompletion(
    prompt: PromptOrChatHistory,
    completionParams: OpenRouterCompletionParams
  ): Promise<AxiosResponse> {
    return new Promise(async (resolve, reject) => {
      try {
        this.checkAPIKey()

        const messages = this.toMessages(prompt, completionParams)
        const shouldUseStreaming =
          completionParams.shouldStream === true &&
          (!completionParams.tools || completionParams.tools.length === 0)
        const chatGenerationParams: OpenRouterChatGenerationParams = {
          messages,
          model: this.model,
          ...(typeof completionParams.maxTokens === 'number'
            ? { maxTokens: completionParams.maxTokens }
            : {}),
          stream: shouldUseStreaming
        }

        if (completionParams.tools && completionParams.tools.length > 0) {
          chatGenerationParams.tools = this.toTools(completionParams.tools)
          if (completionParams.toolChoice !== undefined) {
            chatGenerationParams.toolChoice = this.toToolChoice(
              completionParams.toolChoice
            )
          }
          chatGenerationParams.provider = {
            ...(chatGenerationParams.provider || {}),
            requireParameters: true
          }
        }

        if (!completionParams.tools || completionParams.tools.length === 0) {
          chatGenerationParams.provider = {
            order: ['cerebras']
          }
        }

        const requestOptions = {
          ...(typeof completionParams.timeout === 'number'
            ? { timeoutMs: completionParams.timeout }
            : {}),
          ...(completionParams.signal
            ? { signal: completionParams.signal }
            : {})
        }

        const response = await this.client.chat.send(
          { chatGenerationParams },
          requestOptions
        )
        return resolve({
          data: response
        } as AxiosResponse)
      } catch (e) {
        const errorMessage = `Failed to run completion: ${this.formatErrorForLog(e)}`

        LogHelper.title(this.name)
        LogHelper.error(errorMessage)
        return reject(e instanceof Error ? e : new Error(errorMessage))
      }
    })
  }
}
