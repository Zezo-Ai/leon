import AISDKRemoteLLMProvider, {
  type AISDKProviderRole
} from '@/core/llm-manager/llm-providers/ai-sdk-remote-llm-provider'

export default class MoonshotAILLMProvider extends AISDKRemoteLLMProvider {
  constructor(role: AISDKProviderRole = 'agent') {
    super({
      name: 'MoonshotAI LLM Provider',
      providerName: 'moonshotai',
      apiKeyEnv: 'LEON_MOONSHOTAI_API_KEY',
      workflowModelEnv: 'LEON_MOONSHOTAI_MODEL',
      agentModelEnv: 'LEON_MOONSHOTAI_AGENT_LLM',
      defaultModel: 'moonshot-v1-8k',
      baseURL: 'https://api.moonshot.ai/v1',
      flavor: 'moonshotai'
    }, role)
  }
}
