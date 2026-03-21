import fs from 'node:fs'
import path from 'node:path'

import { LLMProviders } from '@/core/llm-manager/types'

export interface ResolvedLLMTarget {
  provider: LLMProviders
  model: string
  label: string
  isLocal: boolean
}

export interface RoutingModeLLMDisplay {
  heading: 'LLM' | 'LLMs'
  value: string
}

interface LLMManifest {
  defaultInstalledLLMPath?: string
  name?: string
  version?: string
}

const LOCAL_PROVIDERS = new Set<LLMProviders>([
  LLMProviders.LlamaCPP,
  LLMProviders.SGLang
])

export function readLLMManifest(llmManifestPath: string): LLMManifest | null {
  if (!fs.existsSync(llmManifestPath)) {
    return null
  }

  try {
    return JSON.parse(fs.readFileSync(llmManifestPath, 'utf8')) as LLMManifest
  } catch {
    return null
  }
}

function normalizeProvider(rawProvider: string): LLMProviders {
  const provider = rawProvider.trim() as LLMProviders

  if (!Object.values(LLMProviders).includes(provider)) {
    throw new Error(`Unsupported LLM provider "${rawProvider.trim()}".`)
  }

  if (provider === LLMProviders.Local) {
    throw new Error(`Unsupported LLM provider "${rawProvider.trim()}".`)
  }

  return provider
}

function resolveLocalModelPath(llmDirPath: string, model: string): string {
  const normalizedModel = model.trim()

  if (!normalizedModel) {
    throw new Error('A local LLM target must include a model path or filename.')
  }

  return path.isAbsolute(normalizedModel)
    ? normalizedModel
    : path.join(llmDirPath, normalizedModel)
}

function getLocalModelLabel(modelPath: string): string {
  return path.basename(modelPath) || modelPath
}

export function resolveConfiguredLLMTarget(
  rawValue: string,
  options: {
    defaultInstalledLLMPath: string
    llmDirPath: string
  }
): ResolvedLLMTarget {
  const normalizedValue = rawValue.trim()

  if (!normalizedValue) {
    if (!options.defaultInstalledLLMPath) {
      throw new Error(
        'No LLM is configured and no default installed local LLM was found.'
      )
    }

    return {
      provider: LLMProviders.LlamaCPP,
      model: options.defaultInstalledLLMPath,
      label: `${LLMProviders.LlamaCPP}/${getLocalModelLabel(options.defaultInstalledLLMPath)}`,
      isLocal: true
    }
  }

  if (path.isAbsolute(normalizedValue)) {
    return {
      provider: LLMProviders.LlamaCPP,
      model: normalizedValue,
      label: `${LLMProviders.LlamaCPP}/${getLocalModelLabel(normalizedValue)}`,
      isLocal: true
    }
  }

  const separatorIndex = normalizedValue.indexOf('/')

  if (separatorIndex === -1) {
    const provider = normalizeProvider(normalizedValue)

    if (!LOCAL_PROVIDERS.has(provider)) {
      throw new Error(
        `The LLM target "${normalizedValue}" is missing its model identifier.`
      )
    }

    if (!options.defaultInstalledLLMPath) {
      throw new Error(
        `No default installed local LLM was found for provider "${provider}".`
      )
    }

    return {
      provider,
      model: options.defaultInstalledLLMPath,
      label: `${provider}/${getLocalModelLabel(options.defaultInstalledLLMPath)}`,
      isLocal: true
    }
  }

  const provider = normalizeProvider(normalizedValue.slice(0, separatorIndex))
  const model = normalizedValue.slice(separatorIndex + 1).trim()

  if (!model) {
    throw new Error(
      `The LLM target "${normalizedValue}" is missing its model identifier.`
    )
  }

  if (LOCAL_PROVIDERS.has(provider)) {
    const localModelPath = resolveLocalModelPath(options.llmDirPath, model)

    return {
      provider,
      model: localModelPath,
      label: `${provider}/${getLocalModelLabel(localModelPath)}`,
      isLocal: true
    }
  }

  return {
    provider,
    model,
    label: `${provider}/${model}`,
    isLocal: false
  }
}

export function getInstalledLLMMetadata(
  llmManifestPath: string
): {
  defaultInstalledLLMPath: string
  installedLLMName: string
  installedLLMVersion: string
} {
  const llmManifest = readLLMManifest(llmManifestPath)

  return {
    defaultInstalledLLMPath:
      typeof llmManifest?.defaultInstalledLLMPath === 'string'
        ? llmManifest.defaultInstalledLLMPath
        : '',
    installedLLMName: llmManifest?.name || 'Local LLM',
    installedLLMVersion: llmManifest?.version || 'unknown'
  }
}

export function getActiveLLMTarget(
  routingMode: string,
  workflowTarget: ResolvedLLMTarget,
  agentTarget: ResolvedLLMTarget
): ResolvedLLMTarget {
  return routingMode === 'agent' ? agentTarget : workflowTarget
}

export function getRoutingModeLLMDisplay(
  routingMode: string,
  workflowTarget: ResolvedLLMTarget,
  agentTarget: ResolvedLLMTarget
): RoutingModeLLMDisplay {
  if (routingMode === 'smart') {
    return {
      heading: 'LLMs',
      value: `workflow=${workflowTarget.label}, agent=${agentTarget.label}`
    }
  }

  return {
    heading: 'LLM',
    value: getActiveLLMTarget(routingMode, workflowTarget, agentTarget).label
  }
}
