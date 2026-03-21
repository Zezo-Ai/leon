import AISDKRemoteLLMProvider from '@/core/llm-manager/llm-providers/ai-sdk-remote-llm-provider'
import type { ResolvedLLMTarget } from '@/core/llm-manager/llm-routing'

export default class AnthropicLLMProvider extends AISDKRemoteLLMProvider {
  constructor(target: ResolvedLLMTarget) {
    super({
      name: 'Anthropic LLM Provider',
      providerName: 'anthropic',
      apiKeyEnv: 'LEON_ANTHROPIC_API_KEY',
      model: target.model,
      baseURL: 'https://api.anthropic.com/v1',
      flavor: 'anthropic'
    })
  }
}
