import fs from 'node:fs'
import path from 'node:path'

import { TOOLKITS_PATH } from '@/constants'
import { LogHelper } from '@/helpers/log-helper'

interface ToolkitToolDefinition {
  tool_id: string
  toolkit_id: string
  name: string
  description: string
  binaries?: Record<string, string>
  resources?: Record<string, string[]>
  functions: Record<
    string,
    {
      description: string
      parameters: Record<string, unknown>
      output_schema?: Record<string, unknown>
    }
  >
}

interface FlattenedToolkitTool {
  toolkitId: string
  toolkitName: string
  toolkitDescription: string
  toolId: string
  toolName: string
  toolDescription: string
}

interface ResolvedToolkitTool {
  toolkitId: string
  toolkitName: string
  toolId: string
  toolName: string
  toolDescription: string
}

interface ToolkitDefinition {
  id: string
  name: string
  description: string
  contextFiles?: string[]
  tools?: Record<string, ToolkitToolDefinition>
}

export default class ToolkitRegistry {
  private static instance: ToolkitRegistry
  private _toolkits: ToolkitDefinition[] = []
  private _isLoaded = false

  constructor() {
    if (!ToolkitRegistry.instance) {
      LogHelper.title('Toolkit Registry')
      LogHelper.success('New instance')

      ToolkitRegistry.instance = this
    }
  }

  public get toolkits(): ToolkitDefinition[] {
    return this._toolkits
  }

  public get isLoaded(): boolean {
    return this._isLoaded
  }

  public getFlattenedTools(): FlattenedToolkitTool[] {
    const flattened: FlattenedToolkitTool[] = []

    for (const toolkit of this._toolkits) {
      if (!toolkit.tools) {
        continue
      }

      for (const [toolId, tool] of Object.entries(toolkit.tools)) {
        flattened.push({
          toolkitId: toolkit.id,
          toolkitName: toolkit.name,
          toolkitDescription: toolkit.description,
          toolId,
          toolName: tool.name,
          toolDescription: tool.description
        })
      }
    }

    return flattened
  }

  public resolveToolById(
    toolId: string,
    toolkitId?: string
  ): ResolvedToolkitTool | null {
    if (!toolId) {
      return null
    }

    const normalizedToolId = toolId.trim()
    if (!normalizedToolId) {
      return null
    }

    if (toolkitId) {
      const toolkit = this._toolkits.find((item) => item.id === toolkitId)
      const tool = toolkit?.tools?.[normalizedToolId]

      if (!tool || !toolkit) {
        return null
      }

      return {
        toolkitId: toolkit.id,
        toolkitName: toolkit.name,
        toolId: normalizedToolId,
        toolName: tool.name,
        toolDescription: tool.description
      }
    }

    const toolkitAndToolId = normalizedToolId.split('.')
    const hasToolkitPrefix = toolkitAndToolId.length === 2

    if (hasToolkitPrefix) {
      const [toolkitIdFromTool, toolKey] = toolkitAndToolId
      if (!toolkitIdFromTool || !toolKey) {
        return null
      }
      const toolkit = this._toolkits.find(
        (item) => item.id === toolkitIdFromTool
      )
      const tool = toolkit?.tools?.[toolKey]

      if (!tool || !toolkit) {
        return null
      }

      return {
        toolkitId: toolkit.id,
        toolkitName: toolkit.name,
        toolId: toolKey,
        toolName: tool.name,
        toolDescription: tool.description
      }
    }

    const matches: ResolvedToolkitTool[] = []
    for (const toolkit of this._toolkits) {
      if (!toolkit.tools) {
        continue
      }

      const tool = toolkit.tools[normalizedToolId]
      if (tool) {
        matches.push({
          toolkitId: toolkit.id,
          toolkitName: toolkit.name,
          toolId: normalizedToolId,
          toolName: tool.name,
          toolDescription: tool.description
        })
      }
    }

    if (matches.length === 1) {
      return matches[0] || null
    }

    return null
  }

  public getToolFunctions(
    toolkitId: string,
    toolId: string
  ): ToolkitToolDefinition['functions'] | null {
    const toolkit = this._toolkits.find((item) => item.id === toolkitId)
    const tool = toolkit?.tools?.[toolId]
    if (!tool) {
      return null
    }

    return tool.functions || null
  }

  public getToolkitContextFiles(toolkitId: string): string[] {
    const toolkit = this._toolkits.find((item) => item.id === toolkitId)
    return toolkit?.contextFiles || []
  }

  public async load(): Promise<void> {
    if (this._isLoaded) {
      return
    }

    try {
      const entries = await fs.promises.readdir(TOOLKITS_PATH, {
        withFileTypes: true
      })

      const toolkits: ToolkitDefinition[] = []

      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue
        }

        const toolkitId = entry.name
        const toolkitPath = path.join(TOOLKITS_PATH, toolkitId)
        const toolkitConfigPath = path.join(toolkitPath, 'toolkit.json')

        if (!fs.existsSync(toolkitConfigPath)) {
          continue
        }

        try {
          const toolkitConfigRaw = await fs.promises.readFile(
            toolkitConfigPath,
            'utf-8'
          )
          const toolkitConfig = JSON.parse(toolkitConfigRaw) as {
            name: string
            description: string
            context_files?: string[]
            tools?: string[]
          }

          if (!toolkitConfig.tools || toolkitConfig.tools.length === 0) {
            continue
          }

          const contextFiles = Array.isArray(toolkitConfig.context_files)
            ? [
                ...new Set(
                  toolkitConfig.context_files
                    .map((contextFile) =>
                      this.normalizeContextFilename(contextFile)
                    )
                    .filter((contextFile): contextFile is string =>
                      Boolean(contextFile)
                    )
                )
              ]
            : []

          const toolkitTools: Record<string, ToolkitToolDefinition> = {}
          for (const toolId of toolkitConfig.tools) {
            const toolConfigPath = path.join(
              TOOLKITS_PATH,
              toolkitId,
              'tools',
              `${toolId}.tool.json`
            )
            if (!fs.existsSync(toolConfigPath)) {
              continue
            }

            try {
              const toolConfigRaw = await fs.promises.readFile(
                toolConfigPath,
                'utf-8'
              )
              const toolConfig = JSON.parse(
                toolConfigRaw
              ) as ToolkitToolDefinition
              toolkitTools[toolId] = toolConfig
            } catch (e) {
              LogHelper.title('Toolkit Registry')
              LogHelper.error(
                `Failed to load tool config at "${toolConfigPath}": ${e}`
              )
            }
          }

          toolkits.push({
            id: toolkitId,
            name: toolkitConfig.name,
            description: toolkitConfig.description,
            contextFiles,
            tools: toolkitTools
          })
        } catch (e) {
          LogHelper.title('Toolkit Registry')
          LogHelper.error(
            `Failed to load toolkit config at "${toolkitConfigPath}": ${e}`
          )
        }
      }

      this._toolkits = toolkits
      this._isLoaded = true

      LogHelper.title('Toolkit Registry')
      LogHelper.success(`Loaded ${toolkits.length} toolkits`)
    } catch (e) {
      LogHelper.title('Toolkit Registry')
      LogHelper.error(`Failed to load toolkits: ${e}`)
    }
  }

  private normalizeContextFilename(filename: string): string | null {
    if (typeof filename !== 'string') {
      return null
    }

    const trimmedFilename = filename.trim()
    if (!trimmedFilename) {
      return null
    }

    const normalizedBasename = path
      .basename(trimmedFilename, '.md')
      .toUpperCase()
    if (!normalizedBasename) {
      return null
    }

    return `${normalizedBasename}.md`
  }
}
