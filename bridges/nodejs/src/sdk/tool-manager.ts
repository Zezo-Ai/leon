import { formatFilePath } from '@sdk/utils'
import { Tool } from '@sdk/base-tool'
import { reportToolOutput } from '@sdk/tool-reporter'

export class MissingToolSettingsError extends Error {
  missing: string[]
  settingsPath: string

  constructor(missing: string[], settingsPath: string) {
    super(`Missing tool settings: ${missing.join(', ')}`)
    this.name = 'MissingToolSettingsError'
    this.missing = missing
    this.settingsPath = settingsPath
  }
}

export const isMissingToolSettingsError = (
  error: unknown
): error is MissingToolSettingsError => {
  return error instanceof MissingToolSettingsError
}

export default class ToolManager {
  static async initTool<TTool extends Tool>(
    ToolClass: new () => TTool
  ): Promise<TTool> {
    const tool = new ToolClass()
    const missing = tool.getMissingSettings()

    if (missing) {
      try {
        await reportToolOutput({
          key: 'bridges.tools.missing_settings',
          data: {
            tool_name: tool.aliasToolName,
            missing: missing.missing.join(', '),
            settings_path: formatFilePath(missing.settingsPath)
          },
          core: {
            should_stop_skill: true
          }
        })
      } catch (error) {
        console.warn(
          `[LEON_TOOL_LOG] Failed to report missing tool settings: ${
            (error as Error).message
          }`
        )
      }
      throw new MissingToolSettingsError(missing.missing, missing.settingsPath)
    }

    return tool
  }
}
