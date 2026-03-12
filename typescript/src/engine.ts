// Reflex — Execution Engine
// Implements DESIGN.md Section 3.2
// M4-1: Constructor, init(), state inspection.
// M4-2: step() — single-workflow stepping with event emission.
// M4-3: Stack operations — invocation and pop.
// M4-4: run() — step until done or suspended.
// M4-5: Event emission — audit and ordering confirmation.

import {
  Workflow,
  Node,
  Edge,
  BlackboardEntry,
  BlackboardReader,
  BlackboardSource,
  BlackboardWrite,
  StackFrame,
  DecisionAgent,
  DecisionContext,
  Decision,
  StepResult,
  RunResult,
  EngineEvent,
  EventHandler,
  EngineStatus,
  EngineSnapshot,
  InitOptions,
  UnwindOptions,
  UnwindEvent,
  CursorReader,
  PushWorkflowOptions,
} from './types.js';
import { WorkflowRegistry } from './registry.js';
import { ScopedBlackboard, ScopedBlackboardReader } from './blackboard.js';
import { filterEdges } from './guards.js';

// ---------------------------------------------------------------------------
// Engine Error
// ---------------------------------------------------------------------------

/**
 * Thrown by the engine for structural and pre-condition violations (e.g.,
 * calling step() before init(), missing workflows). Distinct from the
 * `engine:error` event, which is emitted for runtime failures like guard
 * evaluation errors or agent exceptions — those do not throw.
 */
export class EngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EngineError';
  }
}

// ---------------------------------------------------------------------------
// ReflexEngine
// ---------------------------------------------------------------------------

/**
 * The Reflex execution engine. Lifecycle: construct → {@link init} →
 * {@link step}/{@link run} → {@link snapshot} (optional).
 *
 * Use {@link createEngine} for construction. The engine is bound to a
 * single registry and decision agent for its lifetime.
 */
export class ReflexEngine {
  private readonly _registry: WorkflowRegistry;
  private readonly _agent: DecisionAgent;

  // Session state — null until init() is called
  private _sessionId: string | null = null;
  private _status: EngineStatus = 'idle';
  private _currentWorkflowId: string | null = null;
  private _currentNodeId: string | null = null;
  private _currentBlackboard: ScopedBlackboard | null = null;

  // Call stack — suspended workflow frames (active frame is NOT on the stack)
  private _stack: StackFrame[] = [];

  // After a stack pop, the engine resumes at the invoking node. This flag
  // prevents re-triggering the invocation on the next step() — the agent
  // should run normal edge logic instead.
  private _skipInvocation = false;

  // Event handlers
  private readonly _handlers: Map<EngineEvent, EventHandler[]> = new Map();

  constructor(registry: WorkflowRegistry, agent: DecisionAgent) {
    this._registry = registry;
    this._agent = agent;
  }

  // -------------------------------------------------------------------------
  // Restore from snapshot (M9-2) — package-internal factory
  // -------------------------------------------------------------------------

  /** @internal — Used by restoreEngine(). Not part of the public API. */
  static _fromSnapshot(
    snapshot: EngineSnapshot,
    registry: WorkflowRegistry,
    agent: DecisionAgent,
  ): ReflexEngine {
    const engine = new ReflexEngine(registry, agent);
    engine._sessionId = snapshot.sessionId;
    engine._status = snapshot.status;
    engine._currentWorkflowId = snapshot.currentWorkflowId;
    engine._currentNodeId = snapshot.currentNodeId;
    engine._currentBlackboard = new ScopedBlackboard(
      snapshot.currentBlackboard.map((e) => ({ ...e })),
    );
    engine._stack = snapshot.stack.map((frame) => ({
      ...frame,
      blackboard: frame.blackboard.map((e) => ({ ...e })),
    }));
    engine._skipInvocation = snapshot.skipInvocation;
    return engine;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Initialize a new execution session for the given workflow. Must be
   * called before step() or run(). Optionally seeds the root blackboard.
   * Emits `node:enter` for the entry node.
   *
   * @returns The generated session ID (UUID v4).
   * @throws {EngineError} If the workflow is not registered.
   */
  async init(workflowId: string, options?: InitOptions): Promise<string> {
    const workflow = this._registry.get(workflowId);
    if (!workflow) {
      throw new EngineError(
        `Cannot initialize: workflow '${workflowId}' is not registered`,
      );
    }

    this._sessionId = crypto.randomUUID();
    this._currentWorkflowId = workflowId;
    this._currentNodeId = workflow.entry;
    this._currentBlackboard = new ScopedBlackboard();
    this._stack = [];
    this._skipInvocation = false;
    this._status = 'running';
    if (options?.blackboard && options.blackboard.length > 0) {
      const seedSource: BlackboardSource = {
        workflowId,
        nodeId: '__init__',
        stackDepth: 0,
      };
      const seedEntries = this._currentBlackboard.append(
        options.blackboard,
        seedSource,
      );
      this._emit('blackboard:write', { entries: seedEntries, workflow });
    }

    // Emit node:enter for the entry node so every node:exit in the first
    // step() has a matching node:enter. Fires after blackboard seeding.
    const entryNode = workflow.nodes[workflow.entry]!;
    this._emit('node:enter', { node: entryNode, workflow });

    return this._sessionId;
  }

  /**
   * Execute a single iteration of the engine loop. Handles invocation,
   * guard evaluation, agent resolution, and stack operations.
   *
   * @throws {EngineError} If called before init() or in an invalid state.
   */
  async step(): Promise<StepResult> {
    // -- Precondition guards ------------------------------------------------
    if (this._status !== 'running' && this._status !== 'suspended') {
      throw new EngineError(
        `step() called in invalid state: '${this._status}' — engine must be 'running' or 'suspended'`,
      );
    }
    if (
      this._currentWorkflowId === null ||
      this._currentNodeId === null ||
      this._currentBlackboard === null
    ) {
      throw new EngineError('step() called before init()');
    }
    // Resume from suspension
    if (this._status === 'suspended') {
      this._status = 'running';
    }

    const workflow = this._registry.get(this._currentWorkflowId)!;
    const node = workflow.nodes[this._currentNodeId]!;

    // -- Invocation node handling (before guard evaluation and agent call) ---
    if (node.invokes && !this._skipInvocation) {
      const subWorkflow = this._registry.get(node.invokes.workflowId);
      if (!subWorkflow) {
        this._status = 'suspended';
        this._emit('engine:error', {
          error: new EngineError(
            `Invocation failed: sub-workflow '${node.invokes.workflowId}' is not registered`,
          ),
          nodeId: this._currentNodeId,
        });
        return {
          status: 'suspended',
          reason: `Sub-workflow '${node.invokes.workflowId}' not found`,
        };
      }

      // Push current frame onto the stack
      const frame: StackFrame = {
        workflowId: this._currentWorkflowId,
        currentNodeId: this._currentNodeId,
        returnMap: node.invokes.returnMap,
        blackboard: [
          ...this._currentBlackboard.getEntries(),
        ] as BlackboardEntry[],
      };
      this._stack.unshift(frame);

      // Start sub-workflow
      this._currentWorkflowId = subWorkflow.id;
      this._currentNodeId = subWorkflow.entry;
      this._currentBlackboard = new ScopedBlackboard();

      // Event order: workflow:push then node:enter (sub-workflow entry).
      // DESIGN.md's "node:enter → workflow:push" describes the cross-step
      // session sequence — the prior step's advance already emitted node:enter
      // for the invoking node. Symmetric with pop: workflow:pop → node:enter.
      this._emit('workflow:push', { frame, workflow: subWorkflow });

      const entryNode = subWorkflow.nodes[subWorkflow.entry]!;
      this._emit('node:enter', { node: entryNode, workflow: subWorkflow });

      return { status: 'invoked', workflow: subWorkflow, node: entryNode };
    }
    this._skipInvocation = false;

    // -- Guard evaluation ---------------------------------------------------
    const reader = this.blackboard();
    const filterResult = filterEdges(
      this._currentNodeId,
      workflow.edges,
      reader,
    );
    if (!filterResult.ok) {
      this._status = 'suspended';
      this._emit('engine:error', {
        error: filterResult.error,
        nodeId: this._currentNodeId,
      });
      return { status: 'suspended', reason: 'Guard evaluation error' };
    }
    const validEdges = filterResult.edges;

    // -- Build DecisionContext and call agent --------------------------------
    const context: DecisionContext = {
      workflow,
      node,
      blackboard: reader,
      validEdges,
      stack: this.stack(),
    };

    let decision: Decision;
    try {
      decision = await this._agent.resolve(context);
    } catch (error) {
      this._status = 'suspended';
      this._emit('engine:error', { error, nodeId: this._currentNodeId });
      return { status: 'suspended', reason: 'Decision agent threw an error' };
    }

    // -- Handle advance -----------------------------------------------------
    if (decision.type === 'advance') {
      const chosenEdge = validEdges.find((e) => e.id === decision.edge);
      if (!chosenEdge) {
        this._status = 'suspended';
        this._emit('engine:error', {
          error: new EngineError(
            `Decision agent chose invalid edge '${decision.edge}'`,
          ),
          nodeId: this._currentNodeId,
        });
        return { status: 'suspended', reason: 'Invalid edge selection' };
      }

      this._emit('node:exit', { node, workflow });
      this._emit('edge:traverse', { edge: chosenEdge, workflow });

      if (decision.writes && decision.writes.length > 0) {
        const source: BlackboardSource = {
          workflowId: this._currentWorkflowId,
          nodeId: this._currentNodeId,
          stackDepth: this._stack.length,
        };
        const newEntries = this._currentBlackboard.append(
          decision.writes,
          source,
        );
        this._emit('blackboard:write', { entries: newEntries, workflow });
      }

      this._currentNodeId = chosenEdge.to;
      const nextNode = workflow.nodes[chosenEdge.to]!;
      this._emit('node:enter', { node: nextNode, workflow });

      return { status: 'advanced', node: nextNode };
    }

    // -- Handle suspend -----------------------------------------------------
    if (decision.type === 'suspend') {
      if (decision.writes && decision.writes.length > 0) {
        const source: BlackboardSource = {
          workflowId: this._currentWorkflowId,
          nodeId: this._currentNodeId,
          stackDepth: this._stack.length,
        };
        const newEntries = this._currentBlackboard.append(
          decision.writes,
          source,
        );
        this._emit('blackboard:write', { entries: newEntries, workflow });
      }
      this._status = 'suspended';
      this._emit('engine:suspend', {
        reason: decision.reason,
        nodeId: this._currentNodeId,
      });
      return { status: 'suspended', reason: decision.reason };
    }

    // -- Handle complete ----------------------------------------------------
    // Enforce terminal-node-only (structural: no outgoing edges)
    const hasOutgoing = workflow.edges.some(
      (e) => e.from === this._currentNodeId,
    );
    if (hasOutgoing) {
      this._status = 'suspended';
      this._emit('engine:error', {
        error: new EngineError(
          `Decision agent returned 'complete' at non-terminal node '${this._currentNodeId}'`,
        ),
        nodeId: this._currentNodeId,
      });
      return { status: 'suspended', reason: 'complete at non-terminal node' };
    }

    if (decision.writes && decision.writes.length > 0) {
      const source: BlackboardSource = {
        workflowId: this._currentWorkflowId,
        nodeId: this._currentNodeId,
        stackDepth: this._stack.length,
      };
      const newEntries = this._currentBlackboard.append(
        decision.writes,
        source,
      );
      this._emit('blackboard:write', { entries: newEntries, workflow });
    }

    if (this._stack.length === 0) {
      this._status = 'completed';
      this._emit('engine:complete', { workflow });
      return { status: 'completed' };
    }

    // -- Stack pop: sub-workflow complete, return to parent -----------------
    const childBlackboard = this._currentBlackboard;
    const frame = this._stack.shift()!;

    // Reconstruct parent blackboard from frozen snapshot
    const parentBlackboard = new ScopedBlackboard(frame.blackboard);
    const parentWorkflow = this._registry.get(frame.workflowId)!;
    const returnSource: BlackboardSource = {
      workflowId: frame.workflowId,
      nodeId: frame.currentNodeId,
      stackDepth: this._stack.length,
    };

    // Execute returnMap: copy child values → parent blackboard
    for (const mapping of frame.returnMap) {
      const childValue = childBlackboard.reader().get(mapping.childKey);
      if (childValue !== undefined) {
        const newEntries = parentBlackboard.append(
          [{ key: mapping.parentKey, value: childValue }],
          returnSource,
        );
        this._emit('blackboard:write', {
          entries: newEntries,
          workflow: parentWorkflow,
        });
      }
      // Missing childKey: skip gracefully (no write, no error)
    }

    // Restore parent state — skip re-invocation on the next step()
    this._currentWorkflowId = frame.workflowId;
    this._currentNodeId = frame.currentNodeId;
    this._currentBlackboard = parentBlackboard;
    this._skipInvocation = true;

    const invokingNode = parentWorkflow.nodes[frame.currentNodeId]!;

    this._emit('workflow:pop', { frame, workflow: parentWorkflow });
    this._emit('node:enter', { node: invokingNode, workflow: parentWorkflow });

    return { status: 'popped', workflow: parentWorkflow, node: invokingNode };
  }

  /**
   * Step repeatedly until the engine completes, suspends, or errors.
   * Errors from step() are caught and returned as `{ status: 'error' }`
   * rather than thrown.
   *
   * @throws {EngineError} If called before init() or in an invalid state.
   */
  async run(): Promise<RunResult> {
    // -- Precondition guards ------------------------------------------------
    if (this._status !== 'running' && this._status !== 'suspended') {
      throw new EngineError(
        `run() called in invalid state: '${this._status}' — engine must be 'running' or 'suspended'`,
      );
    }
    if (
      this._currentWorkflowId === null ||
      this._currentNodeId === null ||
      this._currentBlackboard === null
    ) {
      throw new EngineError('run() called before init()');
    }

    // -- Track whether the most-recent suspension originated from an error.
    // step() emits engine:error synchronously before returning, so this flag
    // is set before the await resolves.
    let lastErrorPayload: unknown = undefined;
    let errorFiredThisStep = false;

    this.on('engine:error', (payload) => {
      errorFiredThisStep = true;
      lastErrorPayload = payload;
    });

    // -- Step loop -----------------------------------------------------------
    while (true) {
      errorFiredThisStep = false;
      lastErrorPayload = undefined;

      let result: StepResult;
      try {
        result = await this.step();
      } catch (error) {
        return { status: 'error', error };
      }

      if (result.status === 'completed') {
        return { status: 'completed' };
      }

      if (result.status === 'suspended') {
        if (errorFiredThisStep) {
          return { status: 'error', error: lastErrorPayload };
        }
        return { status: 'suspended', reason: result.reason };
      }

      // 'advanced', 'invoked', 'popped' — continue looping
    }
  }

  // -------------------------------------------------------------------------
  // State Inspection
  // -------------------------------------------------------------------------

  /** Returns the current engine lifecycle state. */
  status(): EngineStatus {
    return this._status;
  }

  /**
   * Returns the session ID assigned during init().
   * @throws {EngineError} If called before init().
   */
  sessionId(): string {
    if (this._sessionId === null) {
      throw new EngineError('Engine not initialized — call init() first');
    }
    return this._sessionId;
  }

  /** Returns the current node, or `null` before init(). */
  currentNode(): Node | null {
    if (this._currentWorkflowId === null || this._currentNodeId === null) {
      return null;
    }
    const workflow = this._registry.get(this._currentWorkflowId);
    if (!workflow) return null;
    return workflow.nodes[this._currentNodeId] ?? null;
  }

  /** Returns the current workflow, or `null` before init(). */
  currentWorkflow(): Workflow | null {
    if (this._currentWorkflowId === null) return null;
    return this._registry.get(this._currentWorkflowId) ?? null;
  }

  /**
   * Returns a read-only cursor interface for the active workflow's blackboard.
   * During sub-workflow execution, this returns the child workflow's blackboard
   * (not the parent's).
   *
   * Use this for cursor-based incremental reads (e.g., streaming persistence).
   * For scoped reads across the full call stack, use blackboard() instead.
   *
   * Returns null if no session is active (before init() is called).
   */
  currentBlackboard(): CursorReader | null {
    return this._currentBlackboard;
  }

  /**
   * Returns a scoped blackboard reader that walks the full call stack
   * (local → parent → grandparent). Use this in decision agents for
   * context-sensitive reads. For cursor-based incremental reads, use
   * {@link currentBlackboard} instead.
   */
  blackboard(): BlackboardReader {
    if (this._currentBlackboard === null) {
      return new ScopedBlackboardReader([]);
    }
    // Stack frames ordered so _stack[0] is the most-recent parent.
    // ScopedBlackboard.reader() takes parent scopes in that same order.
    const parentScopes = this._stack.map((frame) => [...frame.blackboard]);
    return this._currentBlackboard.reader(parentScopes);
  }

  /** Returns a snapshot copy of the call stack. Index 0 is the most-recent parent. */
  stack(): ReadonlyArray<StackFrame> {
    return [...this._stack];
  }

  /**
   * Re-evaluates guards and returns currently valid outgoing edges for
   * the current node. Returns `[]` if no session is active or on error.
   * This is a read-only inspector — guard errors are not emitted as events.
   */
  validEdges(): Edge[] {
    const workflow = this.currentWorkflow();
    if (!workflow || this._currentNodeId === null) return [];

    const reader = this.blackboard();
    const result = filterEdges(this._currentNodeId, workflow.edges, reader);

    if (!result.ok) {
      // State inspector — no event emission. Guard errors during execution
      // are handled by step() with proper engine:error emission.
      return [];
    }

    return result.edges;
  }

  // -------------------------------------------------------------------------
  // Persistence — Snapshot (M9-1)
  // -------------------------------------------------------------------------

  /**
   * Capture a JSON-serializable snapshot of the current engine state.
   * Use with {@link restoreEngine} for persistence and session recovery.
   *
   * @throws {EngineError} If called before init().
   */
  snapshot(): EngineSnapshot {
    if (
      this._sessionId === null ||
      this._currentWorkflowId === null ||
      this._currentNodeId === null ||
      this._currentBlackboard === null
    ) {
      throw new EngineError(
        'snapshot() called before init() — no session state to capture',
      );
    }

    return {
      version: '1',
      createdAt: new Date().toISOString(),
      sessionId: this._sessionId,
      status: this._status,
      currentWorkflowId: this._currentWorkflowId,
      currentNodeId: this._currentNodeId,
      currentBlackboard: [
        ...this._currentBlackboard.getEntries(),
      ] as BlackboardEntry[],
      stack: this._stack.map((frame) => ({
        ...frame,
        blackboard: [...frame.blackboard],
      })),
      skipInvocation: this._skipInvocation,
      workflowIds: this._registry.list(),
    };
  }

  // -------------------------------------------------------------------------
  // Stack Unwinding
  // -------------------------------------------------------------------------

  /**
   * Discard all stack frames above depth `n` without processing returnMaps
   * or consulting the decision agent. Frames evaporate cleanly.
   *
   * `n` is the target depth from the bottom of the stack (root = 0).
   * After the call, `engine.stack().length === n`. If `n` equals the
   * current stack depth, this is a no-op.
   *
   * The engine remains in `suspended` state after unwind — call
   * {@link run} or {@link step} to resume execution at the target node.
   *
   * @param options.reinvoke — When `true`, the restored frame's invocation
   *   node will re-trigger its sub-workflow on the next step() rather than
   *   advancing past it. Defaults to `false`.
   *
   * @throws {EngineError} If called before init(), not in `suspended`
   *   state, or `n` is out of range.
   */
  unwindToDepth(n: number, options?: UnwindOptions): void {
    if (
      this._sessionId === null ||
      this._currentWorkflowId === null ||
      this._currentNodeId === null ||
      this._currentBlackboard === null
    ) {
      throw new EngineError('unwindToDepth() called before init()');
    }
    if (this._status !== 'suspended') {
      throw new EngineError(
        `unwindToDepth() requires engine to be suspended, but status is '${this._status}'`,
      );
    }
    if (n < 0 || n > this._stack.length) {
      throw new EngineError(
        `unwindToDepth(${n}) out of range — valid range is 0..${this._stack.length}`,
      );
    }

    // No-op: already at target depth
    if (n === this._stack.length) {
      return;
    }

    // Target frame is at array index (stack.length - 1 - n).
    // Stack layout: index 0 = most-recent parent, last index = root.
    const targetIdx = this._stack.length - 1 - n;
    const targetFrame = this._stack[targetIdx];

    // Capture frames to discard BEFORE mutating state.
    // Build a synthetic StackFrame for the active layer (not on _stack).
    const activeFrameSnapshot: StackFrame = {
      workflowId: this._currentWorkflowId,
      currentNodeId: this._currentNodeId,
      returnMap: [],
      blackboard: [
        ...this._currentBlackboard.getEntries(),
      ] as BlackboardEntry[],
    };
    const discardedFrames = [
      activeFrameSnapshot,
      ...this._stack.slice(0, targetIdx),
    ];

    // Restore target frame as active context.
    // Reconstruct blackboard from frozen snapshot (mirrors pop path).
    this._currentWorkflowId = targetFrame.workflowId;
    this._currentNodeId = targetFrame.currentNodeId;
    this._currentBlackboard = new ScopedBlackboard(
      targetFrame.blackboard.map((e) => ({ ...e })),
    );

    // Keep only frames below the target (the target's ancestors).
    this._stack = this._stack.slice(targetIdx + 1);

    // The target node is an invocation node (frames are only pushed at
    // invocation nodes). By default, skip re-triggering the sub-workflow
    // on resume. When reinvoke is true, allow re-invocation instead.
    const reinvoke = options?.reinvoke === true;
    this._skipInvocation = !reinvoke;

    // Emit stack:unwind so listeners (devtools, logging) can stay in sync.
    const restoredWorkflow = this._registry.get(this._currentWorkflowId)!;
    const restoredNode = restoredWorkflow.nodes[this._currentNodeId]!;
    this._emit('stack:unwind', {
      discardedFrames,
      targetDepth: n,
      restoredWorkflow,
      restoredNode,
      reinvoke,
    } satisfies UnwindEvent);
  }

  // -------------------------------------------------------------------------
  // Imperative Push/Pop
  // -------------------------------------------------------------------------

  /**
   * Programmatically push a sub-workflow onto the call stack. The current
   * workflow/node/blackboard is saved in a {@link StackFrame} and the engine
   * switches to the sub-workflow's entry node.
   *
   * This complements the declarative {@link InvocationSpec | node.invokes}
   * mechanism — use it when invocation is driven by external code (e.g.,
   * user clicks "Create New") rather than the graph structure.
   *
   * Note: The issue proposal describes async `Promise<StepResult>` but
   * push/pop are synchronous — no agent resolution or async work occurs.
   *
   * @param options.inputMap — Seed the child blackboard with parent values
   *   at push time. Each mapping reads `from` in the parent scope and
   *   writes to `to` in the child's local scope (additive seeding, not
   *   parent-key isolation).
   * @param options.returnMap — Propagate child values back to the parent
   *   on {@link popWorkflow}.
   *
   * @throws {EngineError} If called before init(), in completed/error
   *   state, or if the workflow is not registered.
   */
  pushWorkflow(workflowId: string, options?: PushWorkflowOptions): StepResult {
    // -- Precondition guards ------------------------------------------------
    if (
      this._currentWorkflowId === null ||
      this._currentNodeId === null ||
      this._currentBlackboard === null
    ) {
      throw new EngineError('pushWorkflow() called before init()');
    }
    if (this._status !== 'running' && this._status !== 'suspended') {
      throw new EngineError(
        `pushWorkflow() called in invalid state: '${this._status}' — engine must be 'running' or 'suspended'`,
      );
    }

    const subWorkflow = this._registry.get(workflowId);
    if (!subWorkflow) {
      throw new EngineError(
        `pushWorkflow() failed: workflow '${workflowId}' is not registered`,
      );
    }

    // Capture parent reader BEFORE mutating the stack — needed for inputMap
    // reads and must reflect the pre-push scope chain.
    const parentReader = this.blackboard();

    // Push current frame onto the stack
    const frame: StackFrame = {
      workflowId: this._currentWorkflowId,
      currentNodeId: this._currentNodeId,
      returnMap: options?.returnMap ?? [],
      blackboard: [
        ...this._currentBlackboard.getEntries(),
      ] as BlackboardEntry[],
    };
    this._stack.unshift(frame);

    // Switch active context to sub-workflow
    this._currentWorkflowId = subWorkflow.id;
    this._currentNodeId = subWorkflow.entry;
    this._currentBlackboard = new ScopedBlackboard();

    // Clear stale _skipInvocation — the consumer is intentionally pushing,
    // so any flag left from a prior pop must not suppress declarative
    // invocations in the child workflow.
    this._skipInvocation = false;

    // Apply inputMap: seed child blackboard with parent values
    if (options?.inputMap && options.inputMap.length > 0) {
      const source: BlackboardSource = {
        workflowId: subWorkflow.id,
        nodeId: '__push__',
        stackDepth: this._stack.length,
      };
      const writes: { key: string; value: unknown }[] = [];
      for (const mapping of options.inputMap) {
        const value = parentReader.get(mapping.from);
        if (value !== undefined) {
          writes.push({ key: mapping.to, value });
        }
      }
      if (writes.length > 0) {
        const newEntries = this._currentBlackboard.append(writes, source);
        this._emit('blackboard:write', {
          entries: newEntries,
          workflow: subWorkflow,
        });
      }
    }

    // Event order: workflow:push → node:enter (mirrors declarative push)
    this._emit('workflow:push', { frame, workflow: subWorkflow });

    const entryNode = subWorkflow.nodes[subWorkflow.entry]!;
    this._emit('node:enter', { node: entryNode, workflow: subWorkflow });

    return { status: 'invoked', workflow: subWorkflow, node: entryNode };
  }

  /**
   * Programmatically pop the current sub-workflow off the call stack,
   * applying the returnMap from the most recent {@link pushWorkflow} call.
   *
   * The engine returns to the **same node** it was at when pushWorkflow
   * was called — no cycle issue since this is imperative, not graph-driven.
   *
   * @throws {EngineError} If called before init(), in completed/error
   *   state, or if the stack is empty.
   */
  popWorkflow(): StepResult {
    // -- Precondition guards ------------------------------------------------
    if (
      this._currentWorkflowId === null ||
      this._currentNodeId === null ||
      this._currentBlackboard === null
    ) {
      throw new EngineError('popWorkflow() called before init()');
    }
    if (this._status !== 'running' && this._status !== 'suspended') {
      throw new EngineError(
        `popWorkflow() called in invalid state: '${this._status}' — engine must be 'running' or 'suspended'`,
      );
    }
    if (this._stack.length === 0) {
      throw new EngineError(
        'popWorkflow() called with empty stack — nothing to pop',
      );
    }

    // Capture child state and pop frame
    const childBlackboard = this._currentBlackboard;
    const frame = this._stack.shift()!;

    // Reconstruct parent blackboard from frozen snapshot
    const parentBlackboard = new ScopedBlackboard(frame.blackboard);
    const parentWorkflow = this._registry.get(frame.workflowId)!;
    const returnSource: BlackboardSource = {
      workflowId: frame.workflowId,
      nodeId: frame.currentNodeId,
      stackDepth: this._stack.length,
    };

    // Execute returnMap: copy child values → parent blackboard
    for (const mapping of frame.returnMap) {
      const childValue = childBlackboard.reader().get(mapping.childKey);
      if (childValue !== undefined) {
        const newEntries = parentBlackboard.append(
          [{ key: mapping.parentKey, value: childValue }],
          returnSource,
        );
        this._emit('blackboard:write', {
          entries: newEntries,
          workflow: parentWorkflow,
        });
      }
    }

    // Restore parent state — skip re-invocation on the next step()
    this._currentWorkflowId = frame.workflowId;
    this._currentNodeId = frame.currentNodeId;
    this._currentBlackboard = parentBlackboard;
    this._skipInvocation = true;

    const invokingNode = parentWorkflow.nodes[frame.currentNodeId]!;

    // Event order: workflow:pop → node:enter (mirrors automatic pop)
    this._emit('workflow:pop', { frame, workflow: parentWorkflow });
    this._emit('node:enter', { node: invokingNode, workflow: parentWorkflow });

    return { status: 'popped', workflow: parentWorkflow, node: invokingNode };
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  /**
   * Register an event handler. Multiple handlers per event accumulate.
   * There is no deregistration mechanism — handlers persist for the
   * engine's lifetime.
   */
  on(event: EngineEvent, handler: EventHandler): void {
    const handlers = this._handlers.get(event) ?? [];
    handlers.push(handler);
    this._handlers.set(event, handlers);
  }

  private _emit(event: EngineEvent, payload?: unknown): void {
    const handlers = this._handlers.get(event);
    if (handlers) {
      for (const handler of handlers) {
        handler(payload);
      }
    }
  }
}
