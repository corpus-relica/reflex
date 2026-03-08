# Reflex — TypeScript

TypeScript implementation of the Reflex engine. See the [project root](../) for an overview and [DESIGN.md](../docs/DESIGN.md) for the formal specification.

## Install

```bash
npm install @corpus-relica/reflex
```

## Quick Start

```typescript
import {
  createRegistry,
  createEngine,
  type Workflow,
  type DecisionAgent,
  type DecisionContext,
  type Decision,
} from '@corpus-relica/reflex';

// 1. Define a workflow
const workflow: Workflow = {
  id: 'greeting',
  entry: 'ASK',
  nodes: {
    ASK:    { id: 'ASK',    spec: { prompt: 'What is your name?' } },
    GREET:  { id: 'GREET',  spec: { prompt: 'Say hello' } },
    DONE:   { id: 'DONE',   spec: {} },
  },
  edges: [
    { id: 'e1', from: 'ASK',   to: 'GREET', event: 'NEXT' },
    { id: 'e2', from: 'GREET', to: 'DONE',  event: 'NEXT' },
  ],
};

// 2. Implement a decision agent
const agent: DecisionAgent = {
  async resolve(ctx: DecisionContext): Promise<Decision> {
    const nodeId = ctx.node.id;

    if (nodeId === 'ASK') {
      return {
        type: 'advance',
        edge: 'e1',
        writes: [{ key: 'name', value: 'World' }],
      };
    }

    if (nodeId === 'GREET') {
      const name = ctx.blackboard.get('name');
      return {
        type: 'advance',
        edge: 'e2',
        writes: [{ key: 'greeting', value: `Hello, ${name}!` }],
      };
    }

    // Terminal node — complete the workflow
    return { type: 'complete' };
  },
};

// 3. Run the engine
const registry = createRegistry();
registry.register(workflow);

const engine = createEngine(registry, agent);
await engine.init('greeting');
const result = await engine.run();

console.log(result.status);                  // 'completed'
console.log(engine.blackboard().get('greeting')); // 'Hello, World!'
```

## Core Concepts

**DAG Workflows** — Directed acyclic graphs of nodes and edges. No cycles — repetition happens through recursive sub-workflow invocation, keeping loops visible in the call stack rather than hidden in graph structure.

**Call Stack** — Workflows can invoke sub-workflows at composition nodes. The parent is pushed onto a LIFO stack and resumed when the child completes. Like function calls, but for workflows.

**Scoped Blackboard** — Each workflow has a local append-only blackboard. Writes are always local. Reads walk the scope chain (local → parent → grandparent), so child workflows can see ancestor context without explicit parameter passing. Values flow back up via explicit return maps.

**Guards** — Edges can have guard conditions evaluated against the scoped blackboard. At fan-out points, guards filter which transitions are valid, and the decision agent picks from the valid set. This is what makes the system context-sensitive — transitions depend on non-local state.

**Decision Agent** — The pluggable core. At each non-invocation node, the engine calls the decision agent with the current node spec, valid edges, and scoped blackboard. The agent returns one of: advance (pick an edge), suspend (await external input), or complete (at terminal nodes only). Reflex provides no default agent — this is where LLM reasoning, human judgment, rule engines, or any combination plugs in.

## Architecture

```
┌─────────────────────────────────────────────────┐
│                  Reflex Runtime                  │
│                                                  │
│  ┌──────────┐  ┌──────────┐  ┌───────────────┐  │
│  │ Workflow  │  │  Call     │  │  Scoped       │  │
│  │ Registry  │  │  Stack    │  │  Blackboards  │  │
│  └──────────┘  └──────────┘  └───────────────┘  │
│                      │                           │
│              ┌───────┴────────┐                  │
│              │  Execution     │                  │
│              │  Engine        │                  │
│              └───────┬────────┘                  │
└──────────────────────┼───────────────────────────┘
                       │
            ┌──────────┴──────────┐
            │   Decision Agent    │  ← You provide this
            └─────────────────────┘
```

## What Reflex Is / Is Not

**Is**: A DAG execution engine, a scoped append-only blackboard, a guard mechanism, a pluggable decision agent interface, a formally characterized computational model.

**Is not**: A state machine library, a BPMN engine, an LLM framework, a UI framework, a persistence layer, a general-purpose workflow tool.

## Formal Properties

Reflex implements a pushdown automaton with append-only tape — equivalent to a linear-bounded automaton (Type 1, context-sensitive). The append-only constraint is the principled ceiling: maximal expressiveness while preserving the invariant that established context is never contradicted. See [DESIGN.md](../docs/DESIGN.md) Section 1 for the formal model and its caveats.

## API Reference

### Factory Functions

```typescript
createRegistry(): WorkflowRegistry
```

Create a workflow registry. Register workflows before creating an engine.

```typescript
createEngine(registry: WorkflowRegistry, agent: DecisionAgent, options?: EngineOptions): ReflexEngine
```

Create an engine bound to a registry and decision agent.

### Types

**Workflow definition** — `Workflow`, `Node`, `NodeSpec`, `Edge`, `InvocationSpec`, `ReturnMapping`, `Guard`, `BuiltinGuard`, `CustomGuard`

**Decision agent** — `DecisionAgent`, `DecisionContext`, `Decision`, `BlackboardReader`, `BlackboardWrite`, `BlackboardEntry`, `BlackboardSource`

**Cursor API** — `Cursor`, `CursorReader`

**Engine results** — `StepResult`, `RunResult`, `EngineEvent`, `EngineStatus`, `EventHandler`, `StackFrame`

**Errors** — `WorkflowValidationError`, `ValidationErrorCode`, `EngineError`

See [DESIGN.md](../docs/DESIGN.md) for complete type definitions and semantics.

## Streaming Persistence

Use `currentBlackboard()` with cursors for efficient incremental persistence.
Only new entries since the last read are returned — no duplicates, no re-scanning.

```typescript
const engine = createEngine(registry, agent);
await engine.init('my-workflow');

// Start cursor at position 0
let cur = engine.currentBlackboard()!.cursor();

while (true) {
  const result = await engine.step();

  // Read only entries added since last step
  const [entries, next] = engine.currentBlackboard()!.entriesFrom(cur);
  for (const e of entries) {
    // Append to NDJSON log, database, etc.
    console.log(`${e.key} = ${e.value} (from ${e.source.nodeId})`);
  }
  cur = next;

  if (result.status === 'completed') break;
}
```

**`blackboard()` vs `currentBlackboard()`**: `blackboard()` returns a `BlackboardReader` that walks the full scope chain (local → parent → grandparent). `currentBlackboard()` returns a `CursorReader` for the current workflow's blackboard. Use `blackboard()` in agents for scoped reads; use `currentBlackboard()` in persistence layers for incremental writes.

## Status

**v1.3.0** — 407 tests passing. ESM + CJS dual output. Stable public API.

## Documentation

- [DESIGN.md](../docs/DESIGN.md) — Formal model, core types, runtime architecture, extension points, boundaries
- [MIGRATION-v1.md](../docs/MIGRATION-v1.md) — Upgrade guide from v0.x to v1.0
- [ROADMAP-v-alpha.md](../docs/ROADMAP-v-alpha.md) — V-alpha implementation plan (6 milestones, 24 issues) — completed

## License

MIT — see [LICENSE](../LICENSE)

## Changelog

**v1.3.0** — `stack:unwind` event: `unwindToDepth` now emits a dedicated event with discarded frames, target depth, restored workflow/node, and reinvoke flag. Devtools and listeners can stay in sync with stack mutations. 407 tests.

**v1.2.0** — `unwindToDepth(n, { reinvoke: true })`: optional reinvoke flag causes the restored invocation node to re-trigger its sub-workflow instead of advancing past it. Backward compatible. 400 tests.

**v1.1.0** — `engine.unwindToDepth(n)`: multi-level stack unwinding primitive. Discards all stack frames above depth N without processing returnMaps, agent callbacks, or events. Designed for breadcrumb-style navigation in dialogue systems. Only callable when suspended; `n === stack.length` is a no-op. 396 tests.

**v1.0.0** — First stable release. Public API locked — breaking changes require a major version bump. All M7–M10 milestones complete: declarative workflows (`loadWorkflow`, `serializeWorkflow`, JSON Schema), node contracts (`inputs`/`outputs` on nodes, `registry.verify()`), persistence (`engine.snapshot()`, `restoreEngine()`), cursor API (`currentBlackboard()`, `entriesFrom()`). JSDoc on all public symbols. 380 tests. See [MIGRATION-v1.md](../docs/MIGRATION-v1.md) for the upgrade guide.

**v0.6.1** — Bug fix: `Decision.Writes` on suspend are now applied to the blackboard (previously silently dropped). `blackboard:write` event emitted before `engine:suspend`. 380 tests.

**v0.6.0** — Cursor API for streaming persistence: `Cursor` type, `CursorReader` interface, `ScopedBlackboard.cursor()` and `entriesFrom()`, `engine.currentBlackboard()` returning read-only `CursorReader`. 377 tests.

**v0.5.0** — Persistence: `engine.snapshot()` for serializable state capture, `restoreEngine()` for hydration from snapshots, `PersistenceAdapter` interface. 364 tests.

**v0.4.0** — Custom guards: `GuardRegistry` for user-defined guard functions, `filterEdges()` with pluggable evaluation. 320 tests.

**v0.3.0** — Declarative workflows: JSON schema definition, `loadWorkflow()` for loading workflows from JSON, `serializeWorkflow()` for round-trip serialization. Custom guard registry, cross-implementation fixture validation. 284 tests.

**v0.2.1** — Entry node event fix: `init()` now emits `node:enter` for the entry node, ensuring every visited node has a matching enter/exit pair. 240 tests.

**v0.2.0** — Seed blackboard support: `init(workflowId, { blackboard: [...] })` pre-seeds the root blackboard before the first step. `InitOptions` type exported. 237 tests.

**v0.1.0** — Initial release. DAG validation, scoped append-only blackboard, built-in + custom guards, execution engine with call stack composition, event system, suspend/resume. 231 tests.
