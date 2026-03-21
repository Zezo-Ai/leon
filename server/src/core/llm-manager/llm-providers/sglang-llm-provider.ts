import AISDKRemoteLLMProvider, {
  type AISDKProviderRole
} from '@/core/llm-manager/llm-providers/ai-sdk-remote-llm-provider'

/**
 * @see https://docs.sglang.ai/basic_usage/openai_api_completions.html
 */
export default class SGLangLLMProvider extends AISDKRemoteLLMProvider {
  constructor(role: AISDKProviderRole = 'agent') {
    super({
      name: 'SGLang LLM Provider',
      providerName: 'sglang',
      apiKeyEnv: 'LEON_SGLANG_API_KEY',
      workflowModelEnv: 'LEON_SGLANG_MODEL_PATH',
      agentModelEnv: 'LEON_SGLANG_MODEL_PATH',
      defaultModel: 'Qwen/Qwen3-Coder-Next',
      baseURL: process.env['LEON_SGLANG_BASE_URL'] || 'http://127.0.0.1:30000/v1',
      flavor: 'openai-compatible',
      requiresApiKey: false
    }, role)
  }
}
