import path from 'node:path'
import { Readable } from 'node:stream'

import axios, { type AxiosResponse } from 'axios'

import {
  type CompletionParams,
  type LLMDuties,
  type OpenAIToolCall,
  type PromptOrChatHistory,
  LLMProviders
} from '@/core/llm-manager/types'
import { LLM_PROVIDER, SERVER_CORE_PATH } from '@/constants'
import { LogHelper } from '@/helpers/log-helper'
import { FileHelper } from '@/helpers/file-helper'
import LocalLLMProvider from '@/core/llm-manager/llm-providers/local-llm-provider'
import GroqLLMProvider from '@/core/llm-manager/llm-providers/groq-llm-provider'
import OpenRouterLLMProvider from '@/core/llm-manager/llm-providers/openrouter-llm-provider'
import CerebrasLLMProvider from '@/core/llm-manager/llm-providers/cerebras-llm-provider'
import HuggingFaceLLMProvider from '@/core/llm-manager/llm-providers/huggingface-llm-provider'
import { BRAIN, LLM_MANAGER } from '@/core'

interface CompletionResult {
  dutyType: LLMDuties
  systemPrompt: string
  input: string
  output: string
  data: Record<string, unknown> | null
  functions?: Record<string, unknown> | undefined
  maxTokens: number
  thoughtTokensBudget: number
  usedInputTokens: number
  usedOutputTokens: number
  temperature: number
  /**
   * When the model responds with tool calls (native tool calling),
   * this field contains the parsed tool_calls array.
   */
  toolCalls?: OpenAIToolCall[]
}
interface NormalizedCompletionResult {
  rawResult: string
  usedInputTokens: number
  usedOutputTokens: number
  toolCalls?: OpenAIToolCall[]
}
type Provider =
  | LocalLLMProvider
  | GroqLLMProvider
  | OpenRouterLLMProvider
  | CerebrasLLMProvider
  | HuggingFaceLLMProvider
  | undefined

const LLM_PROVIDERS_MAP = {
  [LLMProviders.Local]: 'local-llm-provider',
  [LLMProviders.Groq]: 'groq-llm-provider',
  [LLMProviders.OpenRouter]: 'openrouter-llm-provider',
  [LLMProviders.Cerebras]: 'cerebras-llm-provider',
  [LLMProviders.HuggingFace]: 'huggingface-llm-provider'
}
const DEFAULT_MAX_EXECUTION_TIMOUT =
  LLM_PROVIDER === LLMProviders.Local ? 32_000 : 120_000
const DEFAULT_MAX_EXECUTION_RETRIES = 2
const TIMEOUT_RETRY_INCREMENT_MS = 30_000
const DEFAULT_TEMPERATURE = 0 // Disabled
const DEFAULT_MAX_TOKENS = 8_192
const DEFAULT_THOUGHT_TOKENS_BUDGET = Infinity

export default class LLMProvider {
  private static instance: LLMProvider

  private llmProvider: Provider = undefined

  constructor() {
    if (!LLMProvider.instance) {
      LogHelper.title('LLM Provider')
      LogHelper.success('New instance')

      LLMProvider.instance = this
    }
  }

  public get isLLMProviderReady(): boolean {
    return !!this.llmProvider
  }

  /**
   * Initialize the LLM provider
   */
  public async init(): Promise<boolean> {
    LogHelper.title('LLM Provider')
    LogHelper.info('Initializing LLM provider...')

    if (!Object.values(LLMProviders).includes(LLM_PROVIDER as LLMProviders)) {
      LogHelper.error(
        `The LLM provider "${LLM_PROVIDER}" does not exist or is not yet supported`
      )

      return false
    }

    // Dynamically set the provider
    const { default: provider } = await FileHelper.dynamicImportFromFile(
      path.join(
        SERVER_CORE_PATH,
        'llm-manager',
        'llm-providers',
        `${LLM_PROVIDERS_MAP[LLM_PROVIDER as LLMProviders]}.js`
      )
    )
    this.llmProvider = new provider()

    LogHelper.title('LLM Provider')
    LogHelper.success(`Initialized with "${LLM_PROVIDER}" provider`)

    return true
  }

  private normalizeCompletionResultForLocalProvider(
    rawResult: string,
    completionParams: CompletionParams
  ): NormalizedCompletionResult {
    if (!completionParams.session) {
      return {
        rawResult,
        usedInputTokens: 0,
        usedOutputTokens: 0
      }
    }

    const { usedInputTokens, usedOutputTokens } =
      completionParams.session.sequence.tokenMeter.getState()

    LogHelper.title('LLM Provider')
    LogHelper.debug(
      `Raw context tokens:\n${LLM_MANAGER.model.detokenize(
        completionParams.session.sequence.contextTokens
      )}`
    )

    return {
      rawResult,
      usedInputTokens,
      usedOutputTokens
    }
  }

  private normalizeCompletionResultForGroqProvider(
    rawResult: AxiosResponse
  ): NormalizedCompletionResult {
    const parsedCompletionResult = JSON.parse(rawResult.data)
    const message = parsedCompletionResult.choices[0].message

    const result: NormalizedCompletionResult = {
      rawResult: message.content || '',
      usedInputTokens: parsedCompletionResult.usage.prompt_tokens,
      usedOutputTokens: parsedCompletionResult.usage.completion_tokens
    }

    if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      result.toolCalls = message.tool_calls as OpenAIToolCall[]
    }

    return result
  }

  private normalizeCompletionResultForOpenRouterProvider(
    rawResult: AxiosResponse
  ): NormalizedCompletionResult {
    const parsedCompletionResult = rawResult.data
    const message = parsedCompletionResult.choices[0].message

    const result: NormalizedCompletionResult = {
      rawResult: message.content || '',
      usedInputTokens: parsedCompletionResult.usage.prompt_tokens,
      usedOutputTokens: parsedCompletionResult.usage.completion_tokens
    }

    if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      result.toolCalls = message.tool_calls as OpenAIToolCall[]
    }

    return result
  }

  private normalizeCompletionResultForCerebrasProvider(
    rawResult: AxiosResponse
  ): NormalizedCompletionResult {
    const parsedCompletionResult = rawResult.data
    const message = parsedCompletionResult.choices[0].message

    const result: NormalizedCompletionResult = {
      rawResult: message.content || '',
      usedInputTokens: parsedCompletionResult.usage.prompt_tokens,
      usedOutputTokens: parsedCompletionResult.usage.completion_tokens
    }

    if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      result.toolCalls = message.tool_calls as OpenAIToolCall[]
    }

    return result
  }

  private normalizeCompletionResultForHuggingFaceProvider(
    rawResult: AxiosResponse
  ): NormalizedCompletionResult {
    const parsedCompletionResult = rawResult.data
    const message = parsedCompletionResult.choices[0].message

    const result: NormalizedCompletionResult = {
      rawResult: message.content || '',
      usedInputTokens: parsedCompletionResult.usage.prompt_tokens,
      usedOutputTokens: parsedCompletionResult.usage.completion_tokens
    }

    if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      result.toolCalls = message.tool_calls as OpenAIToolCall[]
    }

    return result
  }

  private isReadableStream(value: unknown): value is Readable {
    return (
      value instanceof Readable ||
      (!!value &&
        typeof value === 'object' &&
        typeof (value as { on?: unknown }).on === 'function' &&
        typeof (value as { [Symbol.asyncIterator]?: unknown })[
          Symbol.asyncIterator
        ] === 'function')
    )
  }

  private async normalizeStreamingCompletionResult(
    rawResult: AxiosResponse,
    completionParams: CompletionParams
  ): Promise<NormalizedCompletionResult> {
    const responseStream = rawResult.data
    if (!this.isReadableStream(responseStream)) {
      return {
        rawResult: '',
        usedInputTokens: 0,
        usedOutputTokens: 0
      }
    }

    let textOutput = ''
    let usedInputTokens = 0
    let usedOutputTokens = 0
    let buffer = ''

    const toolCallsByIndex: Record<number, OpenAIToolCall> = {}

    const applyStreamingChunk = (payloadLine: string): void => {
      const trimmedLine = payloadLine.trim()
      if (!trimmedLine || !trimmedLine.startsWith('data:')) {
        return
      }

      const dataChunk = trimmedLine.slice(5).trim()
      if (!dataChunk || dataChunk === '[DONE]') {
        return
      }

      let parsedChunk: Record<string, unknown>
      try {
        parsedChunk = JSON.parse(dataChunk) as Record<string, unknown>
      } catch {
        return
      }

      const usage = parsedChunk['usage']
      if (usage && typeof usage === 'object') {
        const promptTokens = (usage as Record<string, unknown>)[
          'prompt_tokens'
        ]
        const completionTokens = (usage as Record<string, unknown>)[
          'completion_tokens'
        ]

        if (typeof promptTokens === 'number' && Number.isFinite(promptTokens)) {
          usedInputTokens = promptTokens
        }
        if (
          typeof completionTokens === 'number' &&
          Number.isFinite(completionTokens)
        ) {
          usedOutputTokens = completionTokens
        }
      }

      const choices = parsedChunk['choices']
      if (!Array.isArray(choices) || choices.length === 0) {
        return
      }
      const firstChoice = choices[0]
      if (!firstChoice || typeof firstChoice !== 'object') {
        return
      }

      const choiceObject = firstChoice as Record<string, unknown>
      const delta = choiceObject['delta']
      if (!delta || typeof delta !== 'object') {
        return
      }

      const deltaObject = delta as Record<string, unknown>
      const contentDelta = deltaObject['content']
      if (typeof contentDelta === 'string' && contentDelta.length > 0) {
        textOutput += contentDelta
        completionParams.onToken?.(contentDelta)
      }

      const toolCalls = deltaObject['tool_calls']
      if (!Array.isArray(toolCalls)) {
        return
      }

      for (const partialToolCall of toolCalls) {
        if (!partialToolCall || typeof partialToolCall !== 'object') {
          continue
        }

        const toolCallData = partialToolCall as Record<string, unknown>
        const index =
          typeof toolCallData['index'] === 'number' &&
          Number.isInteger(toolCallData['index'])
            ? (toolCallData['index'] as number)
            : 0
        const id =
          typeof toolCallData['id'] === 'string' ? toolCallData['id'] : ''
        const type =
          typeof toolCallData['type'] === 'string'
            ? toolCallData['type']
            : 'function'
        const fn =
          toolCallData['function'] && typeof toolCallData['function'] === 'object'
            ? (toolCallData['function'] as Record<string, unknown>)
            : {}
        const functionName =
          typeof fn['name'] === 'string' ? (fn['name'] as string) : ''
        const functionArguments =
          typeof fn['arguments'] === 'string' ? (fn['arguments'] as string) : ''

        if (!toolCallsByIndex[index]) {
          toolCallsByIndex[index] = {
            id: id || `tool_call_${index}`,
            type: type === 'function' ? 'function' : 'function',
            function: {
              name: functionName,
              arguments: functionArguments
            }
          }
          continue
        }

        const current = toolCallsByIndex[index]!
        if (id) {
          current.id = id
        }
        if (functionName) {
          current.function.name = functionName
        }
        if (functionArguments) {
          current.function.arguments += functionArguments
        }
      }
    }

    for await (const chunk of responseStream) {
      const chunkString =
        typeof chunk === 'string' ? chunk : (chunk as Buffer).toString('utf8')
      buffer += chunkString.replace(/\r\n/g, '\n')

      let separatorIndex = buffer.indexOf('\n\n')
      while (separatorIndex !== -1) {
        const eventBlock = buffer.slice(0, separatorIndex)
        buffer = buffer.slice(separatorIndex + 2)

        const blockLines = eventBlock.split('\n')
        for (const line of blockLines) {
          applyStreamingChunk(line)
        }

        separatorIndex = buffer.indexOf('\n\n')
      }
    }

    if (buffer.trim()) {
      const blockLines = buffer.split('\n')
      for (const line of blockLines) {
        applyStreamingChunk(line)
      }
    }

    const toolCalls = Object.keys(toolCallsByIndex)
      .map((index) => Number(index))
      .sort((a, b) => a - b)
      .map((index) => toolCallsByIndex[index]!)

    return {
      rawResult: textOutput,
      usedInputTokens,
      usedOutputTokens,
      ...(toolCalls.length > 0 ? { toolCalls } : {})
    }
  }

  public cleanUpResult(str: string): string {
    // If starts and end with a double quote, remove them
    if (str.startsWith('"') && str.endsWith('"')) {
      return str.slice(1, -1)
    }

    str = str.replace(/\*laugh\*/g, '😂')
    str = str.replace(/\*winks?\*/g, '😉')
    str = str.replace(/\*sigh\*/g, '😔')

    // Remove all newlines at the beginning
    str = str.replace(/^\n+/, '')

    return str
  }

  /**
   * Run the completion inference
   */
  public async prompt(
    promptOrChatHistory: PromptOrChatHistory,
    completionParams: CompletionParams
  ): Promise<CompletionResult | null> {
    const measureExecutionTimeLabel = `Inference time for "${completionParams.dutyType}" duty`

    LogHelper.title('LLM Provider')
    LogHelper.info(`Using "${LLM_PROVIDER}" provider for completion...`)
    LogHelper.time(measureExecutionTimeLabel)

    if (!this.llmProvider) {
      LogHelper.error('LLM provider is not ready')
      return null
    }

    completionParams.dutyType = completionParams.dutyType ?? null
    completionParams.timeout =
      completionParams.timeout ?? DEFAULT_MAX_EXECUTION_TIMOUT
    completionParams.maxRetries =
      completionParams.maxRetries ?? DEFAULT_MAX_EXECUTION_RETRIES
    completionParams.data = completionParams.data ?? null
    completionParams.functions = completionParams.functions ?? undefined
    completionParams.temperature =
      completionParams.temperature ?? DEFAULT_TEMPERATURE
    completionParams.maxTokens =
      completionParams.maxTokens ?? DEFAULT_MAX_TOKENS
    completionParams.thoughtTokensBudget =
      completionParams.thoughtTokensBudget ?? DEFAULT_THOUGHT_TOKENS_BUDGET

    /**
     * TODO: support onToken (stream) for Groq provider too
     */
    completionParams.onToken = completionParams.onToken || ((): void => {})
    completionParams.shouldStream = completionParams.shouldStream ?? false

    const isJSONMode = completionParams.data !== null
    const shouldStreamOutput =
      completionParams.shouldStream === true && !isJSONMode

    const abortController = new AbortController()
    const completionParamsWithAbort = {
      ...completionParams,
      shouldStream: shouldStreamOutput,
      signal: abortController.signal
    }

    const rawResultPromise = this.llmProvider.runChatCompletion(
      promptOrChatHistory,
      completionParamsWithAbort
    )

    let timeoutHandle: NodeJS.Timeout | null = null
    const timeoutPromise = new Promise((_, reject) => {
      timeoutHandle = setTimeout(() => {
        abortController.abort()
        reject(
          new Error(
            `Timeout (${completionParams.timeout}ms) for "${completionParams.dutyType}" duty`
          )
        )
      }, completionParams.timeout)
    })

    let rawResult
    let rawResultString

    try {
      rawResult = await Promise.race([rawResultPromise, timeoutPromise])
      if (timeoutHandle) {
        clearTimeout(timeoutHandle)
      }
    } catch (e) {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle)
      }

      LogHelper.title('LLM Provider')
      LogHelper.error(`Error to complete prompt: ${e}`)
      LogHelper.timeEnd(measureExecutionTimeLabel)

      const isTimeoutError =
        (e instanceof Error && e.message.startsWith('Timeout (')) ||
        (axios.isAxiosError(e) && e.code === 'ECONNABORTED')
      const remainingRetries = completionParams.maxRetries ?? 0

      if (isTimeoutError && remainingRetries > 0) {
        const nextTimeout = (completionParams.timeout ?? 0) + TIMEOUT_RETRY_INCREMENT_MS
        LogHelper.title('LLM Provider')
        LogHelper.warning(
          `Prompt timed out. Retrying with timeout=${nextTimeout}ms (${remainingRetries} retry left)`
        )

        return this.prompt(promptOrChatHistory, {
          ...completionParams,
          timeout: nextTimeout,
          maxRetries: remainingRetries - 1
        })
      }

      if (axios.isAxiosError(e)) {
        const apiError = e.response?.data
        let apiErrorDetails = ''

        if (apiError) {
          apiErrorDetails =
            typeof apiError === 'string' ? apiError : JSON.stringify(apiError)
        }

        const brainMessage = BRAIN.wernicke('llm_provider_http_error', '', {
          '{{ provider }}': LLM_PROVIDER,
          '{{ error }}': String(e),
          '{{ api_error }}': apiErrorDetails ? `\n${apiErrorDetails}` : ''
        })

        await BRAIN.talk(brainMessage, true)
      }

      // throw new Error('Prompt failed after all retries')
      return null

      /*// Avoid infinite loop
      if (!completionParams.maxRetries || completionParams.maxRetries <= 0) {
        throw new Error('Prompt failed after all retries')
      }

      if (completionParams.maxRetries > 0) {
        LogHelper.info('Prompt took too long or failed. Retrying...')

        return this.prompt(prompt, {
          ...completionParams,
          maxRetries: completionParams.maxRetries - 1
        })
      } else {
        LogHelper.error(
          `Prompt failed after ${completionParams.maxRetries} retries`
        )

        return null
      }*/
    }

    let usedInputTokens = 0
    let usedOutputTokens = 0
    let toolCalls: OpenAIToolCall[] | undefined

    /**
     * Normalize the completion result according to the provider
     */
    const isRemoteProvider = LLM_PROVIDER !== LLMProviders.Local
    const shouldUseRemoteStreaming =
      isRemoteProvider &&
      shouldStreamOutput

    if (shouldUseRemoteStreaming) {
      const normalized = await this.normalizeStreamingCompletionResult(
        rawResult as AxiosResponse,
        completionParams
      )

      rawResult = normalized.rawResult
      usedInputTokens = normalized.usedInputTokens
      usedOutputTokens = normalized.usedOutputTokens
      toolCalls = normalized.toolCalls
    } else if (LLM_PROVIDER === LLMProviders.Local) {
      if (completionParams.session) {
        const {
          rawResult: result,
          usedInputTokens: inputTokens,
          usedOutputTokens: outputTokens
        } = this.normalizeCompletionResultForLocalProvider(
          rawResult as string,
          completionParams
        )

        rawResult = result
        usedInputTokens = inputTokens
        usedOutputTokens = outputTokens
      }
    } else if (LLM_PROVIDER === LLMProviders.Groq) {
      const normalized = this.normalizeCompletionResultForGroqProvider(
        rawResult as AxiosResponse
      )

      rawResult = normalized.rawResult
      usedInputTokens = normalized.usedInputTokens
      usedOutputTokens = normalized.usedOutputTokens
      toolCalls = normalized.toolCalls
    } else if (LLM_PROVIDER === LLMProviders.OpenRouter) {
      const normalized = this.normalizeCompletionResultForOpenRouterProvider(
        rawResult as AxiosResponse
      )

      rawResult = normalized.rawResult
      usedInputTokens = normalized.usedInputTokens
      usedOutputTokens = normalized.usedOutputTokens
      toolCalls = normalized.toolCalls
    } else if (LLM_PROVIDER === LLMProviders.Cerebras) {
      const normalized = this.normalizeCompletionResultForCerebrasProvider(
        rawResult as AxiosResponse
      )

      rawResult = normalized.rawResult
      usedInputTokens = normalized.usedInputTokens
      usedOutputTokens = normalized.usedOutputTokens
      toolCalls = normalized.toolCalls
    } else if (LLM_PROVIDER === LLMProviders.HuggingFace) {
      const normalized = this.normalizeCompletionResultForHuggingFaceProvider(
        rawResult as AxiosResponse
      )

      rawResult = normalized.rawResult
      usedInputTokens = normalized.usedInputTokens
      usedOutputTokens = normalized.usedOutputTokens
      toolCalls = normalized.toolCalls
    } else {
      LogHelper.error(`The LLM provider "${LLM_PROVIDER}" is not yet supported`)
      return null
    }

    rawResultString = rawResult as string

    if (typeof rawResult === 'string') {
      rawResultString = this.cleanUpResult(rawResultString)
    }

    if (isJSONMode) {
      // If a closing bracket is missing, add it
      if (rawResultString[rawResultString.length - 1] !== '}') {
        rawResultString += '}'
      }
    }

    LogHelper.title('LLM Provider')
    LogHelper.timeEnd(measureExecutionTimeLabel)

    return {
      dutyType: completionParams.dutyType,
      systemPrompt: completionParams.systemPrompt,
      temperature: completionParams.temperature,
      input:
        typeof promptOrChatHistory === 'string'
          ? promptOrChatHistory
          : JSON.stringify(promptOrChatHistory),
      // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
      output: (() => {
        if (!isJSONMode) {
          return rawResultString
        }

        try {
          return JSON.parse(rawResultString)
        } catch {
          // Some models wrap JSON in markdown code fences (```json ... ```).
          // Strip them and retry.
          const stripped = rawResultString
            .replace(/^```(?:json)?\s*\n?/i, '')
            .replace(/\n?```\s*$/i, '')
            .trim()

          try {
            return JSON.parse(stripped)
          } catch (innerError) {
            LogHelper.title('LLM Provider')
            LogHelper.warning(
              `Failed to parse JSON output for ${completionParams.dutyType}: ${
                (innerError as Error).message
              }`
            )
            return rawResultString
          }
        }
      })(),
      data: completionParams.data,
      functions: completionParams.functions,
      maxTokens: completionParams.maxTokens,
      thoughtTokensBudget: completionParams.thoughtTokensBudget,
      // Current used context size
      usedInputTokens,
      usedOutputTokens,
      ...(toolCalls ? { toolCalls } : {})
    }
  }
}
