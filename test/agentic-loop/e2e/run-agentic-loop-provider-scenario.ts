import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import type { AgenticProvider } from './provider-matrix'
import { PROVIDER_REQUIRED_ENV } from './provider-matrix'

const RESULT_PREFIX = '__AGENTIC_LOOP_RESULT__'
const PROGRESS_PREFIX = '__AGENTIC_LOOP_PROGRESS__'
const REACT_CONTINUATION_STATE_FILENAME =
  '.react-execution-continuation-state.json'
const REACT_HISTORY_COMPACTION_STATE_FILENAME =
  '.react-history-compaction-state.json'

interface AgenticProgressEvent {
  provider: AgenticProvider
  stage:
    | 'bootstrap'
    | 'turn_start'
    | 'tool_call'
    | 'turn_result'
    | 'scenario_complete'
  turn?: number
  message: string
  data?: Record<string, unknown>
}

interface AgenticTurnResult {
  input: string
  output: string
  finalIntent: string | null
  executionHistory: Array<{
    function: string
    status: string
    observation: string
    stepLabel?: string
    requestedToolInput?: string
  }>
  toolCalls: Array<{
    toolkitId?: string
    toolId: string
    functionName?: string
    toolInput?: string
    parsedInput?: Record<string, unknown>
    toolOutput?: string
  }>
}

interface AgenticRunnerResult {
  provider: AgenticProvider
  skipped: boolean
  reason?: string
  assetPath?: string
  turns?: AgenticTurnResult[]
}

function printResult(result: AgenticRunnerResult): void {
  /**
   * A fixed marker makes it easy for the parent Vitest process to extract the
   * structured result from mixed stdout/stderr.
   */
  console.log(`${RESULT_PREFIX}${JSON.stringify(result)}`)
}

function printProgress(event: AgenticProgressEvent): void {
  console.log(`${PROGRESS_PREFIX}${JSON.stringify(event)}`)
}

function serializeToolOutput(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function summarizeValue(value: string, maxLength = 220): string {
  if (value.length <= maxLength) {
    return value
  }

  return `${value.slice(0, maxLength)}...`
}

async function main(): Promise<void> {
  const providerArg = process.argv[2] as AgenticProvider | undefined
  if (!providerArg || !(providerArg in PROVIDER_REQUIRED_ENV)) {
    printResult({
      provider: (providerArg || 'openai') as AgenticProvider,
      skipped: true,
      reason: 'invalid_provider'
    })
    return
  }

  const provider = providerArg
  const requiredEnv = PROVIDER_REQUIRED_ENV[provider]
  if (!process.env[requiredEnv]) {
    printResult({
      provider,
      skipped: true,
      reason: `missing_${requiredEnv.toLowerCase()}`
    })
    return
  }

  process.env['LEON_NODE_ENV'] = 'testing'
  process.env['LEON_LLM_PROVIDER'] = provider
  process.env['LEON_WORKFLOW_LLM_PROVIDER'] = provider
  process.env['LEON_AGENT_LLM_PROVIDER'] = provider

  const tempAssetPath = path.join(
    os.tmpdir(),
    `leon-agentic-loop-${provider}-${Date.now()}.txt`
  )

  const {
    ReActLLMDuty
  } = await import('../../../server/src/core/llm-manager/llm-duties/react-llm-duty.ts')
  const { CONVERSATION_LOGGER, TOOL_EXECUTOR, LLM_PROVIDER } = await import(
    '../../../server/src/core/index.ts'
  )
  const { CONTEXT_PATH } = await import('../../../server/src/constants.ts')

  const continuationStatePath = path.join(
    CONTEXT_PATH,
    REACT_CONTINUATION_STATE_FILENAME
  )
  const historyCompactionStatePath = path.join(
    CONTEXT_PATH,
    REACT_HISTORY_COMPACTION_STATE_FILENAME
  )

  await fs.writeFile(
    tempAssetPath,
    'Hey Leon, please list the files on your project root.\n',
    'utf8'
  )

  const turns: string[] = [
    // Return final answer directly
    'Hi Leon, just doing a quick check since I switched your LLM provider. What do you reply if I tell you "ping"?',
    // Create simple plan
    'What\'s the weather like today in Shenzhen?',
    // Create plan with dynamic replanning (inject new step)
    `There is a file waiting for you in ${tempAssetPath}, do what it asks you to do.`
  ]

  const turnResults: AgenticTurnResult[] = []
  const toolCalls: AgenticTurnResult['toolCalls'] = []
  const originalExecuteTool = TOOL_EXECUTOR.executeTool.bind(TOOL_EXECUTOR)

  /**
   * Wrap tool execution so the parent spec can assert on real tool usage
   * without changing the production ReAct path.
   */
  TOOL_EXECUTOR.executeTool = async (input): Promise<unknown> => {
    const toolResult = await originalExecuteTool(input)
    const toolName = `${input.toolkitId}.${input.toolId}.${input.functionName || 'unknown'}`
    const serializedInput = input.toolInput || ''
    const serializedOutput = serializeToolOutput(toolResult)

    printProgress({
      provider,
      stage: 'tool_call',
      message: `Executed ${toolName}`,
      data: {
        toolName,
        toolInput: summarizeValue(serializedInput),
        toolOutput: summarizeValue(serializedOutput)
      }
    })

    toolCalls.push({
      toolkitId: input.toolkitId,
      toolId: input.toolId,
      functionName: input.functionName,
      toolInput: input.toolInput,
      parsedInput:
        input.parsedInput && typeof input.parsedInput === 'object'
          ? { ...input.parsedInput }
          : undefined,
      toolOutput: serializeToolOutput(toolResult)
    })

    return toolResult
  }

  try {
    /**
     * The e2e subprocess bypasses the normal server bootstrap, so initialize
     * the selected provider explicitly before the first ReAct turn.
     */
    await LLM_PROVIDER.init()
    printProgress({
      provider,
      stage: 'bootstrap',
      message: `Initialized provider ${provider}`,
      data: {
        assetPath: tempAssetPath
      }
    })
    await CONVERSATION_LOGGER.clear()
    await fs.rm(continuationStatePath, { force: true })
    await fs.rm(historyCompactionStatePath, { force: true })

    let recordedToolCalls = 0
    for (const [index, input] of turns.entries()) {
      const turnNumber = index + 1

      printProgress({
        provider,
        stage: 'turn_start',
        turn: turnNumber,
        message: `Starting turn ${turnNumber}`,
        data: {
          input
        }
      })

      /**
       * Push each owner/Leon turn through the shared conversation logger so the
       * next ReAct invocation sees real multi-turn history.
       */
      await CONVERSATION_LOGGER.push({
        who: 'owner',
        message: input
      })

      const duty = new ReActLLMDuty({ input })
      await duty.init({ force: index === 0 })
      const result = await duty.execute()

      const output =
        result && typeof result.output === 'string' ? result.output : ''
      if (output) {
        await CONVERSATION_LOGGER.push({
          who: 'leon',
          message: output
        })
      }

      printProgress({
        provider,
        stage: 'turn_result',
        turn: turnNumber,
        message: `Completed turn ${turnNumber}`,
        data: {
          finalIntent:
            result &&
            result.data &&
            typeof result.data === 'object' &&
            'finalIntent' in result.data &&
            typeof result.data['finalIntent'] === 'string'
              ? result.data['finalIntent']
              : null,
          output: summarizeValue(output),
          toolCalls: toolCalls.length - recordedToolCalls
        }
      })

      turnResults.push({
        input,
        output,
        finalIntent:
          result &&
          result.data &&
          typeof result.data === 'object' &&
          'finalIntent' in result.data &&
          typeof result.data['finalIntent'] === 'string'
            ? result.data['finalIntent']
            : null,
        executionHistory:
          result &&
          result.data &&
          typeof result.data === 'object' &&
          Array.isArray(result.data['executionHistory'])
            ? (result.data['executionHistory'] as AgenticTurnResult['executionHistory'])
            : [],
        toolCalls: toolCalls.slice(recordedToolCalls)
      })

      recordedToolCalls = toolCalls.length
    }

    printResult({
      provider,
      skipped: false,
      assetPath: tempAssetPath,
      turns: turnResults
    })
    printProgress({
      provider,
      stage: 'scenario_complete',
      message: `Completed ${turnResults.length} turns`,
      data: {
        turns: turnResults.length
      }
    })
  } finally {
    TOOL_EXECUTOR.executeTool = originalExecuteTool
    await CONVERSATION_LOGGER.clear()
    await fs.rm(tempAssetPath, { force: true })
    await fs.rm(continuationStatePath, { force: true })
    await fs.rm(historyCompactionStatePath, { force: true })
  }
}

void main()
  .then(() => {
    /**
     * Core singletons keep background handles open, so exit explicitly once the
     * structured result has been printed and cleanup has finished.
     */
    process.exit(0)
  })
  .catch((error) => {
    printResult({
      provider: (process.argv[2] || 'openai') as AgenticProvider,
      skipped: false,
      reason: String(error)
    })
    process.exit(1)
  })
