import AISDKRemoteLLMProvider from '@/core/llm-manager/llm-providers/ai-sdk-remote-llm-provider'

/**
 * @see https://console.groq.com/docs/text-chat
 */
export default class GroqLLMProvider extends AISDKRemoteLLMProvider {
  constructor() {
    super({
      name: 'Groq LLM Provider',
      providerName: 'groq',
      apiKeyEnv: 'LEON_GROQ_API_KEY',
      agentModelEnv: 'LEON_GROQ_AGENT_LLM',
      modelEnv: 'LEON_GROQ_MODEL',
      defaultModel: 'llama-3.1-8b-instant',
      baseURL: 'https://api.groq.com/openai/v1',
      flavor: 'groq'
    })
  }
}
