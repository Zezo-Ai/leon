import type { Static } from '@sinclair/typebox'
import { Type } from '@sinclair/typebox'

const toolAuthorSchemaObject = Type.Strict(
  Type.Object({
    name: Type.String({ minLength: 1 }),
    email: Type.Optional(Type.String({ minLength: 3 })),
    url: Type.Optional(Type.String({ minLength: 3 }))
  })
)

const toolFunctionSchemaObject = Type.Strict(
  Type.Object({
    description: Type.String({ minLength: 8, maxLength: 256 }),
    parameters: Type.Object({}, { additionalProperties: true }),
    output_schema: Type.Optional(
      Type.Object({}, { additionalProperties: true })
    )
  })
)

export const toolManifestSchemaObject = Type.Strict(
  Type.Object({
    $schema: Type.String({ minLength: 1 }),
    tool_id: Type.String({ minLength: 1 }),
    toolkit_id: Type.String({ minLength: 1 }),
    name: Type.String({ minLength: 1 }),
    description: Type.String({ minLength: 8, maxLength: 256 }),
    author: toolAuthorSchemaObject,
    binaries: Type.Optional(
      Type.Record(Type.String({ minLength: 1 }), Type.String({ minLength: 1 }))
    ),
    resources: Type.Optional(
      Type.Record(
        Type.String({ minLength: 1 }),
        Type.Array(Type.String({ minLength: 1 }))
      )
    ),
    functions: Type.Record(
      Type.String({ minLength: 1 }),
      toolFunctionSchemaObject
    )
  })
)

export type ToolManifestSchema = Static<typeof toolManifestSchemaObject>
