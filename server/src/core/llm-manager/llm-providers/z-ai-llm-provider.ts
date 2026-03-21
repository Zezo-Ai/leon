import AISDKRemoteLLMProvider from '@/core/llm-manager/llm-providers/ai-sdk-remote-llm-provider'
import type { ResolvedLLMTarget } from '@/core/llm-manager/llm-routing'

/**
 * @see https://docs.z.ai/api-reference/llm/chat-completion
 */
export default class ZAILLMProvider extends AISDKRemoteLLMProvider {
  constructor(target: ResolvedLLMTarget) {
    super({
      name: 'Z-AI LLM Provider',
      providerName: 'zai',
      apiKeyEnv: 'LEON_ZAI_API_KEY',
      model: target.model,
      baseURL: 'https://api.z.ai/api/paas/v4',
      flavor: 'openai-compatible'
    })
  }
}
