// Reflex — Workflow Loader
// Implements M7-2: Load and validate JSON workflow definitions

import Ajv from 'ajv';
import type {
  BlackboardReader,
  BuiltinGuard,
  Edge,
  Guard,
  InvocationSpec,
  Node,
  NodeSpec,
  Workflow,
} from './types.js';
import { WorkflowValidationError } from './registry.js';
import { workflowSchema } from './workflow-schema.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Maps guard names (from JSON) to evaluate functions. */
export type GuardRegistry = Record<
  string,
  (blackboard: BlackboardReader) => boolean
>;

/** Options for loadWorkflow. */
export interface LoadWorkflowOptions {
  guards?: GuardRegistry;
}

// ---------------------------------------------------------------------------
// Schema validator (compiled once at module load)
// ---------------------------------------------------------------------------

const ajv = new Ajv({ allErrors: true });
const validateSchema = ajv.compile(workflowSchema);

// ---------------------------------------------------------------------------
// Guard shapes from JSON (before resolution)
// ---------------------------------------------------------------------------

interface JsonBuiltinGuard {
  type: 'exists' | 'not-exists' | 'equals' | 'not-equals';
  key: string;
  value?: unknown;
}

interface JsonCustomGuard {
  type: 'custom';
  name: string;
}

type JsonGuard = JsonBuiltinGuard | JsonCustomGuard;

// ---------------------------------------------------------------------------
// loadWorkflow
// ---------------------------------------------------------------------------

/**
 * Parse and validate a JSON workflow definition, returning a typed Workflow.
 *
 * @param input - Raw JSON string or pre-parsed object
 * @param options - Optional guard registry for resolving custom guard references
 * @returns A fully typed Workflow with guards resolved
 * @throws WorkflowValidationError on schema violations or missing guard references
 */
export function loadWorkflow(
  input: unknown,
  options?: LoadWorkflowOptions,
): Workflow {
  // 1. Parse if string
  let data: unknown;
  if (typeof input === 'string') {
    try {
      data = JSON.parse(input);
    } catch (e) {
      throw new WorkflowValidationError(
        'SCHEMA_VIOLATION',
        '<unknown>',
        `Invalid JSON: ${(e as Error).message}`,
      );
    }
  } else {
    data = input;
  }

  // 2. Validate against schema
  if (!validateSchema(data)) {
    const errors = validateSchema.errors ?? [];
    const detail = errors
      .map((e) => `${e.instancePath || '/'}: ${e.message}`)
      .join('; ');
    throw new WorkflowValidationError(
      'SCHEMA_VIOLATION',
      '<unknown>',
      `Schema validation failed: ${detail}`,
      { errors },
    );
  }

  // From here the data is structurally valid per the schema.
  const raw = data as Record<string, unknown>;

  const id = raw.id as string;
  const entry = raw.entry as string;
  const rawNodes = raw.nodes as Record<string, Record<string, unknown>>;
  const rawEdges = raw.edges as Array<Record<string, unknown>>;
  const metadata = raw.metadata as Record<string, unknown> | undefined;

  // 3. Build nodes
  const nodes: Record<string, Node> = {};
  for (const [key, rawNode] of Object.entries(rawNodes)) {
    const node: Node = {
      id: rawNode.id as string,
      spec: (rawNode.spec ?? {}) as NodeSpec,
    };
    if (rawNode.description !== undefined) {
      node.description = rawNode.description as string;
    }
    if (rawNode.invokes !== undefined) {
      const inv = rawNode.invokes as Record<string, unknown>;
      node.invokes = {
        workflowId: inv.workflowId as string,
        returnMap: (inv.returnMap as Array<Record<string, string>>).map(
          (rm) => ({
            parentKey: rm.parentKey,
            childKey: rm.childKey,
          }),
        ),
      } satisfies InvocationSpec;
    }
    nodes[key] = node;
  }

  // 4. Build edges with guard resolution
  const edges: Edge[] = rawEdges.map((rawEdge) => {
    const edge: Edge = {
      id: rawEdge.id as string,
      from: rawEdge.from as string,
      to: rawEdge.to as string,
      event: rawEdge.event as string,
    };

    if (rawEdge.guard !== undefined) {
      edge.guard = resolveGuard(
        rawEdge.guard as JsonGuard,
        id,
        edge.id,
        options?.guards,
      );
    }

    return edge;
  });

  // 5. Assemble workflow
  const workflow: Workflow = { id, entry, nodes, edges };
  if (metadata !== undefined) {
    workflow.metadata = metadata;
  }

  return workflow;
}

// ---------------------------------------------------------------------------
// Guard resolution
// ---------------------------------------------------------------------------

function resolveGuard(
  json: JsonGuard,
  workflowId: string,
  edgeId: string,
  registry?: GuardRegistry,
): Guard {
  if (json.type === 'custom') {
    const fn = registry?.[json.name];
    if (!fn) {
      throw new WorkflowValidationError(
        'UNKNOWN_GUARD_REFERENCE',
        workflowId,
        `Edge '${edgeId}': custom guard '${json.name}' not found in guard registry`,
        { edgeId, guardName: json.name },
      );
    }
    return { type: 'custom', evaluate: fn };
  }

  // Builtin guard — pass through directly
  const guard: BuiltinGuard = { type: json.type, key: json.key };
  if ('value' in json && json.value !== undefined) {
    guard.value = json.value;
  }
  return guard;
}
