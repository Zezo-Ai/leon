import type { AxiosResponse } from 'axios'
import { createOpenAI } from '@ai-sdk/openai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'

import type {
  CompletionParams,
  OpenAITool,
  OpenAIToolCall,
  OpenAIToolChoice,
  PromptOrChatHistory
} from '@/core/llm-manager/types'
import { LogHelper } from '@/helpers/log-helper'

type AISDKFlavor = 'openai-responses' | 'openai-compatible'

interface AISDKRemoteProviderConfig {
  name: string
  providerName: string
  apiKeyEnv: string
  agentModelEnv: string
  modelEnv: string
  defaultModel: string
  baseURL: string
  flavor: AISDKFlavor
  sendApiKeyAsBearer?: boolean
  headers?: (apiKey: string) => Record<string, string>
}

interface CallState {
  text: string
  reasoning: string
  toolCallsById: Record<
    string,
    {
      id: string
      functionName: string
      arguments: string
    }
  >
  toolCallOrder: string[]
  usedInputTokens: number
  usedOutputTokens: number
}

export default class AISDKRemoteLLMProvider {
  protected readonly name: string
  protected readonly apiKey: string | undefined
  protected readonly model: string

  private readonly config: AISDKRemoteProviderConfig
  private readonly languageModel: unknown

  constructor(config: AISDKRemoteProviderConfig) {
    this.config = config
    this.name = config.name
    this.apiKey = process.env[config.apiKeyEnv]
    this.model =
      process.env[config.agentModelEnv] ||
      process.env[config.modelEnv] ||
      config.defaultModel

    LogHelper.title(this.name)
    LogHelper.success('New instance')

    this.checkAPIKey()
    this.languageModel = this.createLanguageModel()
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

  private createLanguageModel(): unknown {
    const apiKey = this.apiKey || ''
    const headers = this.config.headers?.(apiKey)

    if (this.config.flavor === 'openai-responses') {
      const provider = createOpenAI({
        apiKey,
        baseURL: this.config.baseURL,
        ...(headers && Object.keys(headers).length > 0 ? { headers } : {})
      })

      return provider.responses(this.model)
    }

    const provider = createOpenAICompatible({
      name: this.config.providerName,
      baseURL: this.config.baseURL,
      ...(this.config.sendApiKeyAsBearer === false ? {} : { apiKey }),
      ...(headers && Object.keys(headers).length > 0 ? { headers } : {})
    })

    return provider(this.model)
  }

  private toTextPrompt(
    prompt: PromptOrChatHistory,
    completionParams: CompletionParams
  ): Array<Record<string, unknown>> {
    const messages: Array<Record<string, unknown>> = [
      {
        role: 'system',
        content: completionParams.systemPrompt
      }
    ]

    if (completionParams.history) {
      for (const message of completionParams.history) {
        messages.push({
          role: message.who === 'leon' ? 'assistant' : 'user',
          content: [
            {
              type: 'text',
              text: message.message
            }
          ]
        })
      }
    }

    const promptText =
      typeof prompt === 'string' ? prompt : JSON.stringify(prompt)
    const lastMessage = messages[messages.length - 1]
    const lastMessageText =
      lastMessage &&
      Array.isArray(lastMessage['content']) &&
      lastMessage['content'][0] &&
      typeof lastMessage['content'][0] === 'object' &&
      typeof (lastMessage['content'][0] as Record<string, unknown>)['text'] ===
        'string'
        ? ((lastMessage['content'][0] as Record<string, unknown>)['text'] as string)
        : ''

    if (!lastMessage || lastMessageText !== promptText) {
      messages.push({
        role: 'user',
        content: [
          {
            type: 'text',
            text: promptText
          }
        ]
      })
    }

    return messages
  }

  private normalizeSchema(
    schema: Record<string, unknown> | null | undefined
  ): Record<string, unknown> | undefined {
    if (!schema) {
      return undefined
    }

    if ('type' in schema || 'oneOf' in schema) {
      return schema
    }

    return {
      type: 'object',
      properties: schema
    }
  }

  private mergeStreamingChunk(accumulated: string, incoming: string): string {
    if (!incoming) {
      return ''
    }

    if (!accumulated) {
      return incoming
    }

    if (accumulated.endsWith(incoming)) {
      return ''
    }

    if (incoming.startsWith(accumulated)) {
      return incoming.slice(accumulated.length)
    }

    if (incoming.length >= 32 && accumulated.includes(incoming)) {
      return ''
    }

    const maxOverlap = Math.min(accumulated.length, incoming.length)
    for (let overlap = maxOverlap; overlap >= 1; overlap -= 1) {
      if (accumulated.slice(-overlap) === incoming.slice(0, overlap)) {
        return incoming.slice(overlap)
      }
    }

    return incoming
  }

  private toTools(tools: OpenAITool[] | undefined): Array<Record<string, unknown>> {
    if (!Array.isArray(tools) || tools.length === 0) {
      return []
    }

    return tools.map((tool) => ({
      type: 'function',
      name: tool.function.name,
      ...(tool.function.description
        ? { description: tool.function.description }
        : {}),
      inputSchema: tool.function.parameters as Record<string, unknown>,
      strict: false
    }))
  }

  private toToolChoice(
    toolChoice: OpenAIToolChoice | undefined
  ): Record<string, unknown> | undefined {
    if (!toolChoice) {
      return undefined
    }

    if (typeof toolChoice === 'string') {
      if (toolChoice === 'auto' || toolChoice === 'required' || toolChoice === 'none') {
        return { type: toolChoice }
      }

      return undefined
    }

    return {
      type: 'tool',
      toolName: toolChoice.function.name
    }
  }

  private buildCallOptions(
    prompt: PromptOrChatHistory,
    completionParams: CompletionParams
  ): Record<string, unknown> {
    const options: Record<string, unknown> = {
      prompt: this.toTextPrompt(prompt, completionParams),
      ...(completionParams.signal ? { abortSignal: completionParams.signal } : {}),
      ...(typeof completionParams.maxTokens === 'number'
        ? { maxOutputTokens: completionParams.maxTokens }
        : {}),
      ...(typeof completionParams.temperature === 'number'
        ? { temperature: completionParams.temperature }
        : {})
    }

    const tools = this.toTools(completionParams.tools)
    if (tools.length > 0) {
      options['tools'] = tools
    }

    const toolChoice = this.toToolChoice(completionParams.toolChoice)
    if (toolChoice) {
      options['toolChoice'] = toolChoice
    }

    const normalizedSchema = this.normalizeSchema(completionParams.data)
    if (normalizedSchema) {
      options['responseFormat'] = {
        type: 'json',
        schema: normalizedSchema,
        name: 'structured_output'
      }
    }

    const providerOptions: Record<string, unknown> = {}

    if (completionParams.disableThinking === true) {
      providerOptions['openai'] = {
        reasoningEffort: 'low'
      }
      providerOptions['openrouter'] = {
        reasoning: { enabled: false }
      }
      providerOptions['anthropic'] = {
        thinking: { type: 'disabled' }
      }
      providerOptions['groq'] = {
        thinking: { type: 'disabled' }
      }
      providerOptions['cerebras'] = {
        thinking: { type: 'disabled' }
      }
    } else if (this.config.flavor === 'openai-responses') {
      // For Responses API models (OpenAI/OpenRouter via createOpenAI), request
      // reasoning summaries so planning/recovery reasoning is visible in stream.
      providerOptions['openai'] = {
        reasoningSummary: 'detailed'
      }
    }

    if (Object.keys(providerOptions).length > 0) {
      options['providerOptions'] = providerOptions
    }

    return options
  }

  private ensureToolCall(state: CallState, toolCallId: string): void {
    if (!state.toolCallsById[toolCallId]) {
      state.toolCallsById[toolCallId] = {
        id: toolCallId,
        functionName: '',
        arguments: ''
      }
      state.toolCallOrder.push(toolCallId)
    }
  }

  private createCallState(): CallState {
    return {
      text: '',
      reasoning: '',
      toolCallsById: {},
      toolCallOrder: [],
      usedInputTokens: 0,
      usedOutputTokens: 0
    }
  }

  private appendUsageFromUnknown(state: CallState, usage: unknown): void {
    if (!usage || typeof usage !== 'object') {
      return
    }

    const usageObject = usage as Record<string, unknown>
    const readTokenCount = (value: unknown): number | undefined => {
      if (typeof value === 'number' && Number.isFinite(value)) {
        return value
      }
      if (value && typeof value === 'object') {
        const objectValue = value as Record<string, unknown>
        const total = objectValue['total']
        if (typeof total === 'number' && Number.isFinite(total)) {
          return total
        }
      }

      return undefined
    }

    const inputTokens =
      readTokenCount(usageObject['inputTokens']) ??
      readTokenCount(usageObject['input_tokens']) ??
      readTokenCount(usageObject['promptTokens']) ??
      readTokenCount(usageObject['prompt_tokens'])
    const outputTokens =
      readTokenCount(usageObject['outputTokens']) ??
      readTokenCount(usageObject['output_tokens']) ??
      readTokenCount(usageObject['completionTokens']) ??
      readTokenCount(usageObject['completion_tokens'])

    if (typeof inputTokens === 'number' && Number.isFinite(inputTokens)) {
      state.usedInputTokens = inputTokens
    }
    if (typeof outputTokens === 'number' && Number.isFinite(outputTokens)) {
      state.usedOutputTokens = outputTokens
    }
  }

  private buildOpenAICompatiblePayload(state: CallState): Record<string, unknown> {
    const toolCalls: OpenAIToolCall[] = state.toolCallOrder
      .map((toolCallId, index) => {
        const call = state.toolCallsById[toolCallId]
        if (!call) {
          return null
        }

        return {
          id: call.id || `tool_call_${index}`,
          type: 'function',
          function: {
            name: call.functionName,
            arguments: call.arguments || '{}'
          }
        } satisfies OpenAIToolCall
      })
      .filter(
        (toolCall): toolCall is OpenAIToolCall =>
          !!toolCall && toolCall.function.name.trim().length > 0
      )

    return {
      choices: [
        {
          message: {
            content: state.text,
            ...(state.reasoning.trim().length > 0
              ? { reasoning: state.reasoning.trim() }
              : {}),
            ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {})
          }
        }
      ],
      usage: {
        prompt_tokens: state.usedInputTokens,
        completion_tokens: state.usedOutputTokens
      }
    }
  }

  private async runNonStreamingCompletion(
    prompt: PromptOrChatHistory,
    completionParams: CompletionParams
  ): Promise<Record<string, unknown>> {
    const state = this.createCallState()
    const callOptions = this.buildCallOptions(prompt, completionParams)
    const result = await (
      this.languageModel as {
        doGenerate: (
          options: Record<string, unknown>
        ) => Promise<Record<string, unknown>>
      }
    ).doGenerate(callOptions)

    const content = Array.isArray(result['content'])
      ? (result['content'] as Array<Record<string, unknown>>)
      : []

    for (const part of content) {
      const type = typeof part['type'] === 'string' ? (part['type'] as string) : ''
      if (type === 'text' && typeof part['text'] === 'string') {
        state.text += part['text'] as string
        continue
      }

      if (type === 'reasoning' && typeof part['text'] === 'string') {
        state.reasoning += part['text'] as string
        continue
      }

      if (type === 'tool-call') {
        const toolCallId =
          typeof part['toolCallId'] === 'string'
            ? (part['toolCallId'] as string)
            : `tool_call_${state.toolCallOrder.length}`
        const toolName =
          typeof part['toolName'] === 'string' ? (part['toolName'] as string) : ''
        const input =
          typeof part['input'] === 'string'
            ? (part['input'] as string)
            : JSON.stringify(part['input'] ?? {})

        this.ensureToolCall(state, toolCallId)
        state.toolCallsById[toolCallId]!.functionName = toolName
        state.toolCallsById[toolCallId]!.arguments = input
      }
    }

    this.appendUsageFromUnknown(state, result['usage'])

    return this.buildOpenAICompatiblePayload(state)
  }

  private async runStreamingCompletion(
    prompt: PromptOrChatHistory,
    completionParams: CompletionParams
  ): Promise<Record<string, unknown>> {
    const state = this.createCallState()
    const callOptions = this.buildCallOptions(prompt, completionParams)
    const result = await (
      this.languageModel as {
        doStream: (
          options: Record<string, unknown>
        ) => Promise<{
          stream: AsyncIterable<Record<string, unknown>>
        }>
      }
    ).doStream(callOptions)

    // Signal streaming as soon as we receive a stream object, even if the
    // model emits only tool-call deltas and no text tokens.
    completionParams.onToken?.('')

    for await (const part of result.stream) {
      const type = typeof part['type'] === 'string' ? (part['type'] as string) : ''

      if (type === 'text-delta' && typeof part['delta'] === 'string') {
        const delta = part['delta'] as string
        const mergedDelta = this.mergeStreamingChunk(state.text, delta)
        if (!mergedDelta) {
          continue
        }
        state.text += mergedDelta
        completionParams.onToken?.(mergedDelta)
        continue
      }

      if (type === 'reasoning-delta' && typeof part['delta'] === 'string') {
        const delta = part['delta'] as string
        const mergedDelta = this.mergeStreamingChunk(state.reasoning, delta)
        if (!mergedDelta) {
          continue
        }
        state.reasoning += mergedDelta
        completionParams.onReasoningToken?.(mergedDelta)
        continue
      }

      if (type === 'reasoning' && typeof part['text'] === 'string') {
        const text = part['text'] as string
        const mergedText = this.mergeStreamingChunk(state.reasoning, text)
        if (!mergedText) {
          continue
        }
        state.reasoning += mergedText
        completionParams.onReasoningToken?.(mergedText)
        continue
      }

      if (type === 'tool-call') {
        const toolCallId =
          typeof part['toolCallId'] === 'string'
            ? (part['toolCallId'] as string)
            : `tool_call_${state.toolCallOrder.length}`
        const toolName =
          typeof part['toolName'] === 'string' ? (part['toolName'] as string) : ''
        const input =
          typeof part['input'] === 'string'
            ? (part['input'] as string)
            : JSON.stringify(part['input'] ?? {})

        this.ensureToolCall(state, toolCallId)
        state.toolCallsById[toolCallId]!.functionName = toolName
        state.toolCallsById[toolCallId]!.arguments = input
        continue
      }

      if (type === 'tool-input-start') {
        const toolCallId =
          typeof part['id'] === 'string'
            ? (part['id'] as string)
            : `tool_call_${state.toolCallOrder.length}`
        const toolName =
          typeof part['toolName'] === 'string' ? (part['toolName'] as string) : ''

        this.ensureToolCall(state, toolCallId)
        if (toolName) {
          state.toolCallsById[toolCallId]!.functionName = toolName
        }
        continue
      }

      if (type === 'tool-input-delta') {
        const toolCallId =
          typeof part['id'] === 'string'
            ? (part['id'] as string)
            : `tool_call_${state.toolCallOrder.length}`
        const delta = typeof part['delta'] === 'string' ? (part['delta'] as string) : ''

        this.ensureToolCall(state, toolCallId)
        state.toolCallsById[toolCallId]!.arguments += delta
        continue
      }

      if (type === 'tool-call-delta') {
        const toolCallId =
          typeof part['toolCallId'] === 'string'
            ? (part['toolCallId'] as string)
            : typeof part['id'] === 'string'
              ? (part['id'] as string)
              : `tool_call_${state.toolCallOrder.length}`
        const toolName =
          typeof part['toolName'] === 'string' ? (part['toolName'] as string) : ''
        const delta =
          typeof part['argsTextDelta'] === 'string'
            ? (part['argsTextDelta'] as string)
            : typeof part['delta'] === 'string'
              ? (part['delta'] as string)
              : ''

        this.ensureToolCall(state, toolCallId)
        if (toolName) {
          state.toolCallsById[toolCallId]!.functionName = toolName
        }
        if (delta) {
          state.toolCallsById[toolCallId]!.arguments += delta
        }
        continue
      }

      if (type === 'finish') {
        this.appendUsageFromUnknown(state, part['usage'])
        continue
      }

      if (type === 'error') {
        throw (
          part['error'] instanceof Error
            ? part['error']
            : new Error(String(part['error']))
        )
      }
    }

    return this.buildOpenAICompatiblePayload(state)
  }

  public runChatCompletion(
    prompt: PromptOrChatHistory,
    completionParams: CompletionParams
  ): Promise<AxiosResponse> {
    return new Promise(async (resolve, reject) => {
      try {
        this.checkAPIKey()

        const responseData =
          completionParams.shouldStream === true
            ? await this.runStreamingCompletion(prompt, completionParams)
            : await this.runNonStreamingCompletion(prompt, completionParams)

        return resolve({
          data: responseData
        } as AxiosResponse)
      } catch (e) {
        const errorMessage = `Failed to run completion: ${String(e)}`

        LogHelper.title(this.name)
        LogHelper.error(errorMessage)
        return reject(e instanceof Error ? e : new Error(errorMessage))
      }
    })
  }
}
