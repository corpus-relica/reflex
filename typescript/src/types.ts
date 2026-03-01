// Reflex — Core Type Definitions
// Transcribed from DESIGN.md Sections 2 and 3.2

// ---------------------------------------------------------------------------
// 2.3 NodeSpec — Opaque to Reflex
// ---------------------------------------------------------------------------

export interface NodeSpec {
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// 2.5 ReturnMapping
// ---------------------------------------------------------------------------

export interface ReturnMapping {
  parentKey: string;
  childKey: string;
}

// ---------------------------------------------------------------------------
// 2.4 InvocationSpec
// ---------------------------------------------------------------------------

export interface InvocationSpec {
  workflowId: string;
  returnMap: ReturnMapping[];
}

// ---------------------------------------------------------------------------
// 2.13 Node Contracts (declarations only — not enforced at runtime)
// ---------------------------------------------------------------------------

export interface NodeInput {
  key: string;
  required: boolean;
  description?: string;
}

export interface NodeOutput {
  key: string;
  guaranteed: boolean;
  description?: string;
}

// ---------------------------------------------------------------------------
// 2.2 Node
// ---------------------------------------------------------------------------

export interface Node {
  id: string;
  description?: string;
  spec: NodeSpec;
  invokes?: InvocationSpec;
  inputs?: NodeInput[];
  outputs?: NodeOutput[];
}

// ---------------------------------------------------------------------------
// 2.8 Guards
// ---------------------------------------------------------------------------

export interface BuiltinGuard {
  type: 'exists' | 'equals' | 'not-exists' | 'not-equals';
  key: string;
  value?: unknown;
}

export interface CustomGuard {
  type: 'custom';
  evaluate: (blackboard: BlackboardReader) => boolean;
}

export type Guard = BuiltinGuard | CustomGuard;

// ---------------------------------------------------------------------------
// 2.6 Edge
// ---------------------------------------------------------------------------

export interface Edge {
  id: string;
  from: string;
  to: string;
  event: string;
  guard?: Guard;
}

// ---------------------------------------------------------------------------
// 2.1 Workflow Definition
// ---------------------------------------------------------------------------

export interface Workflow {
  id: string;
  entry: string;
  nodes: Record<string, Node>;
  edges: Edge[];
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// 2.7 Blackboard
// ---------------------------------------------------------------------------

export interface BlackboardSource {
  workflowId: string;
  nodeId: string;
  stackDepth: number;
}

export interface BlackboardEntry {
  key: string;
  value: unknown;
  source: BlackboardSource;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// 2.10 BlackboardWrite (part of Decision)
// ---------------------------------------------------------------------------

export interface BlackboardWrite {
  key: string;
  value: unknown;
}

// ---------------------------------------------------------------------------
// 2.12 Init Options
// ---------------------------------------------------------------------------

export interface InitOptions {
  blackboard?: BlackboardWrite[];
}

// ---------------------------------------------------------------------------
// 2.9 Call Stack
// ---------------------------------------------------------------------------

export interface StackFrame {
  workflowId: string;
  currentNodeId: string;
  returnMap: ReturnMapping[];
  blackboard: BlackboardEntry[];
}

// ---------------------------------------------------------------------------
// 2.11 Blackboard Reader
// ---------------------------------------------------------------------------

export interface BlackboardReader {
  get(key: string): unknown | undefined;
  has(key: string): boolean;
  getAll(key: string): BlackboardEntry[];
  entries(): BlackboardEntry[];
  keys(): string[];
  local(): BlackboardEntry[];
}

// ---------------------------------------------------------------------------
// 2.10 Decision Agent
// ---------------------------------------------------------------------------

export interface DecisionContext {
  workflow: Workflow;
  node: Node;
  blackboard: BlackboardReader;
  validEdges: Edge[];
  stack: ReadonlyArray<StackFrame>;
}

export type Decision =
  | { type: 'advance'; edge: string; writes?: BlackboardWrite[] }
  | { type: 'suspend'; reason: string }
  | { type: 'complete'; writes?: BlackboardWrite[] };

export interface DecisionAgent {
  resolve(context: DecisionContext): Promise<Decision>;
}

// ---------------------------------------------------------------------------
// 3.2 Execution Engine — StepResult and EngineEvent
// ---------------------------------------------------------------------------

export type StepResult =
  | { status: 'advanced'; node: Node }
  | { status: 'invoked'; workflow: Workflow; node: Node }
  | { status: 'popped'; workflow: Workflow; node: Node }
  | { status: 'completed' }
  | { status: 'suspended'; reason: string };

export type EngineEvent =
  | 'node:enter'
  | 'node:exit'
  | 'edge:traverse'
  | 'workflow:push'
  | 'workflow:pop'
  | 'blackboard:write'
  | 'engine:complete'
  | 'engine:suspend'
  | 'engine:error';

// ---------------------------------------------------------------------------
// 3.2 Execution Engine — EngineStatus, RunResult, EventHandler
// ---------------------------------------------------------------------------

export type EngineStatus = 'idle' | 'running' | 'suspended' | 'completed' | 'error';

export type RunResult =
  | { status: 'completed' }
  | { status: 'suspended'; reason: string }
  | { status: 'error'; error: unknown };

export type EventHandler = (payload?: unknown) => void;

// ---------------------------------------------------------------------------
// 4.2 Guard Registry
// ---------------------------------------------------------------------------

/** Maps guard names (from JSON) to evaluate functions. */
export type GuardRegistry = Record<
  string,
  (blackboard: BlackboardReader) => boolean
>;

// ---------------------------------------------------------------------------
// 4.3 Persistence — Engine Snapshot (M9-1)
// ---------------------------------------------------------------------------

/**
 * JSON-serializable representation of complete engine state at a point in time.
 *
 * Workflow definitions, decision agents, and event handlers are NOT included —
 * they must be provided at restore time. This captures only runtime session
 * state: current position, blackboard contents, call stack, and engine status.
 *
 * Custom guards are represented by name (as stored in workflow JSON via M7).
 * Restoration requires a GuardRegistry to resolve them back to Guard
 * implementations.
 *
 * NodeSpec values must be JSON-serializable by convention — no functions, no
 * class instances. This constraint is documented, not enforced at runtime.
 */
export interface EngineSnapshot {
  /** Snapshot format version for forward compatibility. Currently "1". */
  version: string;
  /** ISO 8601 timestamp of when the snapshot was taken. */
  createdAt: string;
  /** Engine session identifier. */
  sessionId: string;
  /** Engine lifecycle state at snapshot time. */
  status: EngineStatus;
  /** ID of the currently executing workflow. */
  currentWorkflowId: string;
  /** ID of the current node within the current workflow. */
  currentNodeId: string;
  /** Blackboard entries for the innermost (current) workflow scope. */
  currentBlackboard: BlackboardEntry[];
  /** Call stack (index 0 = most-recent parent frame). */
  stack: StackFrame[];
  /**
   * Internal flag for correct resume behavior after a sub-workflow pop.
   * True when positioned at a parent's invoking node after the sub-workflow
   * has completed — prevents re-triggering the invocation on next step().
   */
  skipInvocation: boolean;
  /**
   * All workflow IDs registered at snapshot time. Used at restore time to
   * validate registry completeness — not the full definitions.
   */
  workflowIds: string[];
}

// ---------------------------------------------------------------------------
// 4.3 Persistence — Restore Options (M9-2)
// ---------------------------------------------------------------------------

/** Options for restoreEngine(). */
export interface RestoreOptions {
  /** Guard registry for validating custom guard availability at restore time. */
  guards?: GuardRegistry;
}

// ---------------------------------------------------------------------------
// 4.3 Persistence — Persistence Adapter (M9-2)
// ---------------------------------------------------------------------------

/**
 * Consumer-provided storage adapter for saving and loading engine snapshots.
 *
 * Reflex provides no built-in implementations — consumers supply their own
 * (file system, database, cloud storage, etc.). The adapter is optional;
 * snapshot() and restoreEngine() work standalone for manual save/load.
 */
export interface PersistenceAdapter {
  save(sessionId: string, snapshot: EngineSnapshot): Promise<void>;
  load(sessionId: string): Promise<EngineSnapshot | null>;
}
