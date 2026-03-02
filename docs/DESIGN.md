# Reflex Design Document

> **Status**: Pass 3 — Formal Constraints Tightened
> **Last Updated**: 2026-02-07

Reflex is a DAG-based workflow orchestration framework with call stack composition and append-only blackboard semantics. It provides a formally characterized execution model (Type 1, context-sensitive) for building systems where structured multi-step processes are guided by LLM decision-making and human participation.

The name comes from the mirror system in SLR cameras that directs light through the correct path — Reflex directs execution flow through workflow DAGs.

---

## 1. Formal Model

### 1.1 The Abstract Machine

Reflex implements a **pushdown automaton with append-only tape**, which is equivalent to a linear-bounded automaton (Chomsky Type 1, context-sensitive).

The three primitives:

| Primitive | What It Is | Formal Role |
|---|---|---|
| **DAG Workflow** | A directed acyclic graph of nodes and edges | The program |
| **Call Stack** | LIFO stack of suspended workflow contexts | Pushdown memory |
| **Blackboard** | Append-only accumulation of key-value entries | Bounded tape |

**Why Type 1, not Type 2 or Type 0:**
- Stack alone (Type 2, context-free): each sub-workflow is self-contained, no cross-workflow context dependency
- Stack + append-only blackboard (Type 1, context-sensitive): a node's valid transitions and behavior depend on values written by nodes in *other* workflows — non-local semantic context
- Stack + mutable blackboard (Type 0, Turing-complete): full read-write tape, loss of coherence guarantees

**The design choice**: append-only blackboard is the principled ceiling. Maximal expressiveness while preserving the invariant that established context is never contradicted.

### 1.2 Formal Caveats

The Type 1 classification is **pragmatic, not mechanical**:

- **Boundedness is structural, not enforced.** Tape growth is bounded by session lifetime: individual DAGs are finite (acyclic → finite nodes → finite writes per workflow), so growth comes only from recursive invocation depth. There is no explicit tape length limit. This is a pragmatic LBA — boundedness is a consequence of structure, not a mechanical constraint.

- **Custom guards are assumed total.** A `CustomGuard.evaluate()` function is an arbitrary function over the scoped blackboard. If it loops, allocates unboundedly, or consults external mutable state, it is a backdoor to Type 0. **Custom guards must be total, terminating, and side-effect free.** Built-in guards satisfy this by construction. Custom guards carry this as a documented contract — violations break the formal ceiling.

These caveats are honest, not fatal. The formal model holds when the documented contracts are respected.

### 1.3 Computational Primitive

The fundamental operation in Reflex is the **step resolution**: given a node spec and the current blackboard state, produce outputs (blackboard writes) and determine the next transition.

This is deliberately generic. In Relica, step resolution produces Gellish fact triples. In another system, it might produce API calls, database mutations, document edits, or anything else. Reflex doesn't prescribe what steps *do* — it prescribes how they *compose*.

### 1.4 Execution Lifecycle

```
INIT: Create session, push root workflow onto stack, set node to entry point
LOOP:
  1. Read current node spec
  2. If node has invocation spec: push current frame onto stack,
     start sub-workflow at its entry point, goto LOOP
  3. Evaluate outgoing edge guards against blackboard → valid edges
  4. Present (node spec, valid edges, blackboard) to decision agent
  5. Decision agent returns one of:
     a. ADVANCE: blackboard writes + chosen edge
     b. SUSPEND: reason string (awaiting human input, external data, etc.)
     c. COMPLETE: blackboard writes (only valid at terminal nodes — enforced by engine)
  6. If ADVANCE:
     - Append writes to current workflow's local blackboard
     - Advance to target node, goto LOOP
  7. If SUSPEND:
     - Engine status becomes 'suspended'
     - Engine is resumable — consumer calls step() again when ready
  8. If COMPLETE:
     a. Append writes to current workflow's local blackboard
     b. If stack is empty: session terminates
     c. If stack has entries: execute returnMap (copy child local values
        to parent local blackboard), pop stack frame, resume parent at
        invoking node, goto LOOP (parent's normal edge logic runs)
```

**Note on invocation (step 2)**: When a node has an `invokes` spec, the sub-workflow is started automatically upon entering the node. The decision agent is NOT consulted at invocation nodes — they are pure composition points. After the sub-workflow completes and returns, the parent resumes at the invoking node, and then the normal decision loop runs (evaluate guards, present valid edges to decision agent).

**Note on COMPLETE enforcement (step 5c)**: The engine enforces that COMPLETE is only valid at terminal nodes (nodes with no outgoing edges). If the decision agent returns COMPLETE at a non-terminal node, the engine rejects it and emits an `engine:error` event. Don't trust agents — enforce structurally.

### 1.5 Acyclicity and Repetition

Individual workflows are DAGs — no cycles. This is enforced at registration time via topological sort validation.

Repetition is achieved through recursive invocation via the call stack. A workflow can invoke itself (e.g., "Define Part Physical Object" invokes "Define Physical Object" recursively).

This is a deliberate constraint: it keeps individual workflows analyzable and ensures that all looping behavior is visible in the call stack, not hidden in graph cycles.

### 1.6 Inspectability: Traces and Intent

Reflex workflows serve as both **execution traces** and **proofs of intent**:

- **Execution traces** (v-alpha): The append-only blackboard + event emission provides a complete record of what happened during a session — every write, every transition, every push/pop. This is free by construction.

- **Proofs of intent** (v1.0): The workflow definition itself is a declaration of what SHOULD happen. Node contracts (declared inputs/outputs, Section 6.1) enable static verification at registration time — you can reason about workflow properties *without running them*. Future additions (edge exhaustiveness checks, returnMap completeness) extend this further.

The v-alpha delivers traces. V1.0 builds toward intent verification via node contracts. The architecture supports both because the formal model is sound — the workflow definition IS the program.

---

## 2. Core Types

### 2.1 Workflow Definition

```typescript
interface Workflow {
  id: string;
  entry: string;                      // ID of the entry node
  nodes: Record<string, Node>;        // Dictionary: node ID → node definition
  edges: Edge[];
  metadata?: Record<string, unknown>;
}
```

`Record<string, Node>` is a dictionary/object where the keys are node ID strings and the values are `Node` definitions. Example:
```typescript
{
  "BD":       { id: "BD", spec: { ... } },
  "SpecComp": { id: "SpecComp", spec: { ... } }
}
```

### 2.2 Node

```typescript
interface Node {
  id: string;
  description?: string;
  spec: NodeSpec;                      // Domain-specific — opaque to Reflex
  invokes?: InvocationSpec;            // If present, this is a composition point
}
```

### 2.3 NodeSpec

```typescript
interface NodeSpec {
  [key: string]: unknown;
}
```

NodeSpec is **opaque to Reflex**. It is a bag of domain-specific data that Reflex carries but never inspects. The decision agent receives it and knows how to interpret it.

Think of it as metadata/instructions for the decision agent. Reflex's relationship to NodeSpec is: "I carry it, I don't read it."

**Relica example** — a NodeSpec for a semantic modeling step:
```typescript
{
  match: ['1.Supertype Concept? > 1146.is a specialization of > 730044.Physical Object?'],
  create: ['2.New Concept? > 1146.is a specialization of > 1.Supertype Concept?'],
  fieldSources: [
    { field: 'New Concept', source: 'context' },
    { field: 'Supertype Concept', source: 'knowledge-graph' },
  ]
}
```

**Chatbot example** — a NodeSpec for a conversational step:
```typescript
{
  prompt: "Summarize the user's request",
  model: "claude-opus-4-6",
  outputKey: "summary"
}
```

Reflex treats both identically — passes them to the decision agent without interpretation.

### 2.4 InvocationSpec

```typescript
interface InvocationSpec {
  workflowId: string;                  // Which sub-workflow to invoke
  returnMap: ReturnMapping[];          // How to propagate results back to parent
}
```

When a node has an `invokes` spec, entering that node automatically starts the sub-workflow. The current workflow is pushed onto the stack. When the sub-workflow completes, the `returnMap` specifies which of the child's local blackboard values get copied into the parent's local blackboard.

The child does NOT need values explicitly passed down — it can read ancestor blackboards via the scoped blackboard reader (see Section 2.7).

### 2.5 ReturnMapping

```typescript
interface ReturnMapping {
  parentKey: string;                   // Key to write in parent's local blackboard
  childKey: string;                    // Key to read from child's local blackboard
}
```

**Example**: `{ parentKey: 'Part Object', childKey: 'New Concept' }`

When the sub-workflow completes:
1. Read the child's local blackboard value for `'New Concept'`
2. Append it to the parent's local blackboard as `'Part Object'`

This is how sub-workflow results flow back to the parent — like a function return value. Values flow down automatically via scoped reads (child can see ancestor state); values flow up explicitly via returnMaps.

**Design note — read widely, return narrowly**: Children can implicitly read all ancestor state but can only pass values back through explicit returnMaps. This asymmetry is intentional — it encourages workflows to be broad consumers but narrow producers, making data flow traceable and predictable.

### 2.6 Edge

```typescript
interface Edge {
  id: string;
  from: string;                        // Source node ID
  to: string;                          // Target node ID
  event: string;                       // Named transition (e.g., 'NEXT', 'DEFINE_PART')
  guard?: Guard;                       // Optional — if absent, edge is always valid
}
```

A node can have multiple outgoing edges (fan-out / decision points) and multiple incoming edges (fan-in / convergence). At fan-out points, guards filter which edges are valid, and the decision agent picks from the valid set.

### 2.7 Blackboard

Each workflow on the stack has its own **local blackboard** — an append-only log of key-value entries scoped to that workflow instance. Writes always go to the current workflow's local blackboard.

Reads use **lexical scoping with precedence**: the BlackboardReader walks the stack from current workflow → parent → grandparent, returning the first match. Local values shadow ancestor values.

```typescript
interface BlackboardEntry {
  key: string;
  value: unknown;                      // Untyped for v-alpha — consumers cast
  source: BlackboardSource;
  timestamp: number;
}

interface BlackboardSource {
  workflowId: string;
  nodeId: string;
  stackDepth: number;
}
```

**Append-only invariant**: entries are never deleted or mutated. A new entry for an existing key shadows the previous entry (latest-wins within the same scope). The full history is always preserved. This is analogous to event sourcing and immutable data structures.

**Scoped read semantics**:
```
Write:  always to current workflow's local blackboard
Read:   walk the stack — local → parent → grandparent → ...
        first match wins (most local scope takes precedence)
```

When a sub-workflow pops off the stack, its local blackboard disappears — like local variables going out of scope. Values survive only if explicitly promoted to the parent via returnMap.

### 2.8 Guards

```typescript
type Guard = BuiltinGuard | CustomGuard;

interface BuiltinGuard {
  type: 'exists' | 'equals' | 'not-exists' | 'not-equals';
  key: string;                         // Blackboard key to check
  value?: unknown;                     // For equals/not-equals
}

interface CustomGuard {
  type: 'custom';
  evaluate: (blackboard: BlackboardReader) => boolean;
}
```

Guards are evaluated against the scoped blackboard (full scope chain). Built-in guards cover common cases; custom guards allow arbitrary logic. An edge with no guard is always valid.

**Numeric-aware equality**: The `equals` and `not-equals` guards use numeric-aware comparison: `int(5)` equals `float64(5.0)`. This ensures guards evaluate correctly after JSON round-trips where all numbers become `float64`. Non-numeric types use strict equality (`reflect.DeepEqual` in Go, `===` in TypeScript).

**Formal contract for custom guards**: Custom guard functions must be **total, terminating, and side-effect free**. They receive a read-only blackboard view and return a boolean. Violations of this contract (infinite loops, external state mutation, I/O) break the Type 1 formal ceiling. Built-in guards satisfy this contract by construction.

### 2.9 Call Stack

```typescript
interface StackFrame {
  workflowId: string;
  currentNodeId: string;               // The invoking node to resume at
  returnMap: ReturnMapping[];          // What to copy back on child completion
  blackboard: BlackboardEntry[];       // This workflow's local blackboard
}
```

The stack frame captures everything needed to resume a suspended workflow after a sub-workflow completes. On pop:
1. Execute returnMap (copy child values → parent blackboard)
2. Discard child's local blackboard
3. Resume parent at the invoking node
4. Normal edge logic runs from there

### 2.10 Decision Agent

```typescript
interface DecisionAgent {
  resolve(context: DecisionContext): Promise<Decision>;
}

interface DecisionContext {
  workflow: Workflow;
  node: Node;                          // Current node (includes opaque spec)
  blackboard: BlackboardReader;        // Scoped view: local → parent → ...
  validEdges: Edge[];                  // Edges whose guards passed
  stack: ReadonlyArray<StackFrame>;    // Current call stack (read-only)
}

type Decision =
  | { type: 'advance'; edge: string; writes?: BlackboardWrite[] }
  | { type: 'suspend'; reason: string }
  | { type: 'complete'; writes?: BlackboardWrite[] };

interface BlackboardWrite {
  key: string;
  value: unknown;
}
```

**`advance`**: Pick an edge from `validEdges`, optionally write to local blackboard, advance to the target node.

**`suspend`**: The decision agent cannot resolve right now — awaiting human input, external data, async computation, etc. The engine suspends and is resumable. This is a normal operational state, not an error.

**`complete`**: Only valid at terminal nodes (no outgoing edges). **Enforced by the engine** — if the agent returns `complete` at a non-terminal node, the engine rejects it and emits `engine:error`. Optionally write final values to local blackboard, then trigger stack pop and returnMap execution.

The decision agent is called at every non-invocation node. Invocation nodes (nodes with `invokes` spec) are handled automatically by the engine — the decision agent is not consulted.

### 2.11 Blackboard Reader

```typescript
interface BlackboardReader {
  get(key: string): unknown | undefined;       // Latest value, scoped lookup
  has(key: string): boolean;                    // Key exists in any scope
  getAll(key: string): BlackboardEntry[];       // Full history for key across all scopes
  entries(): BlackboardEntry[];                 // All entries across all scopes
  keys(): string[];                             // All unique keys across all scopes
  local(): BlackboardEntry[];                   // Only current workflow's entries
}
```

The reader provides a unified view over the scope chain. `get()` and `has()` walk local → parent → grandparent. `local()` returns only the current workflow's entries for cases where scope distinction matters.

**Note on `getAll()`**: Returns the full history for a key across all scopes, including shadowed entries. An entry from a grandparent that was shadowed by a parent entry is still present in the result. Entries are ordered from most-local to least-local scope.

---

## 3. Runtime

### 3.1 Components

```
┌─────────────────────────────────────────────────┐
│                  Reflex Runtime                  │
│                                                  │
│  ┌──────────┐  ┌──────────┐  ┌───────────────┐  │
│  │ Workflow  │  │  Call     │  │  Scoped       │  │
│  │ Registry  │  │  Stack    │  │  Blackboards  │  │
│  └────┬─────┘  └────┬─────┘  └───────┬───────┘  │
│       │              │                │          │
│       └──────────────┼────────────────┘          │
│                      │                           │
│              ┌───────┴────────┐                  │
│              │  Execution     │                  │
│              │  Engine        │                  │
│              └───────┬────────┘                  │
│                      │                           │
└──────────────────────┼───────────────────────────┘
                       │
            ┌──────────┴──────────┐
            │   Decision Agent    │  ← Extension point
            │  (LLM / Human /    │
            │   Rule / Hybrid)   │
            └─────────────────────┘
```

### 3.2 Execution Engine

```typescript
interface ReflexEngine {
  // Lifecycle
  init(workflowId: string): Promise<string>;  // Returns sessionId
  step(): Promise<StepResult>;                 // One iteration of the loop
  run(): Promise<RunResult>;                   // Step until completion or suspension

  // State inspection
  sessionId(): string;
  currentNode(): Node | null;
  currentWorkflow(): Workflow | null;
  blackboard(): BlackboardReader;              // Scoped view
  stack(): ReadonlyArray<StackFrame>;
  validEdges(): Edge[];

  // Events
  on(event: EngineEvent, handler: EventHandler): void;
}

type StepResult =
  | { status: 'advanced'; node: Node }
  | { status: 'invoked'; workflow: Workflow; node: Node }
  | { status: 'popped'; workflow: Workflow; node: Node }
  | { status: 'completed' }
  | { status: 'suspended'; reason: string };

type EngineEvent =
  | 'node:enter'
  | 'node:exit'
  | 'edge:traverse'
  | 'workflow:push'
  | 'workflow:pop'
  | 'blackboard:write'
  | 'engine:complete'
  | 'engine:suspend'
  | 'engine:error';
```

**Event ordering**: Events are emitted synchronously in deterministic order during each step. For a typical advance step: `node:exit` → `edge:traverse` → `blackboard:write` (if writes) → `node:enter`. For invocation: `node:enter` → `workflow:push`. For pop: `workflow:pop` → `node:enter` (at parent's invoking node). Persistence adapters can rely on this ordering.

### 3.3 Workflow Registry

```typescript
interface WorkflowRegistry {
  register(workflow: Workflow): void;  // Validates DAG + node refs on registration
  get(id: string): Workflow | undefined;
  has(id: string): boolean;
  list(): string[];
}
```

**Registration-time validation**:
1. **Acyclicity**: Topological sort — reject if cycle detected
2. **Edge integrity**: All edge `from`/`to` reference existing node IDs
3. **Entry node**: The declared entry node exists in the nodes dict
4. **Terminal nodes**: At least one node has no outgoing edges
5. **Invocation refs**: Warn if `invokes.workflowId` references an unregistered workflow (not a hard error — the target may be registered later)

### 3.4 Error Handling

Errors are trapped at the node level. The engine does not attempt recovery — it emits an error event and suspends. The consumer is responsible for handling the situation.

```typescript
// On decision agent failure, guard evaluation failure, or missing workflow:
// 1. Engine catches the error
// 2. Emits 'engine:error' event with error details and current state
// 3. Engine status becomes 'suspended'
// 4. Consumer's error handler decides: retry, skip, abort, etc.
```

This pairs with upfront validation (Section 3.3) — structural problems are caught at registration time, so runtime errors are limited to decision agent failures and unexpected conditions.

**Error vs suspension**: An `engine:error` is an unexpected failure (agent threw, guard threw, missing workflow at runtime). An `engine:suspend` is a normal operational state (agent returned `suspend`, awaiting human/external input). These are distinct events — don't conflate "I can't decide yet" with "something broke."

---

## 4. Extension Points

Reflex has four primary extension points. Consumers MUST provide a decision agent. Everything else has sensible defaults.

### 4.1 Decision Agent (required)

The decision agent is called at every non-invocation node to determine what happens next. This is where the LLM, human UI, rule engine, or any combination plugs in.

Reflex provides no default decision agent — this is the consumer's core responsibility.

**Examples:**
- **Relica**: LLM evaluates Gellish patterns, human approves semantic assertions
- **Generic chatbot**: LLM picks the next conversational step
- **Approval workflow**: Human selects from available transitions
- **Automated pipeline**: Rule-based agent follows deterministic logic

### 4.2 Guard Evaluator (optional)

Built-in guards (`exists`, `equals`, `not-exists`, `not-equals`) are evaluated by Reflex natively against the scoped blackboard. Custom guards provide an `evaluate` function subject to the totality contract (see Section 2.8).

### 4.3 Persistence Adapter (optional)

By default, Reflex is in-memory only. Consumers can provide a persistence adapter to save/restore engine state.

```typescript
interface PersistenceAdapter {
  save(sessionId: string, state: EngineState): Promise<void>;
  load(sessionId: string): Promise<EngineState | null>;
}
```

### 4.4 Event Handlers (optional)

The engine emits events at each lifecycle point in deterministic order (see Section 3.2). Consumers can subscribe for logging, metrics, UI updates, side effects, etc.

---

## 5. Boundaries

### What Reflex IS

- A DAG execution engine with call stack composition
- Scoped append-only blackboards with lexical (stack-based) read precedence
- A guard mechanism for context-sensitive transition filtering
- A pluggable decision agent interface
- A formally characterized computational model (Type 1, with documented caveats)

### What Reflex is NOT

- A state machine library (no cycles, no event-driven reactive model)
- A BPMN engine (no parallel execution — by design, not limitation — no compensation, no timers)
- An LLM framework (no prompt management, no model integration)
- A UI framework (no rendering, no components)
- A persistence layer (no database, no ORM)
- A general-purpose workflow tool (deliberately constrained to Type 1)

### The Append-Only Invariant

Each workflow's local blackboard is append-only. This is not a limitation — it is a design principle.

- New entries can shadow earlier entries for the same key (latest-wins within scope)
- The full history is always preserved
- No entry is ever deleted or mutated
- This preserves semantic coherence: established context is never contradicted, only superseded
- When a workflow pops off the stack, its local entries are discarded (unless promoted via returnMap)

This is analogous to event sourcing, append-only ledgers, and immutable data structures. The invariant is what keeps the system at Type 1 rather than sliding to Type 0.

---

## 6. Scope and Future Work

### 6.1 Planned for V1.0

The following items from v-alpha's deferred list are now planned for v1.0 (see [ROADMAP-v1.md](ROADMAP-v1.md)):

- **Declarative workflows** (M7): JSON schema for workflow definitions, loader with validation, cross-language portability (same JSON loadable by TS and Go)
- **Node contracts** (M8): Input/output declarations on nodes — which blackboard keys a node reads/writes. Static verification at registration time catches wiring errors before execution. This is the path toward workflows as proofs of intent (see Section 1.6)
- **Persistence** (M9): Serializable engine snapshots for save/restore across process boundaries. Enables real human-in-the-loop workflows that span hours or days
- **ReturnMap verification** (partial, M8-2): Static check that returnMap target keys appear in sub-workflow terminal nodes' declared outputs

### 6.2 Permanently Out of Scope

These are deliberate non-goals of the Reflex engine — not deferred, but excluded by design:

- **Parallel execution / fork-join**: Excluded by design — see Section 7 for the full rationale. Consumers who need concurrency handle it in their agent or application code.
- **Built-in decision agents**: Reflex provides the interface, not implementations. LLM agents, rule engines, human UIs — these are consumer concerns.
- **Built-in persistence adapters**: Reflex defines the snapshot format and adapter interface. Consumers provide their own storage (file, database, etc.).
- **Distributed execution**: Engine instances across processes or machines. Reflex is a single-process, single-session engine.

### 6.3 Deferred (Post-V1.0)

The following remain interesting but are not planned for v1.0:

- **Typed blackboard values**: Runtime schema validation on blackboard entries
- **Edge exhaustiveness checks**: Static verification that all possible blackboard states at a fan-out point are covered by guards
- **Parent-to-child value passing**: Explicit push of specific parent values into child scope on invocation (currently unnecessary because child can read parent scope via the scope chain)
- **Hot-reload workflows**: Swap workflow definition mid-execution

---

## 7. Design Rationale: The Single-Thread Invariant

Reflex deliberately excludes parallel execution (fork/join). This is not a limitation to be solved later — it is a design principle that preserves the formal properties described in Section 1.

### 7.1 The Formal Argument

Reflex implements a pushdown automaton with a **single program counter**. At any point during execution, exactly one node is active, exactly one step resolution is in progress, and exactly one transition is being evaluated. This is the single-thread invariant.

Fork/join would require **multiple simultaneous program counters** — several nodes active at once, each producing blackboard writes independently. This changes the system in three ways:

1. **"Step" becomes ambiguous.** With one program counter, `step()` means "advance the single active node and resolve the next transition." With concurrent branches, `step()` must either advance all branches (losing per-node granularity) or advance one branch (requiring a scheduler, introducing nondeterminism in execution order).

2. **The deterministic trace property breaks.** With serial execution, the sequence of events (`node:enter`, `blackboard:write`, `node:exit`) is fully determined by the workflow graph and decision agent responses. With concurrent branches, the interleaving of events across branches depends on scheduling — the same inputs can produce different event orderings.

3. **Blackboard coherence degrades.** The append-only blackboard's guarantee — that established context is never contradicted, only superseded — depends on a total ordering of writes. Concurrent branches writing to the same key create an ordering ambiguity: which write is "later"? Resolving this requires either a conflict resolution policy (complexity) or isolated branch-local blackboards (breaking the shared-context model that makes Reflex context-sensitive).

### 7.2 The Practical Consequence

Consumers who need concurrent execution have two clean options:

- **Concurrency in the agent.** The decision agent can spawn parallel work internally (HTTP requests, LLM calls, database queries) and return a single decision. The engine sees a single synchronous step; the parallelism is invisible to the formal model.

- **Concurrency above the engine.** Run multiple independent engine instances in parallel, each with its own workflow and blackboard. Coordinate results in application code. This preserves the per-engine formal properties while allowing system-level parallelism.

Both approaches keep the engine's formal model intact. Reflex orchestrates the sequential decision path — the consumer decides where parallelism lives.

---

## Appendix A: Mapping to Recovered Code

How the recovered clarity-core implementation maps to this design:

| Recovered Code | Reflex Concept |
|---|---|
| `WorkflowManager` | Engine + per-workflow state |
| `ModellingService._stack` | Call Stack |
| `ModellingService._fieldMapStack` | `StackFrame.returnMap` |
| `WorkflowManager._context` | Local blackboard (mutable in original — append-only in Reflex) |
| `WorkflowManager.fuckit()` | Step resolver (part of Decision Agent in Reflex) |
| `workflowDefs` / `PhysObjMachine` etc. | Workflow Registry entries |
| `stepDefs` / state specs (`BD.ts`, `SpecComp.ts`) | `Node.spec` (domain-specific, opaque to Reflex) |
| XState `createMachine`/`createActor` | Replaced by Reflex's own DAG execution |
| `ModellingService.branchWorkflow()` | Engine stack push (automatic on entering invocation node) |
| `ModellingService.endWorkflow()` | Engine stack pop + returnMap execution |
| `modelling.controller.ts` REST endpoints | Not Reflex's concern (consumer provides API surface) |
| `TempUIDManager` | Not Reflex's concern (consumer manages domain IDs) |
| `ModellingSession` entity | `PersistenceAdapter` extension point |

**Key improvements over recovered code:**
- Blackboard is append-only (was mutable)
- Scoped reads with precedence (was workflow-local only, no ancestor visibility)
- Guards on edges (did not exist)
- DAG validation at registration (did not exist)
- Invocation is automatic on node entry (was triggered by XState entry actions)
- Engine is framework-agnostic (was NestJS-coupled)
- Suspension is a first-class decision type (was not modeled)

## Appendix B: Relation to the Paper

| Paper Concept | Reflex Implementation |
|---|---|
| DAG workflows as computational units | `Workflow` type: nodes + edges + entry |
| Composability via call stack | `StackFrame[]` + push/pop in engine loop |
| The semantic blackboard | Scoped local blackboards with append-only invariant |
| Context-sensitive transitions | `Guard` on edges evaluated against scoped blackboard |
| LLM as decision engine | `DecisionAgent.resolve()` — pluggable |
| Human as co-computational agent | `Decision.suspend` — first-class "awaiting human" state |
| Append-only boundary (Type 1 ceiling) | Local blackboards — never mutated, only appended |
| Formal expressiveness (Type 1) | Stack (Type 2) + scoped blackboard reads in guards (→ Type 1) |
| Non-local context dependency | Child nodes read ancestor blackboard values via scope chain |
| Pragmatic LBA | Structural boundedness (finite DAGs, append-only) — see Section 1.2 |
