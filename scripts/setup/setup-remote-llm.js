import { SetupUI, setupConsola } from './setup-ui'

const REMOTE_LLM_PROVIDERS = [
  {
    label: 'OpenRouter',
    value: 'openrouter',
    apiKeyEnv: 'LEON_OPENROUTER_API_KEY',
    apiKeyURL: 'https://openrouter.ai/settings/keys',
    models: [
      { label: 'openai/gpt-5.4 (Recommended)', value: 'openai/gpt-5.4' },
      { label: 'openai/gpt-5.4-mini', value: 'openai/gpt-5.4-mini' },
      { label: 'openai/gpt-5.2', value: 'openai/gpt-5.2' },
      {
        label: 'anthropic/claude-opus-4.6',
        value: 'anthropic/claude-opus-4.6'
      },
      {
        label: 'anthropic/claude-sonnet-4.6',
        value: 'anthropic/claude-sonnet-4.6'
      },
      {
        label: 'anthropic/claude-haiku-4.5',
        value: 'anthropic/claude-haiku-4.5'
      },
      { label: 'z-ai/glm-5-turbo', value: 'z-ai/glm-5-turbo' },
      { label: 'z-ai/glm-5', value: 'z-ai/glm-5' },
      { label: 'xiaomi/mimo-v2-pro', value: 'xiaomi/mimo-v2-pro' },
      { label: 'xiaomi/mimo-v2-omni', value: 'xiaomi/mimo-v2-omni' },
      { label: 'minimax/minimax-m2.7', value: 'minimax/minimax-m2.7' },
      { label: 'moonshotai/kimi-k2.5', value: 'moonshotai/kimi-k2.5' },
      {
        label: 'qwen/qwen3.5-397b-a17b',
        value: 'qwen/qwen3.5-397b-a17b'
      }
    ]
  },
  {
    label: 'OpenAI',
    value: 'openai',
    apiKeyEnv: 'LEON_OPENAI_API_KEY',
    apiKeyURL: 'https://platform.openai.com/api-keys',
    models: [
      { label: 'GPT-5.4 (Recommended)', value: 'gpt-5.4' },
      { label: 'GPT-5.4 mini', value: 'gpt-5.4-mini' },
      { label: 'GPT-5.4 nano', value: 'gpt-5.4-nano' }
    ]
  },
  {
    label: 'Anthropic',
    value: 'anthropic',
    apiKeyEnv: 'LEON_ANTHROPIC_API_KEY',
    apiKeyURL: 'https://console.anthropic.com/settings/keys',
    models: [
      { label: 'Claude Opus 4.6 (Recommended)', value: 'claude-opus-4-6' },
      { label: 'Claude Sonnet 4.6', value: 'claude-sonnet-4-6' },
      { label: 'Claude Haiku 4.5', value: 'claude-haiku-4-5' }
    ]
  },
  {
    label: 'Z.AI',
    value: 'zai',
    apiKeyEnv: 'LEON_ZAI_API_KEY',
    apiKeyURL: 'https://z.ai/manage-apikey/apikey-list',
    models: [
      { label: 'GLM-5-Turbo (Recommended)', value: 'glm-5-turbo' },
      { label: 'GLM-5', value: 'glm-5' }
    ]
  },
  {
    label: 'Moonshot AI',
    value: 'moonshotai',
    apiKeyEnv: 'LEON_MOONSHOTAI_API_KEY',
    apiKeyURL: 'https://platform.moonshot.ai/console/api-keys',
    models: [{ label: 'Kimi K2.5', value: 'kimi-k2.5' }]
  }
]

function getProviderOptions() {
  return REMOTE_LLM_PROVIDERS.map((provider) => ({
    label: provider.label,
    value: provider.value
  }))
}

function getProviderConfig(providerValue) {
  return REMOTE_LLM_PROVIDERS.find(
    (provider) => provider.value === providerValue
  )
}

/**
 * Ask for a remote LLM provider, model, and API key when local AI is skipped.
 */
export default async function setupRemoteLLM() {
  SetupUI.info(
    'No problem. I can use an online AI service instead.'
  )
  SetupUI.info(
    'I just need 3 quick details so I can connect it for you.'
  )

  const providerValue = await setupConsola.prompt(
    'Which online AI service should I use?',
    {
      type: 'select',
      initial: REMOTE_LLM_PROVIDERS[0].value,
      options: getProviderOptions(),
      cancel: 'default'
    }
  )
  const provider = getProviderConfig(providerValue)

  if (!provider) {
    throw new Error(`Unsupported remote LLM provider "${providerValue}".`)
  }

  const modelValue = await setupConsola.prompt(
    `Which model should I use with ${provider.label}?`,
    {
      type: 'select',
      initial: provider.models[0].value,
      options: provider.models,
      cancel: 'default'
    }
  )

  SetupUI.info(
    `Create your API key here: ${SetupUI.underlined(provider.apiKeyURL)}`
  )
  const apiKey = await setupConsola.prompt(
    `Paste your ${provider.label} API key. I will save it in your local .env file.`,
    {
      type: 'text',
      placeholder: 'Paste API key here',
      validate(value) {
        if (!value || value.trim() === '') {
          return 'Please paste your API key.'
        }
      },
      cancel: 'default'
    }
  )

  return {
    providerLabel: provider.label,
    providerValue: provider.value,
    modelValue,
    apiKeyEnv: provider.apiKeyEnv,
    apiKey
  }
}
