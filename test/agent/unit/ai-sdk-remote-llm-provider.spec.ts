import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ResolvedLLMTarget } from '@/core/llm-manager/llm-routing'
import type { CompletionParams } from '@/core/llm-manager/types'
import { LLMDuties, LLMProviders } from '@/core/llm-manager/types'
import OpenRouterLLMProvider from '@/core/llm-manager/llm-providers/openrouter-llm-provider'

const openRouterMocks = vi.hoisted(() => {
  const languageModel = {
    doGenerate: vi.fn(),
    doStream: vi.fn()
  }
  const chat = vi.fn(() => languageModel)
  const createOpenRouter = vi.fn(() => ({
    chat
  }))

  return {
    chat,
    createOpenRouter,
    languageModel
  }
})

vi.mock('@openrouter/ai-sdk-provider', () => ({
  createOpenRouter: openRouterMocks.createOpenRouter
}))

vi.mock('@/config', () => ({
  CONFIG_MANAGER: {
    getProviderAPIKeyEnv: vi.fn(() => null)
  }
}))

vi.mock('@/helpers/log-helper', () => ({
  LogHelper: {
    title: vi.fn(),
    success: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    warning: vi.fn(),
    error: vi.fn()
  }
}))

interface ProviderWithPrivateCallOptions {
  buildCallOptions(
    prompt: string,
    completionParams: CompletionParams
  ): Record<string, unknown>
}

function createOpenRouterProvider(): ProviderWithPrivateCallOptions {
  const target: ResolvedLLMTarget = {
    provider: LLMProviders.OpenRouter,
    model: 'qwen/qwen3.7-max',
    label: 'openrouter/qwen/qwen3.7-max',
    isLocal: false,
    isEnabled: true,
    isResolved: true
  }

  return new OpenRouterLLMProvider(target) as unknown as ProviderWithPrivateCallOptions
}

function createCompletionParams(
  data: CompletionParams['data']
): CompletionParams {
  return {
    dutyType: LLMDuties.ReAct,
    systemPrompt: 'Plan the next step.',
    data
  }
}

describe('AISDKRemoteLLMProvider', () => {
  beforeEach(() => {
    vi.stubEnv('LEON_OPENROUTER_API_KEY', 'test-openrouter-key')
  })

  it('adds a JSON instruction when structured response format is enabled', () => {
    const provider = createOpenRouterProvider()
    const options = provider.buildCallOptions('Choose a tool.', createCompletionParams({
      type: 'object',
      properties: {
        type: { type: 'string' }
      },
      required: ['type'],
      additionalProperties: false
    }))

    const messages = options['prompt'] as Array<Record<string, unknown>>
    const systemMessage = messages[0] as Record<string, unknown>

    expect(systemMessage['role']).toBe('system')
    expect(systemMessage['content']).toContain('JSON')
    expect(options['responseFormat']).toEqual({
      type: 'json',
      schema: {
        type: 'object',
        properties: {
          type: { type: 'string' }
        },
        required: ['type'],
        additionalProperties: false
      },
      name: 'structured_output'
    })
  })

  it('does not add the JSON instruction for plain text calls', () => {
    const provider = createOpenRouterProvider()
    const options = provider.buildCallOptions(
      'Answer normally.',
      createCompletionParams(null)
    )

    const messages = options['prompt'] as Array<Record<string, unknown>>
    const systemMessage = messages[0] as Record<string, unknown>

    expect(systemMessage['content']).toBe('Plan the next step.')
    expect(options['responseFormat']).toBeUndefined()
  })
})
