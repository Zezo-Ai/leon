import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { LogHelper } from '@/helpers/log-helper'
import {
  NODEJS_BRIDGE_TOOL_RUNTIME_DIST_PATH,
  NODEJS_BRIDGE_TOOL_RUNTIME_SRC_PATH,
  NODEJS_BRIDGE_ROOT_PATH,
  TSX_CLI_PATH
} from '@/constants'
import { TOOLKIT_REGISTRY } from '@/core'

const execFileAsync = promisify(execFile)

interface ToolExecutionInput {
  toolId: string
  toolkitId?: string
  functionName?: string
  toolInput?: string
  parsedInput?: Record<string, unknown>
}

interface ToolExecutionResult {
  status: 'success' | 'error' | 'not_available' | 'invalid_input'
  message: string
  data: {
    tool_id: string
    toolkit_id: string | null
    function_name: string | null
    input: string | null
    parsed_input: Record<string, unknown> | null
    output: Record<string, unknown>
  }
  toolLabel?: string | undefined
}

export default class ToolExecutor {
  private static instance: ToolExecutor

  constructor() {
    if (!ToolExecutor.instance) {
      LogHelper.title('Tool Executor')
      LogHelper.success('New instance')

      ToolExecutor.instance = this
    }
  }

  public async executeTool(
    input: ToolExecutionInput
  ): Promise<ToolExecutionResult> {
    const { toolId, toolkitId, functionName } = input
    const resolvedTool = TOOLKIT_REGISTRY.resolveToolById(toolId, toolkitId)

    if (!resolvedTool) {
      return this.buildResult({
        status: 'invalid_input',
        message: toolkitId
          ? 'Unknown tool_id for selected toolkit.'
          : 'Unknown or ambiguous tool_id. Select a toolkit first.',
        input: input.toolInput ?? null,
        resolvedTool: null
      })
    }

    if (!functionName) {
      return this.buildResult({
        status: 'invalid_input',
        message: 'Missing function_name for selected tool.',
        input: input.toolInput ?? null,
        resolvedTool,
        functionName: null
      })
    }

    const functions = TOOLKIT_REGISTRY.getToolFunctions(
      resolvedTool.toolkitId,
      resolvedTool.toolId
    )
    if (!functions || !functions[functionName]) {
      return this.buildResult({
        status: 'invalid_input',
        message: `Unknown function_name "${functionName}" for selected tool.`,
        input: input.toolInput ?? null,
        resolvedTool,
        functionName
      })
    }

    const parsedInput =
      input.parsedInput || this.parseToolInput(input.toolInput)
    if (!parsedInput) {
      return this.buildResult({
        status: 'invalid_input',
        message: 'tool_input must be valid JSON.',
        input: input.toolInput ?? null,
        resolvedTool,
        functionName,
        parsedInput: null
      })
    }

    const argsArray = this.mapArgs(
      parsedInput,
      functions?.[functionName]?.parameters
    )
    const runtimeResult = await this.runToolRuntime({
      toolkitId: resolvedTool.toolkitId,
      toolId: resolvedTool.toolId,
      functionName,
      args: argsArray
    })

    return this.buildResult({
      status: runtimeResult.success ? 'success' : 'error',
      message: runtimeResult.message,
      input: input.toolInput ?? null,
      resolvedTool,
      functionName,
      parsedInput,
      output: runtimeResult.output
    })
  }

  private buildResult(params: {
    status: ToolExecutionResult['status']
    message: string
    input: string | null
    resolvedTool: { toolkitId: string; toolId: string } | null
    functionName?: string | null
    parsedInput?: Record<string, unknown> | null
    output?: Record<string, unknown>
  }): ToolExecutionResult {
    const result: ToolExecutionResult = {
      status: params.status,
      message: params.message,
      data: {
        tool_id: params.resolvedTool?.toolId || '',
        toolkit_id: params.resolvedTool?.toolkitId || null,
        function_name: params.functionName ?? null,
        input: params.input,
        parsed_input: params.parsedInput ?? null,
        output: params.output ?? {}
      }
    }

    if (params.resolvedTool) {
      result.toolLabel = `${params.resolvedTool.toolkitId}.${params.resolvedTool.toolId}`
    }

    return result
  }

  private parseToolInput(toolInput?: string): Record<string, unknown> | null {
    if (!toolInput) {
      return null
    }

    try {
      const parsed = JSON.parse(toolInput)
      if (parsed && typeof parsed === 'object') {
        return parsed as Record<string, unknown>
      }
    } catch {
      return null
    }

    return null
  }

  private mapArgs(
    argsObject: Record<string, unknown>,
    parameters?: Record<string, unknown>
  ): unknown[] {
    const properties =
      parameters &&
      typeof parameters === 'object' &&
      parameters['properties'] &&
      typeof parameters['properties'] === 'object'
        ? (parameters['properties'] as Record<string, unknown>)
        : null

    if (!properties) {
      return Object.values(argsObject)
    }

    return Object.keys(properties).map((key) => argsObject[key])
  }

  private async runToolRuntime(params: {
    toolkitId: string
    toolId: string
    functionName: string
    args: unknown[]
  }): Promise<{
    success: boolean
    message: string
    output: Record<string, unknown>
  }> {
    const toolRuntimePath = fs.existsSync(NODEJS_BRIDGE_TOOL_RUNTIME_DIST_PATH)
      ? NODEJS_BRIDGE_TOOL_RUNTIME_DIST_PATH
      : NODEJS_BRIDGE_TOOL_RUNTIME_SRC_PATH

    const nodeArgs = fs.existsSync(NODEJS_BRIDGE_TOOL_RUNTIME_DIST_PATH)
      ? [toolRuntimePath]
      : [
          TSX_CLI_PATH,
          '--tsconfig',
          path.join(NODEJS_BRIDGE_ROOT_PATH, 'tsconfig.json'),
          toolRuntimePath
        ]

    const cliArgs = [
      ...nodeArgs,
      '--runtime',
      'tool',
      '--toolkit',
      params.toolkitId,
      '--tool',
      params.toolId,
      '--function',
      params.functionName,
      '--args-base64',
      Buffer.from(JSON.stringify(params.args)).toString('base64')
    ]

    try {
      const { stdout } = await execFileAsync(process.execPath, cliArgs, {
        cwd: NODEJS_BRIDGE_ROOT_PATH,
        maxBuffer: 1024 * 1024 * 10
      })
      const output = stdout ? stdout.toString().trim() : ''
      if (!output) {
        return {
          success: false,
          message: 'Tool runtime returned empty output.',
          output: {}
        }
      }

      const parsed = JSON.parse(output) as {
        success: boolean
        message: string
        output?: Record<string, unknown>
      }
      return {
        success: Boolean(parsed.success),
        message: parsed.message || 'Tool runtime error.',
        output: parsed.output || {}
      }
    } catch (error) {
      return {
        success: false,
        message: `Tool runtime error: ${(error as Error).message}`,
        output: {}
      }
    }
  }
}
