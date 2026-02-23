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
  TOOL_EXECUTOR
} from '@/core'
import { LLMDuties, LLMProviders } from '@/core/llm-manager/types'
import { LLM_PROVIDER as LLM_PROVIDER_NAME } from '@/constants'

type ReactLLMDutyParams = LLMDutyParams

const SYSTEM_PROMPT = `You are an autonomous reasoning and acting agent. Your goal is to solve the user's request.

You may choose a toolkit, then choose a tool, then choose a function, or provide a final answer. Tools are not executed yet, so if you choose a function you will receive an observation and must continue.

Select a toolkit to see its tools. Select a tool to see its functions. You can select different toolkits/tools later if needed.

tool_input must be a JSON string.

Return ONLY one of the following JSON shapes:
- {"type":"toolkit","toolkit_id":"..."}
- {"type":"tool","tool_id":"..."}
- {"type":"function","function_name":"...","tool_input":"{...}"}
- {"type":"final","answer":"..."}

Do not output schema keywords like "oneOf", "properties", or "required".
No other keys, no null values.`
const MAX_STEPS = 4
const REACT_MAX_TOKENS = 256
const REACT_TEMPERATURE = 0.2
const MAX_INVALID_INPUTS = 2
const TOOL_DISABLED_OBSERVATION =
  'Tool execution is not available yet. Provide the best possible final answer without using tools.'
const FINAL_FALLBACK_RESPONSE =
  'I cannot use tools right now, but I can still help. Tell me what outcome you want and any constraints, and I will do my best.'

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

          const toolkitsSection = TOOLKIT_REGISTRY.toolkits.length
            ? `Available Toolkits:\n${TOOLKIT_REGISTRY.toolkits
                .map((toolkit) => `- ${toolkit.name} (${toolkit.id})`)
                .join('\n')}`
            : 'Available Toolkits: none'

          const toolkitPrompts = TOOLKIT_REGISTRY.toolkits.map((toolkit) => {
            const toolsList = toolkit.tools
              ? Object.values(toolkit.tools)
                  .map(
                    (tool) =>
                      `  - ${tool.tool_id}: ${tool.name} — ${tool.description}`
                  )
                  .join('\n')
              : ''
            const toolsSection = toolsList
              ? `Available Tools (Selected Toolkit):\n${toolsList}`
              : 'Available Tools (Selected Toolkit): none'

            const toolFunctions = toolkit.tools
              ? Object.values(toolkit.tools).flatMap((tool) =>
                  Object.entries(tool.functions || {}).map(
                    ([functionName, config]) =>
                      `  - ${functionName}: ${
                        config.description
                      } ${JSON.stringify(config.parameters)}`
                  )
                )
              : []
            const functionsSection = toolFunctions.length
              ? `Available Functions (Selected Tool):\n${toolFunctions.join(
                  '\n'
                )}`
              : 'Available Functions (Selected Tool): none'

            return `${toolkitsSection}\n\nSelected Toolkit: ${
              toolkit.id
            }\n\n${toolsSection}\n\nSelected Tool: ${
              toolkit.tools ? Object.keys(toolkit.tools)[0] || 'none' : 'none'
            }\n\n${functionsSection}\n\nPrevious Steps: none\n\nUser Request: ""`
          })

          const longestPrompt = toolkitPrompts.length
            ? toolkitPrompts.reduce((longest, prompt) =>
                prompt.length > longest.length ? prompt : longest
              )
            : `${toolkitsSection}\n\nSelected Toolkit: none\n\nAvailable Tools (Selected Toolkit): none\n\nSelected Tool: none\n\nAvailable Functions (Selected Tool): none\n\nPrevious Steps: none\n\nUser Request: ""`

          const promptTokens = LLM_MANAGER.model.tokenize(
            `${this.systemPrompt}\n${longestPrompt}`
          ).length
          const contextSize = promptTokens + REACT_MAX_TOKENS + 256

          ReActLLMDuty.context = await LLM_MANAGER.model.createContext({
            contextSize
          })

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

      for (let stepIndex = 0; stepIndex < MAX_STEPS; stepIndex += 1) {
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

        const prompt = `${toolkitsSection}\n\n${selectedToolkitSection}\n\n${toolsSection}\n\n${selectedToolSection}\n\n${functionsSection}\n\n${stepsSection}\n\nUser Request: "${this.input}"`
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
          temperature: REACT_TEMPERATURE,
          maxTokens: REACT_MAX_TOKENS
        }
        let completionResult

        if (LLM_PROVIDER_NAME === LLMProviders.Local) {
          completionResult = await LLM_PROVIDER.prompt(prompt, {
            ...completionParams,
            session: ReActLLMDuty.session
          })
        } else {
          completionResult = await LLM_PROVIDER.prompt(prompt, completionParams)
        }

        const rawOutput = completionResult?.output
        let parsedOutput: {
          type?: string
          toolkit_id?: string
          tool_id?: string
          function_name?: string
          tool_input?: string
          answer?: string
        } | null = null

        if (typeof rawOutput === 'string') {
          try {
            parsedOutput = JSON.parse(rawOutput)
          } catch {
            parsedOutput = null
          }
        } else if (rawOutput && typeof rawOutput === 'object') {
          parsedOutput = rawOutput as typeof parsedOutput
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
          if (!selectedToolkitId) {
            steps.push({
              action: `tool:${toolId || 'unknown_tool'}`,
              observation: 'Select a toolkit before choosing a tool.'
            })
            continue
          }

          const resolvedTool = TOOLKIT_REGISTRY.resolveToolById(
            toolId,
            selectedToolkitId
          )
          if (!resolvedTool) {
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
          const toolInput = parsedOutput?.tool_input || ''

          if (!functionName) {
            steps.push({
              action: 'function:missing_name',
              observation: 'function_name is required when type=function.'
            })
            continue
          }

          if (!selectedToolkitId || !selectedToolId) {
            steps.push({
              action: `function:${functionName || 'unknown_function'}`,
              observation:
                'Select a toolkit and tool before choosing a function.'
            })
            continue
          }

          const toolFunctions = TOOLKIT_REGISTRY.getToolFunctions(
            selectedToolkitId,
            selectedToolId
          )
          const functionConfig = toolFunctions?.[functionName]
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
            functionName,
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

          const toolExecutionResult =
            await TOOL_EXECUTOR.executeTool(toolExecutionInput)
          const toolLabel =
            toolExecutionResult.toolLabel || selectedToolId || 'unknown_tool'
          const observation = JSON.stringify({
            status: toolExecutionResult.status,
            message: toolExecutionResult.message,
            data: toolExecutionResult.data
          })

          steps.push({
            action: `function:${toolLabel}.${functionName}${
              toolInputToUse ? `(${toolInputToUse})` : ''
            }`,
            observation
          })
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
    const commandKey = '"command"'
    const commandIndex = toolInput.indexOf(commandKey)
    if (commandIndex === -1) {
      return null
    }

    const colonIndex = toolInput.indexOf(':', commandIndex)
    if (colonIndex === -1) {
      return null
    }

    const firstQuoteIndex = toolInput.indexOf('"', colonIndex + 1)
    if (firstQuoteIndex === -1) {
      return null
    }

    const lastQuoteIndex = toolInput.lastIndexOf('"')
    if (lastQuoteIndex <= firstQuoteIndex) {
      return null
    }

    const commandValue = toolInput.slice(firstQuoteIndex + 1, lastQuoteIndex)
    const escapedCommand = commandValue.replace(/"/g, '\\"')
    const repaired =
      toolInput.slice(0, firstQuoteIndex + 1) +
      escapedCommand +
      toolInput.slice(lastQuoteIndex)

    try {
      const value = JSON.parse(repaired)
      return { repaired, value }
    } catch {
      return null
    }
  }
}
