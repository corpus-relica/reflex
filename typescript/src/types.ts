// Reflex — Core Type Definitions
// Transcribed from DESIGN.md Sections 2 and 3.2

// ---------------------------------------------------------------------------
// 2.3 NodeSpec — Opaque to Reflex
// ---------------------------------------------------------------------------

/**
 * Opaque payload attached to each node. Reflex never reads or interprets
 * NodeSpec — it is passed through to the decision agent for domain-specific
 * interpretation (e.g., LLM prompts, rule definitions, UI instructions).
 */
export interface NodeSpec {
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// 2.5 ReturnMapping
// ---------------------------------------------------------------------------

/**
 * Maps a child workflow's local blackboard key to a parent blackboard key.
 * On sub-workflow completion, each mapping copies the child's value into
 * the parent's local blackboard — this is how results flow back up the
 * call stack.
 */
export interface ReturnMapping {
  parentKey: string;
  childKey: string;
}

// ---------------------------------------------------------------------------
// 2.4 InvocationSpec
// ---------------------------------------------------------------------------

/**
 * Marks a node as a composition point that automatically invokes a
 * sub-workflow on entry. The decision agent is NOT consulted at invocation
 * nodes — they are pure structural connectors. After the sub-workflow
 * completes, {@link ReturnMapping | returnMap} copies results back to the
 * parent's blackboard.
 */
export interface InvocationSpec {
  workflowId: string;
  returnMap: ReturnMapping[];
}

// ---------------------------------------------------------------------------
// 2.13 Node Contracts (declarations only — not enforced at runtime)
// ---------------------------------------------------------------------------

/**
 * Declares a blackboard key that a node expects to read. Part of the
 * node contracts system (M8) — declarations only, not enforced at runtime.
 * Used by {@link WorkflowRegistry.verify | verify()} for static analysis.
 */
export interface NodeInput {
  key: string;
  required: boolean;
  description?: string;
}

/**
 * Declares a blackboard key that a node may write. Part of the node
 * contracts system (M8) — declarations only, not enforced at runtime.
 * Used by {@link WorkflowRegistry.verify | verify()} for static analysis.
 */
export interface NodeOutput {
  key: string;
  guaranteed: boolean;
  description?: string;
}

// ---------------------------------------------------------------------------
// 2.2 Node
// ---------------------------------------------------------------------------

/**
 * A node in a workflow DAG. If {@link InvocationSpec | invokes} is set, the
 * node is a composition point that automatically starts a sub-workflow on
 * entry. Otherwise, the decision agent is called to resolve the node.
 */
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

/**
 * One of four built-in guard types evaluated against the scoped blackboard.
 * Built-in guards are total by construction — they always terminate and
 * produce a boolean. `value` is required for `equals` and `not-equals`;
 * equality uses numeric-aware comparison with deep-equal fallback.
 */
export interface BuiltinGuard {
  type: 'exists' | 'equals' | 'not-exists' | 'not-equals';
  key: string;
  value?: unknown;
}

/**
 * A user-defined guard function evaluated against the scoped blackboard.
 * Custom guards must be total, terminating, and side-effect free —
 * violations break Reflex's formal guarantees (Type 1 ceiling).
 *
 * @see GuardRegistry for JSON workflow integration
 */
export interface CustomGuard {
  type: 'custom';
  evaluate: (blackboard: BlackboardReader) => boolean;
}

/** Discriminated union of built-in and custom guard types. */
export type Guard = BuiltinGuard | CustomGuard;

// ---------------------------------------------------------------------------
// 2.6 Edge
// ---------------------------------------------------------------------------

/**
 * A directed edge in a workflow DAG. Edges without a guard are always
 * valid. At fan-out points, guards filter which edges are presented to
 * the decision agent as valid transitions.
 */
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

/**
 * A directed acyclic graph of nodes and edges. Acyclicity is enforced at
 * registration time — repetition happens through recursive sub-workflow
 * invocation via {@link InvocationSpec}, keeping loops visible in the
 * call stack rather than hidden in graph structure.
 */
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

/**
 * Provenance metadata attached to every blackboard entry, recording which
 * workflow and node produced the value and the call stack depth at write time.
 */
export interface BlackboardSource {
  workflowId: string;
  nodeId: string;
  stackDepth: number;
}

/**
 * An immutable entry in the append-only blackboard. Multiple entries may
 * share the same key — {@link BlackboardReader.get | get()} returns the
 * most recent value, while {@link BlackboardReader.getAll | getAll()}
 * returns the full history.
 */
export interface BlackboardEntry {
  key: string;
  value: unknown;
  source: BlackboardSource;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// 2.10 BlackboardWrite (part of Decision)
// ---------------------------------------------------------------------------

/**
 * A key-value pair to be appended to the blackboard. Used in
 * {@link Decision} writes and {@link InitOptions} seed values.
 */
export interface BlackboardWrite {
  key: string;
  value: unknown;
}

// ---------------------------------------------------------------------------
// 2.12 Init Options
// ---------------------------------------------------------------------------

/**
 * Options for {@link ReflexEngine.init | engine.init()}. The optional
 * blackboard field pre-seeds the root workflow's blackboard before the
 * first step — useful for injecting configuration or external context.
 */
export interface InitOptions {
  blackboard?: BlackboardWrite[];
}

// ---------------------------------------------------------------------------
// 2.9 Call Stack
// ---------------------------------------------------------------------------

/**
 * A saved execution context on the call stack. When a sub-workflow is
 * invoked, the parent's frame is pushed onto the stack and restored when
 * the child completes. Exposed read-only in {@link DecisionContext.stack}.
 */
export interface StackFrame {
  workflowId: string;
  currentNodeId: string;
  returnMap: ReturnMapping[];
  blackboard: BlackboardEntry[];
}

// ---------------------------------------------------------------------------
// 2.11 Blackboard Reader
// ---------------------------------------------------------------------------

/**
 * Read-only view of the scoped blackboard. Reads walk the scope chain
 * (local → parent → grandparent) so child workflows can see ancestor
 * context without explicit parameter passing.
 */
export interface BlackboardReader {
  /** Returns the most recent value for `key`, or `undefined` if not found. */
  get(key: string): unknown | undefined;
  /** Returns `true` if `key` exists anywhere in the scope chain. */
  has(key: string): boolean;
  /** Returns all entries for `key` across the scope chain (newest first). */
  getAll(key: string): BlackboardEntry[];
  /** Returns all entries across the scope chain. */
  entries(): BlackboardEntry[];
  /** Returns all distinct keys across the scope chain. */
  keys(): string[];
  /** Returns only entries from the current (innermost) workflow scope. */
  local(): BlackboardEntry[];
}

// ---------------------------------------------------------------------------
// Cursor API (incremental blackboard reads for streaming persistence)
// ---------------------------------------------------------------------------

/**
 * A position in the blackboard entry log.
 * Use with entriesFrom() to read only entries appended after this position.
 * Cursor values are only valid for the ScopedBlackboard that produced them.
 */
export type Cursor = number;

/**
 * Read-only cursor interface for incremental blackboard reads.
 * Use cursor() to snapshot the current position, then entriesFrom() after
 * subsequent steps to retrieve only new entries.
 *
 * This is the interface returned by engine.currentBlackboard() — it
 * intentionally does NOT expose append() or reader() (write access).
 */
export interface CursorReader {
  /** Returns the current end position of the entry log. */
  cursor(): Cursor;
  /**
   * Returns entries appended at or after position c, plus the cursor for
   * the new end position.
   *
   * If c is negative, treats it as 0 (returns all entries).
   * If c is at or past the end, returns [] and the current end position.
   */
  entriesFrom(c: Cursor): [BlackboardEntry[], Cursor];
}

// ---------------------------------------------------------------------------
// 2.10 Decision Agent
// ---------------------------------------------------------------------------

/**
 * The context presented to the decision agent at each non-invocation step.
 * Contains the current node, its workflow, the scoped blackboard, valid
 * outgoing edges (after guard evaluation), and the call stack.
 */
export interface DecisionContext {
  workflow: Workflow;
  node: Node;
  blackboard: BlackboardReader;
  validEdges: Edge[];
  stack: ReadonlyArray<StackFrame>;
}

/**
 * The decision agent's response for a single step.
 *
 * - `advance` — pick an edge from {@link DecisionContext.validEdges} and
 *   optionally write to the blackboard.
 * - `suspend` — pause execution with a reason string; the engine becomes
 *   resumable. Writes are applied before the suspend takes effect.
 * - `complete` — terminate the current workflow. Only valid at terminal
 *   nodes (no outgoing edges); the engine rejects it otherwise.
 */
export type Decision =
  | { type: 'advance'; edge: string; writes?: BlackboardWrite[] }
  | { type: 'suspend'; reason: string; writes?: BlackboardWrite[] }
  | { type: 'complete'; writes?: BlackboardWrite[] };

/**
 * The pluggable core of Reflex. Implement this interface to provide
 * domain-specific step resolution — LLM reasoning, rule engines, human
 * input, or any combination. Reflex provides no default agent.
 */
export interface DecisionAgent {
  resolve(context: DecisionContext): Promise<Decision>;
}

// ---------------------------------------------------------------------------
// 3.2 Execution Engine — StepResult and EngineEvent
// ---------------------------------------------------------------------------

/**
 * Result of a single {@link ReflexEngine.step | step()} call.
 *
 * - `advanced` — moved to a new node via an edge.
 * - `invoked` — entered a sub-workflow at a composition node.
 * - `popped` — sub-workflow completed, returned to parent.
 * - `completed` — root workflow finished.
 * - `suspended` — agent requested a pause.
 */
export type StepResult =
  | { status: 'advanced'; node: Node }
  | { status: 'invoked'; workflow: Workflow; node: Node }
  | { status: 'popped'; workflow: Workflow; node: Node }
  | { status: 'completed' }
  | { status: 'suspended'; reason: string };

/**
 * Events emitted by the engine during execution. Register handlers with
 * {@link ReflexEngine.on | engine.on()}. Emission order within a step:
 * `node:exit` → `edge:traverse` → `node:enter` → `blackboard:write` →
 * terminal events (`engine:complete`, `engine:suspend`, `engine:error`).
 */
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

/**
 * Engine lifecycle states: `idle` (before init), `running` (stepping),
 * `suspended` (paused, resumable), `completed` (terminal), `error`.
 */
export type EngineStatus = 'idle' | 'running' | 'suspended' | 'completed' | 'error';

/**
 * Result of {@link ReflexEngine.run | engine.run()}, which steps until
 * completion, suspension, or error. Errors are caught and wrapped rather
 * than thrown.
 */
export type RunResult =
  | { status: 'completed' }
  | { status: 'suspended'; reason: string }
  | { status: 'error'; error: unknown };

/** Callback for engine events. The payload shape is event-specific. */
export type EventHandler = (payload?: unknown) => void;

// ---------------------------------------------------------------------------
// 4.2 Guard Registry
// ---------------------------------------------------------------------------

/**
 * Maps guard names (from JSON workflow definitions) to evaluate functions.
 * Used by {@link loadWorkflow} to resolve named guards back to
 * {@link CustomGuard} implementations. Guard functions must be total,
 * terminating, and side-effect free.
 */
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
