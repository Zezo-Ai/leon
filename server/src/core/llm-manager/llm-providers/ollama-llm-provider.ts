import AISDKRemoteLLMProvider, {
  type AISDKProviderRole
} from '@/core/llm-manager/llm-providers/ai-sdk-remote-llm-provider'

function normalizeOllamaBaseURL(baseURL: string): string {
  const normalizedBaseURL = baseURL.trim()

  if (!normalizedBaseURL) {
    return 'http://127.0.0.1:11434'
  }

  try {
    const url = new URL(normalizedBaseURL)
    const pathSegments = url.pathname.split('/').filter(Boolean)

    if (pathSegments[pathSegments.length - 1] === 'v1') {
      pathSegments.pop()
      url.pathname =
        pathSegments.length > 0 ? `/${pathSegments.join('/')}` : ''
    }

    return url.toString()
  } catch {
    return normalizedBaseURL.endsWith('/v1')
      ? normalizedBaseURL.slice(0, -3)
      : normalizedBaseURL
  }
}

/**
 * @see https://github.com/jagreehal/ai-sdk-ollama/blob/main/README.md
 */
export default class OllamaLLMProvider extends AISDKRemoteLLMProvider {
  constructor(role: AISDKProviderRole = 'agent') {
    super({
      name: 'Ollama LLM Provider',
      providerName: 'ollama',
      apiKeyEnv: 'LEON_OLLAMA_API_KEY',
      workflowModelEnv: 'LEON_OLLAMA_MODEL',
      agentModelEnv: 'LEON_OLLAMA_AGENT_LLM',
      defaultModel: 'gpt-oss:20b',
      baseURL: normalizeOllamaBaseURL(
        process.env['LEON_OLLAMA_BASE_URL'] || 'http://127.0.0.1:11434'
      ),
      flavor: 'ollama',
      requiresApiKey: false
    }, role)
  }
}
