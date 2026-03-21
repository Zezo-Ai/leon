import AISDKRemoteLLMProvider from '@/core/llm-manager/llm-providers/ai-sdk-remote-llm-provider'
import type { ResolvedLLMTarget } from '@/core/llm-manager/llm-routing'

/**
 * @see https://docs.sglang.ai/basic_usage/openai_api_completions.html
 */
export default class SGLangLLMProvider extends AISDKRemoteLLMProvider {
  constructor(target: ResolvedLLMTarget) {
    super({
      name: 'SGLang LLM Provider',
      providerName: 'sglang',
      apiKeyEnv: 'LEON_SGLANG_API_KEY',
      model: target.model,
      baseURL: process.env['LEON_SGLANG_BASE_URL'] || 'http://127.0.0.1:30000/v1',
      flavor: 'openai-compatible',
      requiresApiKey: false
    })
  }
}
