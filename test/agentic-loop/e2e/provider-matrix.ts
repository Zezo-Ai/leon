/**
 * Keep the provider matrix in one place so the Vitest spec and subprocess
 * runner stay in sync.
 */
export const PROVIDER_MATRIX = [
  {
    provider: 'openrouter',
    apiKeyEnv: 'LEON_OPENROUTER_API_KEY'
  },
  {
    provider: 'openai',
    apiKeyEnv: 'LEON_OPENAI_API_KEY'
  },
  {
    provider: 'anthropic',
    apiKeyEnv: 'LEON_ANTHROPIC_API_KEY'
  },
  {
    provider: 'moonshotai',
    apiKeyEnv: 'LEON_MOONSHOTAI_API_KEY'
  },
  {
    provider: 'zai',
    apiKeyEnv: 'LEON_ZAI_API_KEY'
  }
] as const

export type AgenticProvider = (typeof PROVIDER_MATRIX)[number]['provider']

export const PROVIDER_API_KEY_ENV = Object.fromEntries(
  PROVIDER_MATRIX.map(({ provider, apiKeyEnv }) => [provider, apiKeyEnv])
) as Record<AgenticProvider, string>
