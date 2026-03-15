import AISDKRemoteLLMProvider, {
  type AISDKProviderRole
} from '@/core/llm-manager/llm-providers/ai-sdk-remote-llm-provider'

export default class AnthropicLLMProvider extends AISDKRemoteLLMProvider {
  constructor(role: AISDKProviderRole = 'agent') {
    super({
      name: 'Anthropic LLM Provider',
      providerName: 'anthropic',
      apiKeyEnv: 'LEON_ANTHROPIC_API_KEY',
      workflowModelEnv: 'LEON_ANTHROPIC_MODEL',
      agentModelEnv: 'LEON_ANTHROPIC_AGENT_LLM',
      defaultModel: 'claude-3-5-sonnet-latest',
      baseURL: 'https://api.anthropic.com/v1',
      flavor: 'anthropic'
    }, role)
  }
}
