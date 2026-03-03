import AISDKRemoteLLMProvider from '@/core/llm-manager/llm-providers/ai-sdk-remote-llm-provider'

export default class OpenRouterLLMProvider extends AISDKRemoteLLMProvider {
  constructor() {
    super({
      name: 'OpenRouter LLM Provider',
      providerName: 'openrouter',
      apiKeyEnv: 'LEON_OPENROUTER_API_KEY',
      agentModelEnv: 'LEON_OPENROUTER_AGENT_LLM',
      modelEnv: 'LEON_OPENROUTER_MODEL',
      defaultModel: 'openrouter/auto',
      baseURL: 'https://openrouter.ai/api/v1',
      flavor: 'openai-responses'
    })
  }
}
