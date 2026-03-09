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

  private logToolRuntimeMessages(
    toolkitId: string,
    toolId: string,
    runtimeStderr: string
  ): void {
    if (
      toolkitId !== 'structured_knowledge' ||
      toolId !== 'memory' ||
      !runtimeStderr
    ) {
      return
    }

    const toolLogLines = runtimeStderr
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('[LEON_TOOL_LOG]'))
      .map((line) => line.replace('[LEON_TOOL_LOG]', '').trim())
      .filter(Boolean)

    for (const line of toolLogLines) {
      LogHelper.title('Memory Tool')
      LogHelper.debug(line)
    }
  }

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

    let argsArray: unknown[]
    try {
      argsArray = this.mapArgs(
        parsedInput,
        functions?.[functionName]?.parameters
      )
    } catch (error) {
      return this.buildResult({
        status: 'invalid_input',
        message: (error as Error).message,
        input: input.toolInput ?? null,
        resolvedTool,
        functionName,
        parsedInput,
        output: {}
      })
    }
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
    resolvedTool: { toolkitId: string, toolId: string } | null
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

    const requiredList = Array.isArray(parameters?.['required'])
      ? (parameters?.['required'] as string[])
      : []
    const orderedKeys = Object.keys(properties)
    const missingRequired = requiredList.filter(
      (key) => argsObject[key] === undefined
    )

    if (missingRequired.length > 0) {
      throw new Error(
        `Missing required tool_input fields: ${missingRequired.join(', ')}`
      )
    }

    if (requiredList.length > 0) {
      const lastRequiredIndex = Math.max(
        ...requiredList.map((key) => orderedKeys.indexOf(key))
      )
      const optionalBeforeRequired = orderedKeys
        .slice(0, lastRequiredIndex)
        .filter((key) => !requiredList.includes(key))

      if (optionalBeforeRequired.length > 0) {
        throw new Error(
          `Optional parameters must be trailing: ${optionalBeforeRequired.join(
            ', '
          )}`
        )
      }
    }

    const orderedArgs = orderedKeys.map((key) => argsObject[key])
    while (orderedArgs.length > 0) {
      const lastIndex = orderedArgs.length - 1
      if (orderedArgs[lastIndex] !== undefined) {
        break
      }
      orderedArgs.pop()
    }
    return orderedArgs
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
      '--args',
      JSON.stringify(params.args)
    ]

    try {
      const { stdout, stderr } = await execFileAsync(
        process.execPath,
        cliArgs,
        {
          cwd: NODEJS_BRIDGE_ROOT_PATH,
          maxBuffer: 1_024 * 1_024 * 10
        }
      )
      const output = stdout ? stdout.toString().trim() : ''
      const runtimeStderr = stderr ? stderr.toString() : ''
      this.logToolRuntimeMessages(
        params.toolkitId,
        params.toolId,
        runtimeStderr
      )
      if (!output) {
        return {
          success: false,
          message: 'Tool runtime returned empty output.',
          output: {
            runtime_stdout: stdout ? stdout.toString() : '',
            runtime_stderr: runtimeStderr
          }
        }
      }

      try {
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
      } catch (parseError) {
        return {
          success: false,
          message: `Tool runtime returned invalid JSON: ${
            (parseError as Error).message
          }`,
          output: {
            runtime_stdout: stdout ? stdout.toString() : '',
            runtime_stderr: runtimeStderr
          }
        }
      }
    } catch (error) {
      const execError = error as Error & {
        stdout?: Buffer | string
        stderr?: Buffer | string
      }
      const runtimeStdout = execError.stdout ? execError.stdout.toString() : ''
      const runtimeStderr = execError.stderr ? execError.stderr.toString() : ''
      this.logToolRuntimeMessages(
        params.toolkitId,
        params.toolId,
        runtimeStderr
      )
      if (runtimeStdout) {
        try {
          const parsed = JSON.parse(runtimeStdout) as {
            success: boolean
            message: string
            output?: Record<string, unknown>
          }
          return {
            success: Boolean(parsed.success),
            message: parsed.message || 'Tool runtime error.',
            output: {
              ...(parsed.output || {}),
              runtime_stderr: runtimeStderr
            }
          }
        } catch {
          // Fall through to stderr message
        }
      }
      const stderrMessage = runtimeStderr.trim()
      const message = stderrMessage
        ? `Tool runtime error: ${stderrMessage}`
        : `Tool runtime error: ${execError.message}`
      return {
        success: false,
        message,
        output: {
          runtime_stdout: runtimeStdout,
          runtime_stderr: runtimeStderr
        }
      }
    }
  }
}
