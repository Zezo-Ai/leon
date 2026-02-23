import type { LlamaContext } from 'node-llama-cpp'
import { LlamaChatSession } from 'node-llama-cpp'

import {
  DEFAULT_INIT_PARAMS,
  LLMDuty,
  type LLMDutyInitParams,
  type LLMDutyParams,
  type LLMDutyResult
} from '@/core/llm-manager/llm-duty'
import { LogHelper } from '@/helpers/log-helper'
import {
  LLM_MANAGER,
  LLM_PROVIDER,
  PERSONA,
  TOOLKIT_REGISTRY,
  TOOL_EXECUTOR,
  CONVERSATION_LOGGER,
  BRAIN
} from '@/core'
import { LLMDuties, LLMProviders } from '@/core/llm-manager/types'
import { LLM_PROVIDER as LLM_PROVIDER_NAME } from '@/constants'

type ReactLLMDutyParams = LLMDutyParams

const formatFilePath = (filePath: string): string => {
  return `[FILE_PATH]${filePath}[/FILE_PATH]`
}

const SYSTEM_PROMPT = `You are an autonomous reasoning and acting agent. Your goal is to solve the user's request.

You may choose a toolkit, then choose a tool, then choose a function, or provide a final answer. Tools ARE executed, and after a function call you will receive an observation with the tool result. Use observations to decide the next step.

When chaining tools, reuse fields from the latest observation to fill the next tool_input whenever possible.
If the latest observation includes tool output data, prefer to copy exact values into the next tool_input rather than paraphrasing.

Select a toolkit to see its tools. Select a tool to see its functions. You can select different toolkits/tools later if needed.

Only use toolkits, tools, and functions that are listed. If unsure, select a toolkit or tool to see the available options.

After a successful tool result, decide the next tool or finish. Do not repeat the same tool selection.

Prefer dedicated toolkits/tools over operating_system_control. Use operating_system_control and bash only as a last resort when no suitable tool exists.

tool_input must be a JSON string.

Return ONLY one of the following JSON shapes:
- {"type":"toolkit","toolkit_id":"..."}
- {"type":"tool","tool_id":"..."}
- {"type":"function","function_name":"...","tool_input":"{...}"}
- {"type":"final","answer":"..."}

If the final answer includes a file path, wrap it as [FILE_PATH]/path[/FILE_PATH].

Do not output schema keywords like "oneOf", "properties", or "required".
No other keys, no null values.`
const MAX_STEPS = 26
const REACT_TEMPERATURE = 0.2
const MAX_INVALID_INPUTS = 4
const REACT_LOCAL_PROVIDER_HISTORY_LOGS = 8
const REACT_REMOTE_PROVIDER_HISTORY_LOGS = 16
const TOOL_DISABLED_OBSERVATION =
  'No valid action received. Choose a toolkit, tool, function, or provide a final answer.'
const FINAL_FALLBACK_RESPONSE =
  'I need a clear toolkit/tool/function selection or a final answer to proceed.'

const PROGRESS_SYSTEM_PROMPT =
  'Write one short, friendly progress update in present continuous ("-ing"). One sentence, under 32 words. Mention why, the tool/function, and key input (path or command). Do not use markdown. If you mention a local path, wrap it as [FILE_PATH]PATH[/FILE_PATH]. No quotes, no JSON.'

export class ReActLLMDuty extends LLMDuty {
  private static instance: ReActLLMDuty
  private static context: LlamaContext = null as unknown as LlamaContext
  private static session: LlamaChatSession = null as unknown as LlamaChatSession
  protected systemPrompt: LLMDutyParams['systemPrompt'] = null
  protected readonly name = 'ReAct LLM Duty'
  protected input: LLMDutyParams['input'] = null

  constructor(params: ReactLLMDutyParams) {
    super()

    if (!ReActLLMDuty.instance) {
      LogHelper.title(this.name)
      LogHelper.success('New instance')

      ReActLLMDuty.instance = this
    }

    this.input = params.input
    this.systemPrompt = PERSONA.getCompactDutySystemPrompt(SYSTEM_PROMPT)
  }

  public async init(
    params: LLMDutyInitParams = DEFAULT_INIT_PARAMS
  ): Promise<void> {
    if (!TOOLKIT_REGISTRY.isLoaded) {
      await TOOLKIT_REGISTRY.load()
    }

    if (LLM_PROVIDER_NAME === LLMProviders.Local) {
      if (!ReActLLMDuty.session || params.force) {
        LogHelper.title(this.name)
        LogHelper.info('Initializing...')

        try {
          if (params.force) {
            if (ReActLLMDuty.context) {
              await ReActLLMDuty.context.dispose()
            }
            if (ReActLLMDuty.session) {
              ReActLLMDuty.session.dispose({ disposeSequence: true })
              LogHelper.info('Session disposed')
            }
          }

          ReActLLMDuty.context = await LLM_MANAGER.model.createContext()

          ReActLLMDuty.session = new LlamaChatSession({
            contextSequence: ReActLLMDuty.context.getSequence(),
            autoDisposeSequence: true,
            systemPrompt: this.systemPrompt as string
          })

          LogHelper.success('Initialized')
        } catch (e) {
          LogHelper.title(this.name)
          LogHelper.error(`Failed to initialize: ${e}`)
        }
      }
    }
  }

  public async execute(): Promise<LLMDutyResult | null> {
    LogHelper.title(this.name)
    LogHelper.info('Executing...')

    try {
      const historyForRemoteProvider =
        LLM_PROVIDER_NAME !== LLMProviders.Local
          ? await CONVERSATION_LOGGER.load({
              nbOfLogsToLoad:
                LLM_PROVIDER_NAME === LLMProviders.Local
                  ? REACT_LOCAL_PROVIDER_HISTORY_LOGS
                  : REACT_REMOTE_PROVIDER_HISTORY_LOGS
            })
          : null
      const flattenedTools = TOOLKIT_REGISTRY.getFlattenedTools()
      const toolkitsMap = new Map<
        string,
        {
          name: string
          description: string
          tools: { id: string; name: string; description: string }[]
        }
      >()
      const steps: { action: string; observation?: string }[] = []

      flattenedTools.forEach((tool) => {
        if (!toolkitsMap.has(tool.toolkitId)) {
          toolkitsMap.set(tool.toolkitId, {
            name: tool.toolkitName,
            description: tool.toolkitDescription,
            tools: []
          })
        }

        toolkitsMap.get(tool.toolkitId)?.tools.push({
          id: tool.toolId,
          name: tool.toolName,
          description: tool.toolDescription
        })
      })

      const toolkitsList = Array.from(toolkitsMap.entries())
        .map(
          ([toolkitId, toolkit]) =>
            `- ${toolkit.name} (${toolkitId}): ${toolkit.description}`
        )
        .join('\n')

      let selectedToolkitId: string | null = null
      let selectedToolId: string | null = null
      let invalidResponseCount = 0
      let invalidInputCount = 0
      let maxSteps = MAX_STEPS
      let lastSuccessfulToolId: string | null = null
      const emitProgress = async (message: string): Promise<void> => {
        if (!message) {
          return
        }
        await BRAIN.talk(message)
      }

      const emitToolProgress = async (
        toolId: string,
        functionName: string,
        toolInput: string
      ): Promise<void> => {
        const prompt = `Tool: ${toolId}\nFunction: ${functionName}\nInput: ${toolInput}\nWhy: ${this.input}`
        try {
          const progressParams =
            LLM_PROVIDER_NAME === LLMProviders.Local
              ? {
                  dutyType: LLMDuties.Custom,
                  systemPrompt: PROGRESS_SYSTEM_PROMPT,
                  temperature: 0.6,
                  maxTokens: 64,
                  session: ReActLLMDuty.session
                }
              : {
                  dutyType: LLMDuties.Custom,
                  systemPrompt: PROGRESS_SYSTEM_PROMPT,
                  temperature: 0.6,
                  maxTokens: 64
                }
          const completion = await LLM_PROVIDER.prompt(prompt, progressParams)
          const message =
            typeof completion?.output === 'string'
              ? completion.output
              : String(completion?.output || '')
          await emitProgress(message.trim())
        } catch {
          await emitProgress(`Using ${toolId} to ${functionName}...`)
        }
      }

      for (let stepIndex = 0; stepIndex < maxSteps; stepIndex += 1) {
        const stepsSection = steps.length
          ? `Previous Steps:\n${steps
              .map((step, index) => {
                const observation = step.observation
                  ? `\n  Observation: ${step.observation}`
                  : ''
                return `Step ${index + 1}: ${step.action}${observation}`
              })
              .join('\n')}`
          : 'Previous Steps: none'

        const selectedToolkitSection = selectedToolkitId
          ? `Selected Toolkit: ${selectedToolkitId}`
          : 'Selected Toolkit: none'
        const selectedToolSection = selectedToolId
          ? `Selected Tool: ${selectedToolId}`
          : 'Selected Tool: none'

        const selectedToolkitTools = selectedToolkitId
          ? toolkitsMap.get(selectedToolkitId)?.tools || []
          : []
        const toolsList = selectedToolkitId
          ? selectedToolkitTools
              .map(
                (tool) => `  - ${tool.id}: ${tool.name} — ${tool.description}`
              )
              .join('\n')
          : ''

        const toolsSection = selectedToolkitId
          ? `Available Tools (Selected Toolkit):\n${toolsList}`
          : 'Available Tools (Selected Toolkit): none'

        const selectedToolFunctions =
          selectedToolkitId && selectedToolId
            ? TOOLKIT_REGISTRY.getToolFunctions(
                selectedToolkitId,
                selectedToolId
              )
            : null
        const functionsList = selectedToolFunctions
          ? Object.entries(selectedToolFunctions)
              .map(([functionName, config]) => {
                const inputs = JSON.stringify(config.parameters)
                return `  - ${functionName}: ${config.description} ${inputs}`
              })
              .join('\n')
          : ''
        const functionsSection = selectedToolFunctions
          ? `Available Functions (Selected Tool):\n${functionsList}`
          : 'Available Functions (Selected Tool): none'

        const toolkitsSection = toolkitsList
          ? `Available Toolkits:\n${toolkitsList}`
          : 'Available Toolkits: none'

        const latestObservation = steps.length
          ? steps[steps.length - 1]?.observation
          : null
        const latestObservationSection = latestObservation
          ? `Latest Observation:\n${latestObservation}`
          : 'Latest Observation: none'
        const prompt = `${toolkitsSection}\n\n${selectedToolkitSection}\n\n${toolsSection}\n\n${selectedToolSection}\n\n${functionsSection}\n\n${stepsSection}\n\n${latestObservationSection}\n\nUser Request: "${this.input}"`
        const responseSchema = {
          oneOf: [
            {
              type: 'object',
              properties: {
                type: { type: 'string', enum: ['toolkit'] },
                toolkit_id: { type: 'string' }
              },
              required: ['type', 'toolkit_id'],
              additionalProperties: false
            },
            {
              type: 'object',
              properties: {
                type: { type: 'string', enum: ['tool'] },
                tool_id: { type: 'string' }
              },
              required: ['type', 'tool_id'],
              additionalProperties: false
            },
            {
              type: 'object',
              properties: {
                type: { type: 'string', enum: ['function'] },
                function_name: { type: 'string' },
                tool_input: { type: 'string' }
              },
              required: ['type', 'function_name', 'tool_input'],
              additionalProperties: false
            },
            {
              type: 'object',
              properties: {
                type: { type: 'string', enum: ['final'] },
                answer: { type: 'string' }
              },
              required: ['type', 'answer'],
              additionalProperties: false
            }
          ]
        }
        const completionParams = {
          dutyType: LLMDuties.ReAct,
          systemPrompt: this.systemPrompt as string,
          data: responseSchema,
          temperature: REACT_TEMPERATURE
        }
        let completionResult

        if (LLM_PROVIDER_NAME === LLMProviders.Local) {
          completionResult = await LLM_PROVIDER.prompt(prompt, {
            ...completionParams,
            session: ReActLLMDuty.session
          })
        } else {
          const completionParamsWithHistory = historyForRemoteProvider
            ? { ...completionParams, history: historyForRemoteProvider }
            : completionParams
          completionResult = await LLM_PROVIDER.prompt(
            prompt,
            completionParamsWithHistory
          )
        }

        const rawOutput = completionResult?.output
        if (LLM_PROVIDER_NAME !== LLMProviders.Local) {
          LogHelper.title(this.name)
          LogHelper.debug(`Step ${stepIndex + 1} prompt — ${prompt}`)
          LogHelper.debug(
            `Step ${stepIndex + 1} output — ${JSON.stringify(rawOutput)}`
          )
        }
        let parsedOutput: {
          type?: string
          toolkit_id?: string
          tool_id?: string
          function_name?: string
          tool_input?: string
          answer?: string
        } | null = null

        if (rawOutput && typeof rawOutput === 'object') {
          parsedOutput = rawOutput as typeof parsedOutput
        } else if (typeof rawOutput === 'string') {
          const parsed = this.parseModelOutput(rawOutput)
          if (parsed?.parsedOutput) {
            parsedOutput = parsed.parsedOutput
          }
          if (parsed?.preamble) {
            await emitProgress(parsed.preamble)
          }
        }

        if (parsedOutput?.type === 'final' && parsedOutput?.answer) {
          if (completionResult) {
            completionResult.output = parsedOutput.answer
          }

          LogHelper.title(this.name)
          LogHelper.success('Duty executed')
          LogHelper.success(`Prompt — ${prompt}`)
          LogHelper.success(`Output — ${JSON.stringify(
            completionResult?.output
          )}
usedInputTokens: ${completionResult?.usedInputTokens}
usedOutputTokens: ${completionResult?.usedOutputTokens}`)

          return completionResult as unknown as LLMDutyResult
        }

        const parsedOutputRecord = parsedOutput as Record<
          string,
          unknown
        > | null
        const responseValidation =
          this.validateResponseShape(parsedOutputRecord)
        if (!responseValidation.isValid && typeof rawOutput === 'string') {
          const lastObservation = steps[steps.length - 1]?.observation
          if (lastObservation) {
            try {
              const parsedObservation = JSON.parse(lastObservation) as {
                status?: string
              }
              if (parsedObservation?.status === 'success') {
                return {
                  dutyType: LLMDuties.ReAct,
                  systemPrompt: this.systemPrompt,
                  input: this.input,
                  output: rawOutput,
                  data: {}
                } as unknown as LLMDutyResult
              }
            } catch {
              // ignore
            }
          }
        }
        if (!responseValidation.isValid) {
          invalidResponseCount += 1
          if (invalidResponseCount >= 2) {
            return {
              dutyType: LLMDuties.ReAct,
              systemPrompt: this.systemPrompt,
              input: this.input,
              output: responseValidation.message || FINAL_FALLBACK_RESPONSE,
              data: {}
            } as unknown as LLMDutyResult
          }

          steps.push({
            action: 'invalid_response',
            observation:
              responseValidation.message ||
              'Return a JSON object with type=toolkit|tool|function|final and required fields.'
          })
          continue
        }

        if (parsedOutput?.type === 'toolkit') {
          const toolkitId = parsedOutput?.toolkit_id || ''
          if (!toolkitId) {
            steps.push({
              action: 'toolkit:missing_id',
              observation: 'toolkit_id is required when type=toolkit.'
            })
            continue
          }
          const hasToolkit = TOOLKIT_REGISTRY.toolkits.some(
            (toolkit) => toolkit.id === toolkitId
          )
          if (hasToolkit) {
            selectedToolkitId = toolkitId
            selectedToolId = null
            steps.push({
              action: `toolkit:${toolkitId}`
            })
          } else {
            steps.push({
              action: `toolkit:${toolkitId || 'unknown_toolkit'}`,
              observation: 'Unknown toolkit_id. Choose an existing toolkit.'
            })
          }
          continue
        }

        if (parsedOutput?.type === 'tool') {
          const toolId = parsedOutput?.tool_id || ''
          if (!toolId) {
            steps.push({
              action: 'tool:missing_id',
              observation: 'tool_id is required when type=tool.'
            })
            continue
          }
          if (lastSuccessfulToolId && toolId === lastSuccessfulToolId) {
            selectedToolId = null
            steps.push({
              action: `tool:${toolId}`,
              observation:
                'Tool already succeeded. Choose the next tool or function.'
            })
            continue
          }
          if (selectedToolId && toolId === selectedToolId) {
            const toolFunctions = TOOLKIT_REGISTRY.getToolFunctions(
              selectedToolkitId || '',
              selectedToolId
            )
            const availableFunctions = toolFunctions
              ? Object.keys(toolFunctions).join(', ')
              : ''
            steps.push({
              action: `tool:${toolId}`,
              observation: availableFunctions
                ? `Tool already selected. Choose a function next. Available functions: ${availableFunctions}.`
                : 'Tool already selected. Choose a function next.'
            })
            continue
          }
          if (selectedToolkitId && toolId === selectedToolkitId) {
            selectedToolId = null
            steps.push({
              action: `toolkit:${selectedToolkitId}`,
              observation:
                'Interpreted tool_id as a toolkit_id. Choose a tool next.'
            })
            const toolkitTools: {
              id: string
              name: string
              description: string
            }[] = toolkitsMap.get(selectedToolkitId)?.tools || []
            if (toolkitTools.length === 1) {
              selectedToolId = toolkitTools[0]?.id || null
              if (selectedToolId) {
                steps.push({
                  action: `tool:${selectedToolId}`,
                  observation:
                    'Auto-selected the only available tool in this toolkit.'
                })
              }
            }
            continue
          }
          const toolIdParts = toolId.split('/')
          if (toolIdParts.length === 2 && toolIdParts[0] && toolIdParts[1]) {
            selectedToolkitId = toolIdParts[0]
            selectedToolId = toolIdParts[1]
          }
          if (!selectedToolkitId) {
            const toolkitMatch = TOOLKIT_REGISTRY.toolkits.find(
              (toolkit) => toolkit.id === toolId
            )
            if (toolkitMatch) {
              selectedToolkitId = toolkitMatch.id
              selectedToolId = null
              steps.push({
                action: `toolkit:${toolkitMatch.id}`,
                observation:
                  'Interpreted tool_id as a toolkit_id. Choose a tool next.'
              })
              continue
            }

            const resolvedTool = TOOLKIT_REGISTRY.resolveToolById(toolId)
            if (resolvedTool) {
              selectedToolkitId = resolvedTool.toolkitId
              selectedToolId = resolvedTool.toolId
              steps.push({
                action: `tool:${resolvedTool.toolId}`
              })
              continue
            }

            steps.push({
              action: `tool:${toolId || 'unknown_tool'}`,
              observation: 'Select a toolkit before choosing a tool.'
            })
            continue
          }

          const resolvedTool = TOOLKIT_REGISTRY.resolveToolById(
            selectedToolId || toolId,
            selectedToolkitId
          )
          if (!resolvedTool) {
            const resolvedAnyToolkit = TOOLKIT_REGISTRY.resolveToolById(
              selectedToolId || toolId
            )
            if (resolvedAnyToolkit) {
              selectedToolkitId = resolvedAnyToolkit.toolkitId
              selectedToolId = resolvedAnyToolkit.toolId
              steps.push({
                action: `tool:${resolvedAnyToolkit.toolId}`,
                observation: 'Switched toolkit to match the requested tool_id.'
              })
              continue
            }
            steps.push({
              action: `tool:${toolId || 'unknown_tool'}`,
              observation: 'Unknown tool_id for selected toolkit.'
            })
            continue
          }

          selectedToolId = resolvedTool.toolId
          steps.push({
            action: `tool:${resolvedTool.toolId}`
          })
          continue
        }

        if (parsedOutput?.type === 'function') {
          const functionName = parsedOutput?.function_name || ''
          const normalizedFunctionName =
            functionName.split(/[./]/).filter(Boolean).pop() || ''
          const toolInput = parsedOutput?.tool_input || ''

          if (!functionName) {
            steps.push({
              action: 'function:missing_name',
              observation: 'function_name is required when type=function.'
            })
            continue
          }

          if (!selectedToolId && functionName.includes('.')) {
            const parts = functionName.split(/[./]/).filter(Boolean)
            const candidates = parts.slice(0, -1).reverse()
            let resolvedFromFunction = null as null | {
              toolkitId: string
              toolId: string
            }
            for (const candidate of candidates) {
              const resolvedTool = selectedToolkitId
                ? TOOLKIT_REGISTRY.resolveToolById(candidate, selectedToolkitId)
                : TOOLKIT_REGISTRY.resolveToolById(candidate)
              if (resolvedTool) {
                resolvedFromFunction = resolvedTool
                break
              }
            }
            if (resolvedFromFunction) {
              selectedToolkitId = resolvedFromFunction.toolkitId
              selectedToolId = resolvedFromFunction.toolId
              steps.push({
                action: `tool:${resolvedFromFunction.toolId}`,
                observation:
                  'Interpreted function_name as a tool_id. Choose a function next.'
              })
              continue
            }
          }

          if (normalizedFunctionName && !selectedToolId) {
            const resolvedTool = selectedToolkitId
              ? TOOLKIT_REGISTRY.resolveToolById(
                  normalizedFunctionName,
                  selectedToolkitId
                )
              : TOOLKIT_REGISTRY.resolveToolById(normalizedFunctionName)
            if (resolvedTool) {
              selectedToolkitId = resolvedTool.toolkitId
              selectedToolId = resolvedTool.toolId
              steps.push({
                action: `tool:${resolvedTool.toolId}`,
                observation:
                  'Interpreted function_name as a tool_id. Choose a function next.'
              })
              continue
            }
          }

          if (selectedToolId && normalizedFunctionName === selectedToolId) {
            steps.push({
              action: `tool:${selectedToolId}`,
              observation:
                'Interpreted function_name as a tool_id. Choose a function next.'
            })
            continue
          }

          if (!selectedToolkitId || !selectedToolId) {
            const toolkitTools = selectedToolkitId
              ? toolkitsMap.get(selectedToolkitId)?.tools || []
              : []
            const toolsHint = toolkitTools.length
              ? ` Available tools: ${toolkitTools
                  .map((tool) => tool.id)
                  .join(', ')}.`
              : ''
            steps.push({
              action: `function:${functionName || 'unknown_function'}`,
              observation: `Select a toolkit and tool before choosing a function.${toolsHint}`
            })
            continue
          }

          const toolFunctions = TOOLKIT_REGISTRY.getToolFunctions(
            selectedToolkitId,
            selectedToolId
          )
          const functionConfig = toolFunctions?.[normalizedFunctionName]
          if (!functionConfig) {
            const availableFunctions = toolFunctions
              ? Object.keys(toolFunctions).join(', ')
              : ''
            steps.push({
              action: `function:${functionName || 'unknown_function'}`,
              observation: availableFunctions
                ? `Unknown function_name for selected tool. Available functions: ${availableFunctions}.`
                : 'Unknown function_name for selected tool.'
            })
            continue
          }
          const inputValidation = this.validateToolInput(
            toolInput,
            functionConfig?.parameters || null
          )

          if (!inputValidation.isValid) {
            invalidInputCount += 1
            if (invalidInputCount >= MAX_INVALID_INPUTS) {
              return {
                dutyType: LLMDuties.ReAct,
                systemPrompt: this.systemPrompt,
                input: this.input,
                output:
                  'I need a bit more detail to proceed. Please provide the missing fields for this function input.',
                data: {}
              } as unknown as LLMDutyResult
            }

            steps.push({
              action: `function:${functionName || 'unknown_function'}`,
              observation:
                inputValidation.message ||
                'Invalid tool_input. Provide JSON matching the function parameters.'
            })
            continue
          }

          const toolInputToUse = inputValidation.repairedToolInput ?? toolInput

          const toolExecutionInput = {
            toolId: selectedToolId,
            toolkitId: selectedToolkitId,
            functionName: normalizedFunctionName,
            toolInput: toolInputToUse
          } as {
            toolId: string
            toolkitId: string
            functionName: string
            toolInput: string
            parsedInput?: Record<string, unknown>
          }

          if (inputValidation.parsedValue) {
            toolExecutionInput.parsedInput = inputValidation.parsedValue
          }

          await emitToolProgress(
            selectedToolId || 'tool',
            normalizedFunctionName,
            toolInputToUse
          )
          const toolExecutionResult =
            await TOOL_EXECUTOR.executeTool(toolExecutionInput)
          if (toolExecutionResult.status === 'success') {
            lastSuccessfulToolId = selectedToolId
          }
          const missingSettings =
            toolExecutionResult.status === 'error'
              ? (toolExecutionResult.data.output?.['missing_settings'] as
                  | string[]
                  | undefined)
              : undefined
          const settingsPath =
            toolExecutionResult.status === 'error'
              ? (toolExecutionResult.data.output?.['settings_path'] as
                  | string
                  | undefined)
              : undefined
          if (missingSettings && missingSettings.length > 0 && settingsPath) {
            const formattedPath = formatFilePath(settingsPath)
            return {
              dutyType: LLMDuties.ReAct,
              systemPrompt: this.systemPrompt,
              input: this.input,
              output: `Missing tool settings: ${missingSettings.join(
                ', '
              )}. Please set them in ${formattedPath}.`,
              data: {}
            } as unknown as LLMDutyResult
          }
          if (toolExecutionResult.status === 'invalid_input') {
            invalidInputCount += 1
            if (invalidInputCount >= MAX_INVALID_INPUTS) {
              return {
                dutyType: LLMDuties.ReAct,
                systemPrompt: this.systemPrompt,
                input: this.input,
                output:
                  'I need a bit more detail to proceed. Please provide the missing fields for this function input.',
                data: {}
              } as unknown as LLMDutyResult
            }
          }
          const toolLabel =
            toolExecutionResult.toolLabel || selectedToolId || 'unknown_tool'
          const observationPayload: Record<string, unknown> = {
            status: toolExecutionResult.status,
            message: toolExecutionResult.message,
            data: toolExecutionResult.data
          }
          if (toolExecutionResult.status === 'invalid_input') {
            observationPayload['repair_hint'] =
              toolExecutionResult.message ||
              'Fix tool_input using required fields and correct order.'
          }
          const observation = JSON.stringify(observationPayload)

          steps.push({
            action: `function:${toolLabel}.${functionName}${
              toolInputToUse ? `(${toolInputToUse})` : ''
            }`,
            observation
          })
          if (stepIndex >= maxSteps - 1) {
            maxSteps += 1
          }
          continue
        }

        steps.push({
          action: 'final',
          observation: TOOL_DISABLED_OBSERVATION
        })
      }

      const completionResult = {
        output: FINAL_FALLBACK_RESPONSE,
        dutyType: LLMDuties.ReAct,
        systemPrompt: this.systemPrompt as string,
        input: this.input
      } as unknown as LLMDutyResult

      LogHelper.title(this.name)
      LogHelper.success('Duty executed')
      LogHelper.success(`Output — ${JSON.stringify(completionResult?.output)}`)

      return completionResult
    } catch (e) {
      LogHelper.title(this.name)
      LogHelper.error(`Failed to execute: ${e}`)
    }

    return null
  }

  private validateResponseShape(output: Record<string, unknown> | null): {
    isValid: boolean
    message?: string
  } {
    if (!output || typeof output !== 'object') {
      return {
        isValid: false,
        message:
          'Return a JSON object with type=toolkit|tool|function|final and required fields.'
      }
    }

    if (
      output['oneOf'] !== undefined ||
      output['properties'] !== undefined ||
      output['required'] !== undefined
    ) {
      return {
        isValid: false,
        message: 'Do not output schema keywords like oneOf/properties/required.'
      }
    }

    const type = output['type']
    if (typeof type !== 'string') {
      return {
        isValid: false,
        message: 'Field "type" must be one of: toolkit, tool, function, final.'
      }
    }

    const keys = Object.keys(output)
    if (type === 'toolkit') {
      if (!output['toolkit_id']) {
        return {
          isValid: false,
          message: 'toolkit_id is required when type=toolkit.'
        }
      }
      if (keys.some((key) => !['type', 'toolkit_id'].includes(key))) {
        return {
          isValid: false,
          message: 'Only type and toolkit_id are allowed for type=toolkit.'
        }
      }
      return { isValid: true }
    }

    if (type === 'tool') {
      if (!output['tool_id']) {
        return {
          isValid: false,
          message: 'tool_id is required when type=tool.'
        }
      }
      if (keys.some((key) => !['type', 'tool_id'].includes(key))) {
        return {
          isValid: false,
          message: 'Only type and tool_id are allowed for type=tool.'
        }
      }
      return { isValid: true }
    }

    if (type === 'function') {
      if (!output['function_name'] || !output['tool_input']) {
        return {
          isValid: false,
          message:
            'function_name and tool_input are required when type=function.'
        }
      }
      if (
        keys.some(
          (key) => !['type', 'function_name', 'tool_input'].includes(key)
        )
      ) {
        return {
          isValid: false,
          message:
            'Only type, function_name, and tool_input are allowed for type=function.'
        }
      }
      return { isValid: true }
    }

    if (type === 'final') {
      if (!output['answer']) {
        return {
          isValid: false,
          message: 'answer is required when type=final.'
        }
      }
      if (keys.some((key) => !['type', 'answer'].includes(key))) {
        return {
          isValid: false,
          message: 'Only type and answer are allowed for type=final.'
        }
      }
      return { isValid: true }
    }

    return {
      isValid: false,
      message: 'Field "type" must be one of: toolkit, tool, function, final.'
    }
  }

  private validateToolInput(
    toolInput: string,
    parameters: Record<string, unknown> | null
  ): {
    isValid: boolean
    message?: string
    repairedToolInput?: string
    parsedValue?: Record<string, unknown>
  } {
    if (!parameters) {
      return {
        isValid: false,
        message: 'No parameters schema found for this function.'
      }
    }

    let parsed: unknown = null
    let parsedFromRepair: { repaired: string; value: unknown } | null = null
    try {
      parsed = JSON.parse(toolInput)
    } catch {
      parsedFromRepair = this.tryRepairToolInput(toolInput)
      if (!parsedFromRepair) {
        return {
          isValid: false,
          message: 'tool_input must be valid JSON.'
        }
      }
      parsed = parsedFromRepair.value
    }

    const validateSchema = (
      schema: Record<string, unknown>,
      value: unknown
    ): boolean => {
      if (schema['oneOf'] && Array.isArray(schema['oneOf'])) {
        return schema['oneOf'].some((candidate) => {
          if (candidate && typeof candidate === 'object') {
            return validateSchema(candidate as Record<string, unknown>, value)
          }
          return false
        })
      }

      const schemaType = schema['type']
      if (schemaType === 'object') {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          return false
        }

        const required = Array.isArray(schema['required'])
          ? (schema['required'] as string[])
          : []
        for (const key of required) {
          if (!(key in (value as Record<string, unknown>))) {
            return false
          }
        }

        const properties = schema['properties']
        if (properties && typeof properties === 'object') {
          for (const [key, propSchema] of Object.entries(properties)) {
            if (
              key in (value as Record<string, unknown>) &&
              propSchema &&
              typeof propSchema === 'object'
            ) {
              const propValue = (value as Record<string, unknown>)[key]
              if (
                !validateSchema(
                  propSchema as Record<string, unknown>,
                  propValue
                )
              ) {
                return false
              }
            }
          }
        }

        return true
      }

      if (schemaType === 'array') {
        if (!Array.isArray(value)) {
          return false
        }
        const items = schema['items']
        if (items && typeof items === 'object') {
          return value.every((item) =>
            validateSchema(items as Record<string, unknown>, item)
          )
        }
        return true
      }

      if (schemaType === 'string') {
        return typeof value === 'string'
      }
      if (schemaType === 'number') {
        return typeof value === 'number' && Number.isFinite(value)
      }
      if (schemaType === 'boolean') {
        return typeof value === 'boolean'
      }

      return true
    }

    const isValid = validateSchema(parameters, parsed)
    if (!isValid) {
      return {
        isValid: false,
        message: 'tool_input does not match the function parameters schema.'
      }
    }

    const result: {
      isValid: boolean
      repairedToolInput?: string
      parsedValue?: Record<string, unknown>
    } = {
      isValid: true
    }
    if (parsedFromRepair?.repaired) {
      result.repairedToolInput = parsedFromRepair.repaired
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      result.parsedValue = parsed as Record<string, unknown>
    }
    return result
  }

  private tryRepairToolInput(
    toolInput: string
  ): { repaired: string; value: unknown } | null {
    const repaired = this.repairJsonStringLiterals(toolInput)
    if (repaired === toolInput) {
      return null
    }

    try {
      const value = JSON.parse(repaired)
      return { repaired, value }
    } catch {
      return null
    }
  }

  private repairJsonStringLiterals(input: string): string {
    let inString = false
    let escaped = false
    let result = ''

    const isValidEscape = (char: string): boolean => {
      return (
        char === '"' ||
        char === '\\' ||
        char === '/' ||
        char === 'b' ||
        char === 'f' ||
        char === 'n' ||
        char === 'r' ||
        char === 't' ||
        char === 'u'
      )
    }

    const nextNonSpace = (value: string, start: number): string => {
      for (let i = start; i < value.length; i += 1) {
        const char = value[i]
        if (char && !/\s/.test(char)) {
          return char
        }
      }
      return ''
    }

    for (let i = 0; i < input.length; i += 1) {
      const char = input[i]

      if (!inString) {
        if (char === '"') {
          inString = true
        }
        result += char
        continue
      }

      if (escaped) {
        result += char
        escaped = false
        continue
      }

      if (char === '\\') {
        const nextChar = input[i + 1]
        if (nextChar && isValidEscape(nextChar)) {
          result += char
          escaped = true
          continue
        }
        result += '\\\\'
        continue
      }

      if (char === '"') {
        const nextChar = nextNonSpace(input, i + 1)
        const isTerminator =
          nextChar === '' ||
          nextChar === ',' ||
          nextChar === '}' ||
          nextChar === ']' ||
          nextChar === ':'
        if (isTerminator) {
          inString = false
          result += char
          continue
        }
        result += '\\"'
        continue
      }

      result += char
    }

    return result
  }

  private parseModelOutput(rawOutput: string): {
    parsedOutput: {
      type?: string
      toolkit_id?: string
      tool_id?: string
      function_name?: string
      tool_input?: string
      answer?: string
    } | null
    preamble?: string
  } | null {
    const trimmed = rawOutput.trim()
    if (!trimmed) {
      return null
    }

    const taggedJson = this.extractTaggedJson(trimmed)
    if (taggedJson) {
      try {
        return { parsedOutput: JSON.parse(taggedJson) }
      } catch {
        // Continue
      }
    }

    try {
      return { parsedOutput: JSON.parse(trimmed) }
    } catch {
      // Continue
    }

    const toolCall = this.parseToolCallFromText(trimmed)
    if (toolCall) {
      const functionName = toolCall.functionName
        ? `${toolCall.toolId}.${toolCall.functionName}`
        : toolCall.toolId
      const parsedOutput = toolCall.functionName
        ? {
            type: 'function',
            function_name: functionName,
            tool_input: JSON.stringify(toolCall.args || {})
          }
        : { type: 'tool', tool_id: toolCall.toolId }
      return toolCall.preamble
        ? { parsedOutput, preamble: toolCall.preamble }
        : { parsedOutput }
    }

    const extractedJson = this.extractJsonSubstring(trimmed)
    if (!extractedJson) {
      return null
    }

    try {
      const parsed = JSON.parse(extractedJson) as
        | {
            type?: string
            toolkit_id?: string
            tool_id?: string
            function_name?: string
            tool_input?: string
            answer?: string
          }
        | unknown[]
      if (Array.isArray(parsed)) {
        const [first] = parsed
        if (first && typeof first === 'object') {
          return { parsedOutput: first as Record<string, unknown> }
        }
        return null
      }
      return { parsedOutput: parsed }
    } catch {
      return null
    }
  }

  private extractTaggedJson(input: string): string | null {
    const tagMatch = input.match(/\[(TOOL|TOOLKIT|FUNCTION|FINAL)\]/i)
    if (!tagMatch || tagMatch.index === undefined) {
      return null
    }

    const startIndex = tagMatch.index + tagMatch[0].length
    const rest = input.slice(startIndex).trim()
    const json = this.extractJsonSubstring(rest)
    return json
  }

  private parseToolCallFromText(input: string): {
    toolId: string
    functionName?: string
    args?: Record<string, string>
    preamble?: string
  } | null {
    const toolCallMatch = input.match(/\[TOOL_CALL\]([\s\S]*?)\[\/TOOL_CALL\]/i)
    if (!toolCallMatch) {
      return null
    }

    const toolCallBody = toolCallMatch[1] || ''
    const toolMatch = toolCallBody.match(/tool\s*=>\s*"([^"]+)"/i)
    const toolId = toolMatch?.[1]
    if (!toolId) {
      return null
    }

    const functionMatch = toolCallBody.match(/function\s*=>\s*"([^"]+)"/i)
    const args = this.parseToolCallArgs(toolCallBody)
    const preamble = input.slice(0, toolCallMatch.index || 0).trim()

    const toolCallResult: {
      toolId: string
      functionName?: string
      args?: Record<string, string>
      preamble?: string
    } = {
      toolId,
      args
    }

    if (functionMatch?.[1]) {
      toolCallResult.functionName = functionMatch[1]
    }

    if (preamble) {
      toolCallResult.preamble = preamble
    }

    return toolCallResult
  }

  private parseToolCallArgs(input: string): Record<string, string> {
    const args: Record<string, string> = {}
    const argPattern = /--([a-zA-Z0-9_-]+)\s+(?:"([^"]*)"|'([^']*)')/g
    let match: RegExpExecArray | null
    while ((match = argPattern.exec(input)) !== null) {
      const key = match[1]
      const value = match[2] ?? match[3] ?? ''
      if (!key) {
        continue
      }
      args[key] = value
    }
    return args
  }

  private extractJsonSubstring(input: string): string | null {
    const firstBrace = input.indexOf('{')
    const firstBracket = input.indexOf('[')
    let startIndex = -1
    let endIndex = -1

    if (firstBrace !== -1 && firstBracket !== -1) {
      startIndex = Math.min(firstBrace, firstBracket)
    } else {
      startIndex = Math.max(firstBrace, firstBracket)
    }

    if (startIndex === -1) {
      return null
    }

    if (input[startIndex] === '{') {
      endIndex = input.lastIndexOf('}')
    } else {
      endIndex = input.lastIndexOf(']')
    }

    if (endIndex <= startIndex) {
      return null
    }

    return input.slice(startIndex, endIndex + 1)
  }
}
