import AISDKRemoteLLMProvider, {
  type AISDKProviderRole
} from '@/core/llm-manager/llm-providers/ai-sdk-remote-llm-provider'

/**
 * @see https://inference-docs.cerebras.ai/api-reference/chat-completions
 */
export default class CerebrasLLMProvider extends AISDKRemoteLLMProvider {
  constructor(role: AISDKProviderRole = 'agent') {
    super({
      name: 'Cerebras LLM Provider',
      providerName: 'cerebras',
      apiKeyEnv: 'LEON_CEREBRAS_API_KEY',
      workflowModelEnv: 'LEON_CEREBRAS_MODEL',
      agentModelEnv: 'LEON_CEREBRAS_AGENT_LLM',
      defaultModel: 'gpt-oss-120b',
      baseURL: 'https://api.cerebras.ai/v1',
      flavor: 'cerebras'
    }, role)
  }
}
