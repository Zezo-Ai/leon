import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { getPlatformName } from '@sdk/utils'
import { TOOLKITS_PATH } from '@bridge/constants'

interface ToolConfig {
  name?: string
  description: string
  binaries?: Record<string, string>
  resources?: Record<string, string[]>
}

interface ToolkitConfigData {
  name: string
  description: string
  tools: Record<string, ToolConfig>
}

export class ToolkitConfig {
  private static configCache = new Map<string, ToolkitConfigData>()
  private static settingsCache = new Map<string, Record<string, unknown>>()

  /**
   * Load tool configuration from bridges/toolkits directory
   * @param toolkitName - The toolkit name (e.g., 'video_streaming')
   * @param toolName - Name of the tool (e.g., 'ffmpeg')
   */
  static load(toolkitName: string, toolName: string): ToolConfig {
    const cacheKey = toolkitName

    // Load toolkit config if not cached
    if (!this.configCache.has(cacheKey)) {
      const configPath = join(TOOLKITS_PATH, toolkitName, 'toolkit.json')
      const configContent = readFileSync(configPath, 'utf-8')
      const config = JSON.parse(configContent) as ToolkitConfigData

      this.configCache.set(cacheKey, config)
    }

    const toolkitConfig = this.configCache.get(cacheKey)!
    const toolConfig = toolkitConfig.tools[toolName]

    if (!toolConfig) {
      throw new Error(
        `Tool '${toolName}' not found in toolkit '${toolkitConfig.name}'`
      )
    }

    return toolConfig
  }

  /**
   * Load tool-specific settings from toolkit settings file
   * @param toolkitName - The toolkit name (e.g., 'video_streaming')
   * @param toolName - Name of the tool (e.g., 'ffmpeg')
   * @param defaults - Default tool settings to apply when missing
   */
  static loadToolSettings(
    toolkitName: string,
    toolName: string,
    defaults: Record<string, unknown> = {}
  ): Record<string, unknown> {
    const cacheKey = `${toolkitName}:${toolName}`
    if (this.settingsCache.has(cacheKey)) {
      return this.settingsCache.get(cacheKey) || {}
    }

    const settingsDir = join(TOOLKITS_PATH, toolkitName, 'settings')
    const settingsPath = join(settingsDir, `${toolName}.json`)

    mkdirSync(settingsDir, { recursive: true })

    let toolSettings: Record<string, unknown> = {}
    let shouldWrite = false

    if (existsSync(settingsPath)) {
      const settingsContent = readFileSync(settingsPath, 'utf-8')
      toolSettings = JSON.parse(settingsContent) as Record<string, unknown>
    } else {
      shouldWrite = true
    }

    const mergedSettings = { ...defaults, ...toolSettings }

    if (!shouldWrite) {
      for (const key of Object.keys(defaults)) {
        if (!Object.prototype.hasOwnProperty.call(toolSettings, key)) {
          shouldWrite = true
          break
        }
      }
    }

    if (shouldWrite) {
      writeFileSync(settingsPath, JSON.stringify(mergedSettings, null, 2))
    }

    this.settingsCache.set(cacheKey, mergedSettings)
    return mergedSettings
  }

  /**
   * Get binary download URL for current platform with architecture granularity
   */
  static getBinaryUrl(config: ToolConfig): string | undefined {
    const platformName = getPlatformName()

    return config.binaries?.[platformName]
  }
}
