// Reflex — Engine Restore
// Implements M9-2: Reconstruct a ReflexEngine from an EngineSnapshot

import type {
  DecisionAgent,
  EngineSnapshot,
  RestoreOptions,
} from './types.js';
import { WorkflowRegistry } from './registry.js';
import { ReflexEngine, EngineError } from './engine.js';

/**
 * Reconstruct a ReflexEngine from a previously captured snapshot.
 *
 * The registry and agent must be provided at restore time — they contain
 * functions and are not serialized in the snapshot. The registry must contain
 * all workflows that were registered when the snapshot was taken.
 *
 * @param snapshot - Engine state captured via engine.snapshot()
 * @param registry - WorkflowRegistry containing all required workflow definitions
 * @param agent - DecisionAgent for resumed execution
 * @param options - Optional: guard registry for custom guard validation
 * @returns A ReflexEngine positioned at the exact state captured in the snapshot
 * @throws EngineError if registry is missing required workflows or guards are unresolved
 */
export function restoreEngine(
  snapshot: EngineSnapshot,
  registry: WorkflowRegistry,
  agent: DecisionAgent,
  _options?: RestoreOptions,
): ReflexEngine {
  // -- Validate registry completeness --------------------------------------
  const registeredIds = new Set(registry.list());
  const missing = snapshot.workflowIds.filter((id) => !registeredIds.has(id));
  if (missing.length > 0) {
    throw new EngineError(
      `Cannot restore: registry is missing workflow(s): ${missing.map((id) => `'${id}'`).join(', ')}`,
    );
  }

  // -- Validate current workflow and node exist ----------------------------
  const currentWorkflow = registry.get(snapshot.currentWorkflowId);
  if (!currentWorkflow) {
    throw new EngineError(
      `Cannot restore: current workflow '${snapshot.currentWorkflowId}' not found in registry`,
    );
  }
  if (!currentWorkflow.nodes[snapshot.currentNodeId]) {
    throw new EngineError(
      `Cannot restore: current node '${snapshot.currentNodeId}' not found in workflow '${snapshot.currentWorkflowId}'`,
    );
  }

  // -- Validate stack frame workflows and nodes ----------------------------
  for (const frame of snapshot.stack) {
    const frameWorkflow = registry.get(frame.workflowId);
    if (!frameWorkflow) {
      throw new EngineError(
        `Cannot restore: stack frame references workflow '${frame.workflowId}' not found in registry`,
      );
    }
    if (!frameWorkflow.nodes[frame.currentNodeId]) {
      throw new EngineError(
        `Cannot restore: stack frame references node '${frame.currentNodeId}' not found in workflow '${frame.workflowId}'`,
      );
    }
  }

  // -- Validate custom guards if guard registry provided -------------------
  if (_options?.guards) {
    for (const workflowId of snapshot.workflowIds) {
      const workflow = registry.get(workflowId)!;
      for (const edge of workflow.edges) {
        if (edge.guard?.type === 'custom') {
          const guardFn = (edge.guard as { evaluate?: unknown }).evaluate;
          if (typeof guardFn !== 'function') {
            throw new EngineError(
              `Cannot restore: workflow '${workflowId}', edge '${edge.id}' has an unresolved custom guard`,
            );
          }
        }
      }
    }
  }

  // -- Reconstruct engine from snapshot ------------------------------------
  return ReflexEngine._fromSnapshot(snapshot, registry, agent);
}
