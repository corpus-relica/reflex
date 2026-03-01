// Reflex — Public API Surface

import { WorkflowRegistry } from './registry.js';
import { ReflexEngine } from './engine.js';
import type { DecisionAgent } from './types.js';

// ---------------------------------------------------------------------------
// Factory functions
// ---------------------------------------------------------------------------

/** Options for engine creation. Reserved for future extension. */
export interface EngineOptions {}

/** Create a WorkflowRegistry. Register workflows before creating an engine. */
export function createRegistry(): WorkflowRegistry {
  return new WorkflowRegistry();
}

/** Create a ReflexEngine bound to a registry and decision agent. */
export function createEngine(
  registry: WorkflowRegistry,
  agent: DecisionAgent,
  _options?: EngineOptions,
): ReflexEngine {
  return new ReflexEngine(registry, agent);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type {
  NodeSpec,
  NodeInput,
  NodeOutput,
  ReturnMapping,
  InvocationSpec,
  Node,
  BuiltinGuard,
  CustomGuard,
  Guard,
  Edge,
  Workflow,
  BlackboardSource,
  BlackboardEntry,
  BlackboardWrite,
  StackFrame,
  BlackboardReader,
  DecisionContext,
  Decision,
  DecisionAgent,
  StepResult,
  EngineEvent,
  EngineStatus,
  RunResult,
  EventHandler,
  InitOptions,
  EngineSnapshot,
  GuardRegistry,
  RestoreOptions,
  PersistenceAdapter,
} from './types.js';

// ---------------------------------------------------------------------------
// Classes and error types
// ---------------------------------------------------------------------------

export { WorkflowRegistry } from './registry.js';
export { WorkflowValidationError } from './registry.js';
export type {
  ValidationErrorCode,
  VerificationWarningCode,
  VerificationWarning,
  VerificationResult,
} from './registry.js';

export { ReflexEngine } from './engine.js';
export { EngineError } from './engine.js';

// ---------------------------------------------------------------------------
// Loader (M7-2: Declarative Workflows)
// ---------------------------------------------------------------------------

export { loadWorkflow } from './loader.js';
export type { LoadWorkflowOptions } from './loader.js';

// ---------------------------------------------------------------------------
// Serializer (M7-3: Declarative Workflows)
// ---------------------------------------------------------------------------

export { serializeWorkflow } from './serializer.js';
export type { GuardNameMap, SerializeWorkflowOptions } from './serializer.js';

// ---------------------------------------------------------------------------
// Restore (M9-2: Persistence)
// ---------------------------------------------------------------------------

export { restoreEngine } from './restore.js';
