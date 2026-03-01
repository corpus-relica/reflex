// Runtime copy of docs/workflow-schema.json (JSON Schema draft-07).
// Keep in sync with the canonical schema file.

export const workflowSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'https://github.com/corpus-relica/reflex/docs/workflow-schema.json',
  title: 'Reflex Workflow',
  type: 'object',
  properties: {
    $schema: { type: 'string' },
    id: { type: 'string' },
    entry: { type: 'string' },
    nodes: {
      type: 'object',
      additionalProperties: { $ref: '#/definitions/Node' },
    },
    edges: {
      type: 'array',
      items: { $ref: '#/definitions/Edge' },
    },
    metadata: {
      type: 'object',
      additionalProperties: true,
    },
  },
  required: ['id', 'entry', 'nodes', 'edges'],
  additionalProperties: false,

  definitions: {
    Node: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        description: { type: 'string' },
        spec: { $ref: '#/definitions/NodeSpec' },
        invokes: { $ref: '#/definitions/InvocationSpec' },
        inputs: {
          type: 'array',
          items: { $ref: '#/definitions/NodeInput' },
        },
        outputs: {
          type: 'array',
          items: { $ref: '#/definitions/NodeOutput' },
        },
      },
      required: ['id', 'spec'],
      additionalProperties: false,
    },

    NodeSpec: {
      type: 'object',
      additionalProperties: true,
    },

    NodeInput: {
      type: 'object',
      properties: {
        key: { type: 'string' },
        required: { type: 'boolean' },
        description: { type: 'string' },
      },
      required: ['key', 'required'],
      additionalProperties: false,
    },

    NodeOutput: {
      type: 'object',
      properties: {
        key: { type: 'string' },
        guaranteed: { type: 'boolean' },
        description: { type: 'string' },
      },
      required: ['key', 'guaranteed'],
      additionalProperties: false,
    },

    InvocationSpec: {
      type: 'object',
      properties: {
        workflowId: { type: 'string' },
        returnMap: {
          type: 'array',
          items: { $ref: '#/definitions/ReturnMapping' },
        },
      },
      required: ['workflowId', 'returnMap'],
      additionalProperties: false,
    },

    ReturnMapping: {
      type: 'object',
      properties: {
        parentKey: { type: 'string' },
        childKey: { type: 'string' },
      },
      required: ['parentKey', 'childKey'],
      additionalProperties: false,
    },

    Edge: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        from: { type: 'string' },
        to: { type: 'string' },
        event: { type: 'string' },
        guard: { $ref: '#/definitions/Guard' },
      },
      required: ['id', 'from', 'to', 'event'],
      additionalProperties: false,
    },

    Guard: {
      oneOf: [
        {
          type: 'object',
          properties: {
            type: { const: 'exists' },
            key: { type: 'string' },
          },
          required: ['type', 'key'],
          additionalProperties: false,
        },
        {
          type: 'object',
          properties: {
            type: { const: 'not-exists' },
            key: { type: 'string' },
          },
          required: ['type', 'key'],
          additionalProperties: false,
        },
        {
          type: 'object',
          properties: {
            type: { const: 'equals' },
            key: { type: 'string' },
            value: {
              anyOf: [
                { type: 'string' },
                { type: 'number' },
                { type: 'boolean' },
                { type: 'null' },
              ],
            },
          },
          required: ['type', 'key', 'value'],
          additionalProperties: false,
        },
        {
          type: 'object',
          properties: {
            type: { const: 'not-equals' },
            key: { type: 'string' },
            value: {
              anyOf: [
                { type: 'string' },
                { type: 'number' },
                { type: 'boolean' },
                { type: 'null' },
              ],
            },
          },
          required: ['type', 'key', 'value'],
          additionalProperties: false,
        },
        {
          type: 'object',
          properties: {
            type: { const: 'custom' },
            name: { type: 'string' },
          },
          required: ['type', 'name'],
          additionalProperties: false,
        },
      ],
    },
  },
} as const;
