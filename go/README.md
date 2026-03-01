# Reflex Go

Go implementation of the [Reflex](../) DAG workflow engine, conforming to the shared [DESIGN.md](../docs/DESIGN.md) specification.

## Install

```bash
go get github.com/corpus-relica/reflex/go
```

Requires Go 1.22+. Zero external dependencies (stdlib only).

## Quick Start

```go
package main

import (
    "context"
    "fmt"

    reflex "github.com/corpus-relica/reflex/go"
    "github.com/corpus-relica/reflex/go/examples"
)

func main() {
    // 1. Create a registry and register workflows
    registry := reflex.CreateRegistry()
    registry.Register(examples.LinearWorkflow("my-workflow"))

    // 2. Create a decision agent
    agent := examples.NewRuleAgent()

    // 3. Create and initialize the engine
    engine := reflex.CreateEngine(registry, agent)
    sessionID, _ := engine.Init("my-workflow")
    fmt.Println("Session:", sessionID)

    // 4. Run to completion
    result, _ := engine.Run(context.Background())
    fmt.Println("Status:", result.Status) // "completed"
}
```

## Core Concepts

Reflex implements a **pushdown automaton with append-only tape** — formally a Type 1 (context-sensitive) computation model.

| Concept | Go Type | Description |
|---------|---------|-------------|
| **Workflow** | `*Workflow` | DAG of nodes and edges — the program |
| **Node** | `*Node` | A step with an opaque `NodeSpec` |
| **Edge** | `Edge` | Directed connection with optional guard |
| **Guard** | `Guard` interface | Condition evaluated against the blackboard |
| **Blackboard** | `BlackboardReader` | Scoped, append-only key-value state |
| **Decision Agent** | `DecisionAgent` interface | Pluggable logic that drives execution |
| **Call Stack** | `[]StackFrame` | Enables sub-workflow composition |

### DecisionAgent Interface

The only extension point you must implement:

```go
type DecisionAgent interface {
    Resolve(ctx context.Context, dc DecisionContext) (Decision, error)
}
```

Returns one of three decisions:
- **Advance** — pick an edge, optionally write to blackboard
- **Suspend** — pause execution (resumable via next `Step()` call)
- **Complete** — finish the workflow (only valid at terminal nodes)

### BlackboardReader Interface

Read-only access to the scoped blackboard (local → parent → grandparent):

```go
type BlackboardReader interface {
    Get(key string) (any, bool)
    Has(key string) bool
    GetAll(key string) []BlackboardEntry
    Entries() []BlackboardEntry
    Keys() []string
    Local() []BlackboardEntry
}
```

### Built-in Guards

```go
&BuiltinGuard{Type: GuardExists, Key: "my_key"}
&BuiltinGuard{Type: GuardNotExists, Key: "my_key"}
&BuiltinGuard{Type: GuardEquals, Key: "my_key", Value: "expected"}
&BuiltinGuard{Type: GuardNotEquals, Key: "my_key", Value: "unexpected"}
```

`equals` and `not-equals` use numeric-aware comparison: `int(5)` matches `float64(5.0)`. This handles JSON round-trips where numbers become `float64`. Non-numeric types use `reflect.DeepEqual`.

### Type-Safe Blackboard Access

Package-level helpers for safe type extraction from `BlackboardReader`:

```go
name, ok := reflex.BBString(bb, "name")     // string
flag, ok := reflex.BBBool(bb, "active")      // bool
score, ok := reflex.BBFloat(bb, "score")     // float64 (handles int, json.Number)
count, ok := reflex.BBInt(bb, "count")       // int (handles float64 from JSON)
```

These handle the common issue where `encoding/json` converts all numbers to `float64`.

## Examples

See the [`examples/`](./examples/) directory:

### Rule Agent (simple)
- **`rule_agent.go`** — Deterministic agent that reads spec fields to decide
- **`workflows.go`** — Reusable workflow definitions (linear, branching, parent-child, suspension)
- **`e2e_test.go`** — End-to-end integration tests
- **`suspension_test.go`** — Suspension and resumption patterns

### Dungeon Crawler (advanced)
Go port of [reflex-dungeon](https://github.com/corpus-relica/reflex-dungeon) — an interactive dungeon crawler demonstrating advanced features:

- **`dungeon.go`** — 3 interconnected workflows (dungeon-crawl root + combat/puzzle sub-workflows)
- **`dungeon_agent.go`** — `DungeonAgent` with `SetChoice()` for programmatic play
- **`dungeon_test.go`** — 9 tests: victory path, escape path, blackboard seals, combat, puzzle, events

Features demonstrated: sub-workflow invocation with ReturnMap, scoped blackboard reads (combat reads parent inventory), custom compound guards (boss door needs both seals), multiple terminal nodes, suspension/resumption.

## Streaming Persistence

Use `RootBlackboard()` with cursors for efficient incremental persistence.
Only new entries since the last read are returned — no duplicates, no re-scanning.

```go
engine := reflex.CreateEngine(registry, agent)
engine.Init("my-workflow")

// Start cursor at position 0
cur := engine.RootBlackboard().Cursor()

for {
    result, _ := engine.Step(ctx)

    // Read only entries added since last step
    entries, next := engine.RootBlackboard().EntriesFrom(cur)
    for _, e := range entries {
        // Append to NDJSON log, database, etc.
        log.Printf("%s = %v (from %s)\n", e.Key, e.Value, e.Source.NodeID)
    }
    cur = next

    if result.Status == reflex.StepCompleted {
        break
    }
}
```

**`Blackboard()` vs `RootBlackboard()`**: `Blackboard()` returns a `BlackboardReader` that walks the full scope chain (local → parent → grandparent). `RootBlackboard()` returns the current workflow's `*ScopedBlackboard` for direct cursor access. Use `Blackboard()` in agents for scoped reads; use `RootBlackboard()` in persistence layers for incremental writes.

## Relationship to TypeScript Implementation

Both the TypeScript (`src/`) and Go (`go/`) implementations conform to the same
[DESIGN.md](../docs/DESIGN.md) specification. They share:

- The same formal model (Type 1, context-sensitive)
- The same type definitions (Sections 2.1–2.11)
- The same engine lifecycle (Section 1.4)
- The same validation rules (Section 3.3)
- Comparable test coverage

Go-specific differences:
- `context.Context` on `Resolve()` (Go convention for cancellation/timeouts)
- `sync.RWMutex` on `ScopedBlackboard` (Go supports concurrent access)
- Numeric-aware guard equality with `reflect.DeepEqual` fallback
- Table-driven tests with `t.Run()` subtests (Go testing idiom)
