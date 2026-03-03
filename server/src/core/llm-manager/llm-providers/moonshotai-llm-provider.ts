import AISDKRemoteLLMProvider from '@/core/llm-manager/llm-providers/ai-sdk-remote-llm-provider'

export default class MoonshotAILLMProvider extends AISDKRemoteLLMProvider {
  constructor() {
    super({
      name: 'MoonshotAI LLM Provider',
      providerName: 'moonshotai',
      apiKeyEnv: 'LEON_MOONSHOTAI_API_KEY',
      agentModelEnv: 'LEON_MOONSHOTAI_AGENT_LLM',
      modelEnv: 'LEON_MOONSHOTAI_MODEL',
      defaultModel: 'moonshot-v1-8k',
      baseURL: 'https://api.moonshot.ai/v1',
      flavor: 'moonshotai'
    })
  }
}
