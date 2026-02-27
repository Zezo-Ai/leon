export const PLAN_STEP_PROPERTIES_SCHEMA = {
  function: { type: 'string' },
  label: { type: 'string' }
}

export const PLAN_STEP_SCHEMA = {
  type: 'object',
  properties: PLAN_STEP_PROPERTIES_SCHEMA,
  required: ['function', 'label'],
  additionalProperties: false
}

export const PLAN_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: ['plan', 'final'] },
    steps: {
      type: 'array',
      items: PLAN_STEP_SCHEMA
    },
    summary: { type: 'string' },
    answer: { type: 'string' }
  },
  required: ['type'],
  additionalProperties: false
}
