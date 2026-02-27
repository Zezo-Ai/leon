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
        // Include required parameter names so the model can reason about
        // data flow between steps (e.g. search returns a URL -> download needs a URL)
        const params = fnConfig.parameters
        const paramNames: string[] = []
        if (params && typeof params === 'object') {
          const properties = (params as Record<string, unknown>)['properties']
          if (properties && typeof properties === 'object') {
            paramNames.push(...Object.keys(properties as Record<string, unknown>))
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
