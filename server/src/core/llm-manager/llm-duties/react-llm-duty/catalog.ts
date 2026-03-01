import { TOOLKIT_REGISTRY } from '@/core'

import {
  CATALOG_TOKEN_BUDGET,
  CHARS_PER_TOKEN
} from './constants'
import type { Catalog, FunctionConfig } from './types'

export function buildCatalog(): Catalog {
  const flattenedTools = TOOLKIT_REGISTRY.getFlattenedTools()

  // First try function-level catalog
  const functionLines: string[] = []
  for (const tool of flattenedTools) {
    const toolFunctions = TOOLKIT_REGISTRY.getToolFunctions(
      tool.toolkitId,
      tool.toolId
    )
    if (toolFunctions) {
      for (const [fnName, fnConfig] of Object.entries(toolFunctions) as [string, FunctionConfig][]) {
        // Include only required parameter names to keep hints concise.
        const params = fnConfig.parameters
        const paramNames: string[] = []
        if (params && typeof params === 'object') {
          const required = (params as Record<string, unknown>)['required']
          if (Array.isArray(required)) {
            paramNames.push(
              ...required.filter(
                (value): value is string => typeof value === 'string'
              )
            )
          }
        }
        const paramHint = paramNames.length > 0
          ? ` (${paramNames.join(', ')})`
          : ''
        functionLines.push(
          `- ${tool.toolkitId}.${tool.toolId}.${fnName}${paramHint}: ${fnConfig.description}`
        )
      }
    }
  }

  const functionCatalog = functionLines.join('\n')
  const estimatedTokens = Math.ceil(
    functionCatalog.length / CHARS_PER_TOKEN
  )

  if (estimatedTokens <= CATALOG_TOKEN_BUDGET) {
    return {
      text: `Available Functions:\n${functionCatalog}`,
      mode: 'function'
    }
  }

  // Fall back to tool-level catalog
  const toolLines: string[] = []
  for (const tool of flattenedTools) {
    toolLines.push(
      `- ${tool.toolkitId}.${tool.toolId}: ${tool.toolDescription}`
    )
  }

  return {
    text: `Available Tools:\n${toolLines.join('\n')}`,
    mode: 'tool'
  }
}
