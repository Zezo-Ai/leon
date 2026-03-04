import type { Static } from '@sinclair/typebox'
import { Type } from '@sinclair/typebox'

export const toolkitSchemaObject = Type.Strict(
  Type.Object({
    $schema: Type.String({ minLength: 1 }),
    name: Type.String({ minLength: 1 }),
    description: Type.String({ minLength: 8, maxLength: 256 }),
    icon_name: Type.String({ minLength: 1 }),
    context_files: Type.Array(
      Type.String({
        minLength: 1,
        pattern: '^[A-Z0-9_]+\\.md$'
      })
    ),
    tools: Type.Array(Type.String({ minLength: 1 }))
  })
)

export type ToolkitSchema = Static<typeof toolkitSchemaObject>
