import AISDKRemoteLLMProvider, {
  type AISDKProviderRole
} from '@/core/llm-manager/llm-providers/ai-sdk-remote-llm-provider'

export default class OpenRouterLLMProvider extends AISDKRemoteLLMProvider {
  constructor(role: AISDKProviderRole = 'agent') {
    super({
      name: 'OpenRouter LLM Provider',
      providerName: 'openrouter',
      apiKeyEnv: 'LEON_OPENROUTER_API_KEY',
      workflowModelEnv: 'LEON_OPENROUTER_MODEL',
      agentModelEnv: 'LEON_OPENROUTER_AGENT_LLM',
      defaultModel: 'openrouter/auto',
      baseURL: 'https://openrouter.ai/api/v1',
      flavor: 'openrouter'
    }, role)
  }
}
