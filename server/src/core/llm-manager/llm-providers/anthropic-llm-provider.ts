import AISDKRemoteLLMProvider from '@/core/llm-manager/llm-providers/ai-sdk-remote-llm-provider'

export default class AnthropicLLMProvider extends AISDKRemoteLLMProvider {
  constructor() {
    super({
      name: 'Anthropic LLM Provider',
      providerName: 'anthropic',
      apiKeyEnv: 'LEON_ANTHROPIC_API_KEY',
      agentModelEnv: 'LEON_ANTHROPIC_AGENT_LLM',
      modelEnv: 'LEON_ANTHROPIC_MODEL',
      defaultModel: 'claude-3-5-sonnet-latest',
      baseURL: 'https://api.anthropic.com/v1',
      flavor: 'openai-compatible',
      sendApiKeyAsBearer: false,
      headers: (apiKey) => ({
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      })
    })
  }
}
