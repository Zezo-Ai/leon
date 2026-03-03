import AISDKRemoteLLMProvider from '@/core/llm-manager/llm-providers/ai-sdk-remote-llm-provider'

/**
 * @see https://router.huggingface.co/v1/chat/completions
 */
export default class HuggingFaceLLMProvider extends AISDKRemoteLLMProvider {
  constructor() {
    super({
      name: 'HuggingFace LLM Provider',
      providerName: 'huggingface',
      apiKeyEnv: 'LEON_HUGGINGFACE_API_KEY',
      agentModelEnv: 'LEON_HUGGINGFACE_AGENT_LLM',
      modelEnv: 'LEON_HUGGINGFACE_MODEL',
      defaultModel: 'meta-llama/Meta-Llama-3.1-8B-Instruct',
      baseURL: 'https://router.huggingface.co/v1',
      flavor: 'huggingface'
    })
  }
}
