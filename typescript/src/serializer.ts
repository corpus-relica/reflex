// Reflex — Workflow Serializer
// Implements M7-3: Serialize programmatic Workflow objects to JSON

import type {
  BlackboardReader,
  BuiltinGuard,
  CustomGuard,
  Edge,
  Guard,
  Node,
  Workflow,
} from './types.js';
import { WorkflowValidationError } from './registry.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Maps evaluate functions back to guard names for serialization. */
export type GuardNameMap = Map<
  (blackboard: BlackboardReader) => boolean,
  string
>;

/** Options for serializeWorkflow. */
export interface SerializeWorkflowOptions {
  guardNames?: GuardNameMap;
}

// ---------------------------------------------------------------------------
// serializeWorkflow
// ---------------------------------------------------------------------------

/**
 * Serialize a typed Workflow object to a JSON string.
 *
 * BuiltinGuards serialize directly. CustomGuards require a `guardNames` map
 * to recover the JSON `{ type: "custom", name: "..." }` representation.
 *
 * @param wf - The Workflow to serialize
 * @param options - Optional guard name map for custom guard serialization
 * @returns A JSON string representing the workflow
 * @throws WorkflowValidationError if a custom guard is not in guardNames
 */
export function serializeWorkflow(
  wf: Workflow,
  options?: SerializeWorkflowOptions,
): string {
  const out: Record<string, unknown> = {
    id: wf.id,
    entry: wf.entry,
    nodes: serializeNodes(wf.nodes),
    edges: serializeEdges(wf.edges, wf.id, options?.guardNames),
  };

  if (wf.metadata !== undefined) {
    out.metadata = wf.metadata;
  }

  return JSON.stringify(out, null, 2);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function serializeNodes(
  nodes: Record<string, Node>,
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [key, node] of Object.entries(nodes)) {
    const n: Record<string, unknown> = {
      id: node.id,
      spec: node.spec,
    };
    if (node.description !== undefined) {
      n.description = node.description;
    }
    if (node.invokes !== undefined) {
      n.invokes = {
        workflowId: node.invokes.workflowId,
        returnMap: node.invokes.returnMap.map((rm) => ({
          parentKey: rm.parentKey,
          childKey: rm.childKey,
        })),
      };
    }
    out[key] = n;
  }
  return out;
}

function serializeEdges(
  edges: Edge[],
  workflowId: string,
  guardNames?: GuardNameMap,
): Array<Record<string, unknown>> {
  return edges.map((edge) => {
    const e: Record<string, unknown> = {
      id: edge.id,
      from: edge.from,
      to: edge.to,
      event: edge.event,
    };
    if (edge.guard !== undefined) {
      e.guard = serializeGuard(edge.guard, workflowId, edge.id, guardNames);
    }
    return e;
  });
}

function serializeGuard(
  guard: Guard,
  workflowId: string,
  edgeId: string,
  guardNames?: GuardNameMap,
): Record<string, unknown> {
  if (guard.type === 'custom') {
    const cg = guard as CustomGuard;
    const name = guardNames?.get(cg.evaluate);
    if (!name) {
      throw new WorkflowValidationError(
        'SCHEMA_VIOLATION',
        workflowId,
        `Edge '${edgeId}': custom guard has no name in guardNames map (cannot serialize)`,
        { edgeId },
      );
    }
    return { type: 'custom', name };
  }

  // Builtin guard
  const bg = guard as BuiltinGuard;
  const out: Record<string, unknown> = { type: bg.type, key: bg.key };
  if (bg.value !== undefined) {
    out.value = bg.value;
  }
  return out;
}
