/**
 * Tool runtime for executing Node.js tools.
 * This runtime exists only for Node.js because the core server is built on Node.js
 * and the ReAct loop only needs a single bridge for now.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

interface ToolRuntimeCliInput {
  toolkitId: string
  toolId: string
  functionName: string
  args: unknown[]
}

const parseArgs = (): ToolRuntimeCliInput => {
  const args = process.argv.slice(2)
  const getValue = (flag: string): string => {
    const index = args.indexOf(flag)
    if (index === -1 || index === args.length - 1) {
      return ''
    }
    return args[index + 1] || ''
  }

  const toolkitId = getValue('--toolkit')
  const toolId = getValue('--tool')
  const functionName = getValue('--function')
  const rawArgs = getValue('--args')
  const rawArgsBase64 = getValue('--args-base64')

  if (!toolkitId || !toolId || !functionName) {
    throw new Error('Missing required arguments: --toolkit, --tool, --function')
  }

  let parsedArgs: unknown[] = []
  if (rawArgsBase64) {
    const decodedJson = Buffer.from(rawArgsBase64, 'base64').toString('utf8')
    const decoded = JSON.parse(decodedJson)
    if (Array.isArray(decoded)) {
      parsedArgs = decoded
    } else if (decoded && typeof decoded === 'object') {
      parsedArgs = Object.values(decoded)
    }
  } else if (rawArgs) {
    const decoded = JSON.parse(rawArgs)
    if (Array.isArray(decoded)) {
      parsedArgs = decoded
    } else if (decoded && typeof decoded === 'object') {
      parsedArgs = Object.values(decoded)
    }
  }

  return {
    toolkitId,
    toolId,
    functionName,
    args: parsedArgs
  }
}

const resolveToolModulePath = async (
  toolId: string
): Promise<string | null> => {
  const runtimeDir = path.dirname(fileURLToPath(import.meta.url))
  const toolsRoot = path.join(runtimeDir, 'sdk', 'tools')
  if (!fs.existsSync(toolsRoot)) {
    return null
  }

  const directPath = path.join(toolsRoot, toolId, 'index.ts')
  if (fs.existsSync(directPath)) {
    return directPath
  }

  const normalizedToolId = normalizeName(toolId)
  const entries = await fs.promises.readdir(toolsRoot, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (normalizeName(entry.name) === normalizedToolId) {
      const candidate = path.join(toolsRoot, entry.name, 'index.ts')
      if (fs.existsSync(candidate)) {
        return candidate
      }
    }
  }

  return null
}

const normalizeName = (value: string): string => {
  return value.replace(/[^a-z0-9]/gi, '').toLowerCase()
}

const setProjectCwd = (): void => {
  const runtimeDir = path.dirname(fileURLToPath(import.meta.url))
  const projectRoot = path.join(runtimeDir, '..', '..', '..')
  if (process.cwd() !== projectRoot) {
    process.chdir(projectRoot)
  }
}

const run = async (): Promise<void> => {
  try {
    setProjectCwd()
    const input = parseArgs()
    const toolModulePath = await resolveToolModulePath(input.toolId)
    if (!toolModulePath) {
      throw new Error(`Tool module not found for ${input.toolId}.`)
    }

    const { Tool } = await import('@sdk/base-tool')
    const toolModule = await import(pathToFileURL(toolModulePath).href)
    const ToolClass = toolModule?.default
    if (!ToolClass) {
      throw new Error(`Tool ${input.toolId} has no default export.`)
    }

    const toolInstance = new ToolClass() as InstanceType<typeof Tool>
    const missing = toolInstance.getMissingSettings()
    if (missing) {
      process.stdout.write(
        JSON.stringify({
          success: false,
          message: `Missing tool settings: ${missing.missing.join(', ')}`,
          output: {
            missing_settings: missing.missing,
            settings_path: missing.settingsPath
          }
        })
      )
      process.exitCode = 1
      return
    }
    const method = (toolInstance as unknown as Record<string, unknown>)?.[
      input.functionName
    ]
    if (typeof method !== 'function') {
      throw new Error(
        `Function ${input.functionName} not found on ${input.toolId}.`
      )
    }

    const result = await method.apply(toolInstance, input.args)
    process.stdout.write(
      JSON.stringify({
        success: true,
        message: 'Tool executed successfully.',
        output: { result }
      })
    )
  } catch (error) {
    const message = (error as Error).message || 'Unknown tool runtime error.'
    process.stdout.write(
      JSON.stringify({
        success: false,
        message,
        output: {}
      })
    )
    process.exitCode = 1
  }
}

void run()
