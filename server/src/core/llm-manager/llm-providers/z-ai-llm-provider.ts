import AISDKRemoteLLMProvider, {
  type AISDKProviderRole
} from '@/core/llm-manager/llm-providers/ai-sdk-remote-llm-provider'

/**
 * @see https://docs.z.ai/api-reference/llm/chat-completion
 */
export default class ZAILLMProvider extends AISDKRemoteLLMProvider {
  constructor(role: AISDKProviderRole = 'agent') {
    super({
      name: 'Z-AI LLM Provider',
      providerName: 'zai',
      apiKeyEnv: 'LEON_ZAI_API_KEY',
      workflowModelEnv: 'LEON_ZAI_MODEL',
      agentModelEnv: 'LEON_ZAI_AGENT_LLM',
      defaultModel: 'glm-5',
      baseURL: 'https://api.z.ai/api/paas/v4',
      flavor: 'openai-compatible'
    }, role)
  }
}
