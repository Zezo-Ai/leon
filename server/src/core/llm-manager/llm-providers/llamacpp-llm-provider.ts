import fs from 'node:fs'
import path from 'node:path'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { Readable } from 'node:stream'

import axios, { type AxiosResponse } from 'axios'
import kill from 'tree-kill'

import AISDKRemoteLLMProvider, {
  type AISDKProviderRole
} from '@/core/llm-manager/llm-providers/ai-sdk-remote-llm-provider'
import type {
  CompletionParams,
  PromptOrChatHistory
} from '@/core/llm-manager/types'
import { BIN_PATH } from '@/constants'
import { LogHelper } from '@/helpers/log-helper'
import { SystemHelper } from '@/helpers/system-helper'

const LLAMACPP_BASE_URL = 'http://127.0.0.1:8080/v1'
const LLAMACPP_READY_TIMEOUT_MS = 120_000
const LLAMACPP_READY_POLL_INTERVAL_MS = 250
const LLAMACPP_SERVER_URL = new URL(LLAMACPP_BASE_URL)
const LLAMACPP_MODELS_URL = new URL(
  'models',
  LLAMACPP_BASE_URL.endsWith('/') ? LLAMACPP_BASE_URL : `${LLAMACPP_BASE_URL}/`
).toString()
const LLAMACPP_CHAT_COMPLETIONS_URL = new URL(
  'chat/completions',
  LLAMACPP_BASE_URL.endsWith('/') ? LLAMACPP_BASE_URL : `${LLAMACPP_BASE_URL}/`
).toString()
const LLAMACPP_SERVER_HOST = LLAMACPP_SERVER_URL.hostname
const LLAMACPP_SERVER_PORT = Number(
  LLAMACPP_SERVER_URL.port ||
    (LLAMACPP_SERVER_URL.protocol === 'https:' ? 443 : 80)
)

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs)
  })
}

function getLlamaServerBinaryPath(): string {
  return path.join(
    BIN_PATH,
    'llama.cpp',
    SystemHelper.isWindows() ? 'llama-server.exe' : 'llama-server'
  )
}

function resolveModelPath(modelPath: string): string {
  const normalizedModelPath = modelPath.trim()

  return path.isAbsolute(normalizedModelPath)
    ? normalizedModelPath
    : path.resolve(process.cwd(), normalizedModelPath)
}

/**
 * Share one llama-server process across workflow and agent providers.
 */
export default class LlamaCPPLLMProvider extends AISDKRemoteLLMProvider {
  private static serverProcess: ChildProcessWithoutNullStreams | null = null
  private static activeModelPath: string | null = null
  private static serverReady = false
  private static serverReadyPromise: Promise<void> | null = null
  private static instanceCount = 0

  private readonly modelPath: string

  constructor(role: AISDKProviderRole = 'agent') {
    super(
      {
        name: 'llama.cpp LLM Provider',
        providerName: 'llamacpp',
        apiKeyEnv: 'LEON_LLAMACPP_API_KEY',
        workflowModelEnv: 'LEON_LLAMACPP_MODEL_PATH',
        agentModelEnv: 'LEON_LLAMACPP_MODEL_PATH',
        defaultModel: '',
        baseURL: LLAMACPP_BASE_URL,
        flavor: 'openai-compatible',
        requiresApiKey: false
      },
      role
    )

    if (!this.model.trim()) {
      throw new Error(
        'llama.cpp model path is not defined. Please define LEON_LLAMACPP_MODEL_PATH in the .env file.'
      )
    }

    this.modelPath = resolveModelPath(this.model)
    LlamaCPPLLMProvider.instanceCount += 1
  }

  public override get modelName(): string {
    return this.modelPath
  }

  public override dispose(): void {
    super.dispose()

    LlamaCPPLLMProvider.instanceCount = Math.max(
      0,
      LlamaCPPLLMProvider.instanceCount - 1
    )

    if (LlamaCPPLLMProvider.instanceCount === 0) {
      void LlamaCPPLLMProvider.disposeSharedServer()
    }
  }

  public override async runChatCompletion(
    prompt: PromptOrChatHistory,
    completionParams: CompletionParams
  ): Promise<AxiosResponse> {
    await this.ensureServerReady()

    const isPlainTextRequest =
      !Array.isArray(completionParams.tools) && completionParams.data === null

    if (completionParams.shouldStream === true && isPlainTextRequest) {
      LogHelper.title('llama.cpp LLM Provider')
      LogHelper.warning(
        'Using direct llama.cpp streaming chat completion for plain-text request.'
      )

      return this.runDirectPlainTextStreamingCompletion(prompt, completionParams)
    }

    if (completionParams.shouldStream !== true && isPlainTextRequest) {
      LogHelper.title('llama.cpp LLM Provider')
      LogHelper.warning(
        'Using direct non-stream llama.cpp chat completion for plain-text request.'
      )

      return this.runDirectPlainTextCompletion(prompt, completionParams)
    }

    return super.runChatCompletion(prompt, completionParams)
  }

  private async runDirectPlainTextCompletion(
    prompt: PromptOrChatHistory,
    completionParams: CompletionParams
  ): Promise<AxiosResponse> {
    const response = await axios.post(
      LLAMACPP_CHAT_COMPLETIONS_URL,
      this.buildDirectPlainTextPayload(prompt, completionParams, false),
      this.buildDirectRequestConfig(completionParams)
    )

    return response as AxiosResponse
  }

  private async runDirectPlainTextStreamingCompletion(
    prompt: PromptOrChatHistory,
    completionParams: CompletionParams
  ): Promise<AxiosResponse> {
    const response = await axios.post(
      LLAMACPP_CHAT_COMPLETIONS_URL,
      this.buildDirectPlainTextPayload(prompt, completionParams, true),
      {
        ...this.buildDirectRequestConfig(completionParams),
        responseType: 'stream'
      }
    )

    const stream = response.data as Readable
    const aggregated = await this.consumeStreamingResponse(
      stream,
      completionParams
    )

    return {
      ...response,
      data: aggregated
    } as AxiosResponse
  }

  private buildDirectPlainTextPayload(
    prompt: PromptOrChatHistory,
    completionParams: CompletionParams,
    shouldStream: boolean
  ): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      model: this.modelPath,
      messages: this.toDirectChatMessages(prompt, completionParams),
      stream: shouldStream,
      temperature:
        typeof completionParams.temperature === 'number'
          ? completionParams.temperature
          : 0,
      max_tokens:
        typeof completionParams.maxTokens === 'number'
          ? completionParams.maxTokens
          : 256
    }

    if (completionParams.disableThinking === true) {
      payload['chat_template_kwargs'] = {
        enable_thinking: false
      }
      payload['reasoning_format'] = 'none'
    }

    return payload
  }

  private buildDirectRequestConfig(
    completionParams: CompletionParams
  ): Record<string, unknown> {
    return {
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer no-key'
      },
      ...(typeof completionParams.timeout === 'number'
        ? { timeout: completionParams.timeout }
        : {}),
      ...(completionParams.signal ? { signal: completionParams.signal } : {})
    }
  }

  private async consumeStreamingResponse(
    stream: Readable,
    completionParams: CompletionParams
  ): Promise<Record<string, unknown>> {
    let text = ''
    let reasoning = ''
    let promptTokens = 0
    let completionTokens = 0
    let buffer = ''

    const applyChunk = (chunk: Record<string, unknown>): void => {
      const usage =
        chunk['usage'] && typeof chunk['usage'] === 'object'
          ? (chunk['usage'] as Record<string, unknown>)
          : null
      if (usage) {
        if (typeof usage['prompt_tokens'] === 'number') {
          promptTokens = usage['prompt_tokens'] as number
        }
        if (typeof usage['completion_tokens'] === 'number') {
          completionTokens = usage['completion_tokens'] as number
        }
      }

      const choices = Array.isArray(chunk['choices'])
        ? (chunk['choices'] as Array<Record<string, unknown>>)
        : []
      const firstChoice = choices[0]
      if (!firstChoice || typeof firstChoice !== 'object') {
        return
      }

      const delta =
        firstChoice['delta'] && typeof firstChoice['delta'] === 'object'
          ? (firstChoice['delta'] as Record<string, unknown>)
          : null
      if (!delta) {
        return
      }

      const content = delta['content']
      if (typeof content === 'string' && content.length > 0) {
        text += content
        completionParams.onToken?.(content)
      }

      const reasoningChunk = this.readReasoningChunk(delta)
      if (reasoningChunk) {
        reasoning += reasoningChunk
        completionParams.onReasoningToken?.(reasoningChunk)
      }
    }

    const parseEvent = (rawEvent: string): void => {
      const lines = rawEvent.split('\n')
      const dataLines: string[] = []

      for (const rawLine of lines) {
        const line = rawLine.trim()
        if (!line || line.startsWith(':')) {
          continue
        }

        if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).trim())
        }
      }

      if (dataLines.length === 0) {
        return
      }

      const data = dataLines.join('\n')
      if (data === '[DONE]') {
        return
      }

      const parsed = JSON.parse(data)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        applyChunk(parsed as Record<string, unknown>)
      }
    }

    return new Promise((resolve, reject) => {
      stream.setEncoding('utf8')

      stream.on('data', (chunk: string) => {
        buffer += chunk.replace(/\r\n/g, '\n')

        while (true) {
          const separatorIndex = buffer.indexOf('\n\n')
          if (separatorIndex === -1) {
            break
          }

          const rawEvent = buffer.slice(0, separatorIndex)
          buffer = buffer.slice(separatorIndex + 2)

          try {
            parseEvent(rawEvent)
          } catch (error) {
            reject(error)
            return
          }
        }
      })

      stream.on('end', () => {
        const remainingEvent = buffer.trim()
        if (remainingEvent) {
          try {
            parseEvent(remainingEvent)
          } catch (error) {
            reject(error)
            return
          }
        }

        resolve({
          choices: [
            {
              message: {
                content: text,
                ...(reasoning.trim() ? { reasoning: reasoning.trim() } : {})
              }
            }
          ],
          usage: {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens
          }
        })
      })

      stream.on('error', (error) => {
        reject(error)
      })
    })
  }

  private readReasoningChunk(delta: Record<string, unknown>): string {
    const directReasoningFields = [
      delta['reasoning'],
      delta['reasoning_content'],
      delta['reasoningContent']
    ]

    for (const field of directReasoningFields) {
      if (typeof field === 'string' && field.length > 0) {
        return field
      }
    }

    const content = Array.isArray(delta['content'])
      ? (delta['content'] as Array<Record<string, unknown>>)
      : null
    if (!content) {
      return ''
    }

    let reasoning = ''
    for (const item of content) {
      if (!item || typeof item !== 'object') {
        continue
      }

      const type = typeof item['type'] === 'string' ? item['type'] : ''
      if (type !== 'reasoning' && type !== 'thinking') {
        continue
      }

      const text =
        typeof item['text'] === 'string'
          ? item['text']
          : typeof item['content'] === 'string'
            ? item['content']
            : ''

      if (text) {
        reasoning += text
      }
    }

    return reasoning
  }

  private toDirectChatMessages(
    prompt: PromptOrChatHistory,
    completionParams: CompletionParams
  ): Array<Record<string, string>> {
    const messages: Array<Record<string, string>> = []
    const systemPrompt = String(completionParams.systemPrompt ?? '').trim()

    if (systemPrompt) {
      messages.push({
        role: 'system',
        content: systemPrompt
      })
    }

    if (completionParams.history) {
      for (const message of completionParams.history) {
        messages.push({
          role: message.who === 'leon' ? 'assistant' : 'user',
          content: message.message
        })
      }
    }

    const promptText =
      typeof prompt === 'string' ? prompt : JSON.stringify(prompt)

    if (promptText.trim()) {
      messages.push({
        role: 'user',
        content: promptText
      })
    }

    return messages
  }

  private async ensureServerReady(): Promise<void> {
    if (
      LlamaCPPLLMProvider.serverReady &&
      LlamaCPPLLMProvider.serverProcess &&
      !LlamaCPPLLMProvider.serverProcess.killed &&
      LlamaCPPLLMProvider.activeModelPath === this.modelPath
    ) {
      return
    }

    if (
      LlamaCPPLLMProvider.serverProcess &&
      LlamaCPPLLMProvider.activeModelPath !== this.modelPath
    ) {
      await LlamaCPPLLMProvider.disposeSharedServer()
    }

    if (LlamaCPPLLMProvider.serverReadyPromise) {
      return LlamaCPPLLMProvider.serverReadyPromise
    }

    const startupPromise = LlamaCPPLLMProvider.startSharedServer(this.modelPath)
    LlamaCPPLLMProvider.serverReadyPromise = startupPromise

    try {
      await startupPromise
    } finally {
      if (LlamaCPPLLMProvider.serverReadyPromise === startupPromise) {
        LlamaCPPLLMProvider.serverReadyPromise = null
      }
    }
  }

  private static async startSharedServer(modelPath: string): Promise<void> {
    const binaryPath = getLlamaServerBinaryPath()

    if (!fs.existsSync(binaryPath)) {
      throw new Error(
        `Cannot find llama.cpp server binary at "${binaryPath}".`
      )
    }

    if (!fs.existsSync(modelPath)) {
      throw new Error(
        `Cannot find llama.cpp model at "${modelPath}".`
      )
    }

    const existingServerProbe = await this.probeServerReady()
    if (existingServerProbe.ready) {
      throw new Error(
        `Cannot start llama-server because "${LLAMACPP_MODELS_URL}" is already responding.`
      )
    }

    LogHelper.title('llama.cpp LLM Provider')
    LogHelper.info(`Starting llama-server with model "${modelPath}"...`)

    const serverProcess = spawn(
      binaryPath,
      [
        '--model',
        modelPath,
        '--host',
        LLAMACPP_SERVER_HOST,
        '--port',
        String(LLAMACPP_SERVER_PORT),
        '--ctx-size',
        '16384',
        '--flash-attn',
        'on',
        '--cache-type-k',
        'q8_0',
        '--cache-type-v',
        'q8_0'
      ],
      {
        cwd: process.cwd(),
        env: process.env
      }
    )

    this.serverProcess = serverProcess
    this.activeModelPath = modelPath
    this.serverReady = false

    serverProcess.on('exit', (code, signal) => {
      if (this.serverProcess !== serverProcess) {
        return
      }

      this.serverProcess = null
      this.activeModelPath = null
      this.serverReady = false
      this.serverReadyPromise = null

      LogHelper.title('llama.cpp LLM Provider')
      LogHelper.warning(
        `llama-server exited with code=${code ?? 'null'} signal=${signal ?? 'null'}`
      )
    })

    serverProcess.stderr.on('data', (data: Buffer) => {
      const message = data.toString().trim()

      if (!message) {
        return
      }

      LogHelper.title('llama.cpp LLM Provider')
      LogHelper.warning(message)
    })

    try {
      await this.waitForServerReady(serverProcess)
      this.serverReady = true

      LogHelper.title('llama.cpp LLM Provider')
      LogHelper.success('llama-server is ready')
    } catch (error) {
      await this.disposeSharedServer()
      throw error
    }
  }

  private static async waitForServerReady(
    serverProcess: ChildProcessWithoutNullStreams
  ): Promise<void> {
    let spawnError: Error | null = null
    let lastHealthErrorMessage = ''

    serverProcess.once('error', (error) => {
      spawnError = error instanceof Error ? error : new Error(String(error))
    })

    const deadline = Date.now() + LLAMACPP_READY_TIMEOUT_MS

    while (Date.now() < deadline) {
      if (spawnError) {
        throw spawnError
      }

      if (serverProcess.exitCode !== null) {
        throw new Error(
          `llama-server exited before it became ready (code=${serverProcess.exitCode}).`
        )
      }

      if (serverProcess.signalCode !== null) {
        throw new Error(
          `llama-server exited before it became ready (signal=${serverProcess.signalCode}).`
        )
      }

      const readinessProbe = await this.probeServerReady()
      if (readinessProbe.ready) {
        return
      }

      lastHealthErrorMessage = readinessProbe.errorMessage

      await wait(LLAMACPP_READY_POLL_INTERVAL_MS)
    }

    const lastErrorSuffix = lastHealthErrorMessage
      ? ` Last probe error: ${lastHealthErrorMessage}`
      : ''

    throw new Error(
      `Timed out while waiting for llama-server to become ready.${lastErrorSuffix}`
    )
  }

  private static async probeServerReady(): Promise<{
    ready: boolean
    errorMessage: string
  }> {
    try {
      await axios.get(LLAMACPP_MODELS_URL, {
        timeout: 1_000
      })

      return {
        ready: true,
        errorMessage: ''
      }
    } catch (error) {
      return {
        ready: false,
        errorMessage: error instanceof Error ? error.message : String(error)
      }
    }
  }

  private static async disposeSharedServer(): Promise<void> {
    const serverProcess = this.serverProcess

    this.serverProcess = null
    this.activeModelPath = null
    this.serverReady = false
    this.serverReadyPromise = null

    if (!serverProcess?.pid) {
      return
    }

    await new Promise<void>((resolve) => {
      kill(serverProcess.pid as number, 'SIGTERM', () => {
        resolve()
      })
    })

    LogHelper.title('llama.cpp LLM Provider')
    LogHelper.info('Stopped llama-server')
  }
}
