# Reflex

DAG-based workflow orchestration with call stack composition and append-only blackboard semantics.

Reflex provides a formally characterized execution model (Chomsky Type 1, context-sensitive) for building systems where structured multi-step processes are guided by LLM decision-making and human participation. It sits between raw LLM tool-calling chaos and over-engineered BPMN/statechart frameworks — constrained enough to reason about, expressive enough to let intelligence live outside the engine.

> The name comes from the mirror system in SLR cameras that directs light through the correct path.

## Implementations

| Language | Directory | Package | Status |
|----------|-----------|---------|--------|
| TypeScript | [`typescript/`](typescript/) | `@corpus-relica/reflex` | v0.5.0 — 364 tests, ESM + CJS |
| Go | [`go/`](go/) | `github.com/corpus-relica/reflex/go` | v0.3.0 — 158 tests, stdlib only, zero dependencies |

Both implementations conform to the shared [DESIGN.md](docs/DESIGN.md) specification. They are independent codebases targeting the same formal model.

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

Reflex implements a pushdown automaton with append-only tape — equivalent to a linear-bounded automaton (Type 1, context-sensitive). The append-only constraint is the principled ceiling: maximal expressiveness while preserving the invariant that established context is never contradicted. See [DESIGN.md](docs/DESIGN.md) Section 1 for the formal model and its caveats.

## Documentation

- [DESIGN.md](docs/DESIGN.md) — Formal model, core types, runtime architecture, extension points, boundaries
- [ROADMAP-v1.md](docs/ROADMAP-v1.md) — V1.0 roadmap (4 milestones, 12 issues: declarative workflows, node contracts, persistence, API stabilization)
- [ROADMAP-v-alpha.md](docs/ROADMAP-v-alpha.md) — V-alpha implementation plan (6 milestones, 24 issues) — completed

## License

MIT — see [LICENSE](LICENSE)
