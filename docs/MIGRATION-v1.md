# Migration Guide: v0.x to v1.0

This guide covers what changed between Reflex v0.1.0 (the v-alpha release) and v1.0, including breaking changes, new features, and an upgrade checklist.

## What's New

Reflex v1.0 adds four major capabilities on top of the v-alpha core:

- **Declarative workflows** (v0.3.0) — Define workflows as JSON and load them with `loadWorkflow()`. Round-trip serialization with `serializeWorkflow()`. JSON Schema validation included.
- **Node contracts** (v0.4.0) — Declare what each node reads and writes with `NodeInput`/`NodeOutput`. Run static verification at registration time with `registry.verify()`.
- **Persistence** (v0.5.0) — Capture full engine state with `engine.snapshot()` and restore it in a new process with `restoreEngine()`. Bring your own storage via `PersistenceAdapter`.
- **Cursor API** (v0.6.0) — Incremental blackboard reads for streaming persistence. Read only new entries since the last step — no duplicates, no re-scanning.

Plus smaller additions: seed blackboard at init (v0.2.0), entry node event fix (v0.2.1), and suspend writes fix (v0.6.1).

## Repository Restructure

The TypeScript source moved from the repository root into a `typescript/` subdirectory. This does **not** affect consumers:

- The npm package name is unchanged: `@corpus-relica/reflex`
- All imports remain the same: `import { ... } from '@corpus-relica/reflex'`
- Only local development paths changed (e.g., `typescript/src/` instead of `src/`)

## Breaking Changes

### 1. `init()` now emits `node:enter` for the entry node

*Changed in v0.2.1*

Previously, `init()` set the entry node but did not emit a `node:enter` event for it. This meant the first node had no matching enter/exit pair in the event trace.

**Before (v0.1.0):**

```typescript
engine.on('node:enter', (payload) => trace.push(payload));
await engine.init('my-workflow');
// No node:enter emitted — first event is node:exit when step() runs
```

**After (v0.2.1+):**

```typescript
engine.on('node:enter', (payload) => trace.push(payload));
await engine.init('my-workflow');
// node:enter IS emitted for the entry node immediately
// Every node visited now has a symmetric enter/exit pair
```

**Action required:** If you had workarounds for the missing first `node:enter` (e.g., manually injecting a synthetic event), remove them.

### 2. `Decision.suspend` writes are now applied

*Changed in v0.6.1*

Previously, `writes` on a suspend decision were silently dropped. The `writes` field existed in the type but had no effect.

**Before (v0.1.0):**

```typescript
// In your agent:
return {
  type: 'suspend',
  reason: 'awaiting input',
  writes: [{ key: 'draft', value: partialResult }],
};
// writes were SILENTLY DROPPED — blackboard unchanged
```

**After (v0.6.1+):**

```typescript
// Same code — writes are now applied to the blackboard
// blackboard:write event fires, THEN engine:suspend
return {
  type: 'suspend',
  reason: 'awaiting input',
  writes: [{ key: 'draft', value: partialResult }],
};
// partialResult is now on the blackboard when execution resumes
```

**Action required:** If you were returning writes on suspend that you did not intend to take effect, remove them from your suspend decisions.

## New Features

### Seed blackboard at init

*Added in v0.2.0*

Pre-populate the root blackboard before the first step. Useful for injecting configuration, user context, or external parameters.

**Before (v0.1.0):**

```typescript
await engine.init('my-workflow');
// No way to set initial blackboard values before the first step
```

**After (v0.2.0+):**

```typescript
await engine.init('my-workflow', {
  blackboard: [
    { key: 'userId', value: 'user-123' },
    { key: 'mode', value: 'interactive' },
  ],
});
// Values are available to the agent on the first step
// blackboard:write event fires before node:enter
```

### Declarative workflow loading

*Added in v0.3.0*

Define workflows as JSON files and load them at runtime. The JSON Schema is available for editor integration and build-time validation.

```typescript
import {
  loadWorkflow,
  serializeWorkflow,
  workflowSchema,
  type GuardRegistry,
} from '@corpus-relica/reflex';

// Load a JSON workflow
const json = fs.readFileSync('my-workflow.json', 'utf-8');
const workflow = loadWorkflow(json);
registry.register(workflow);

// With custom guards
const guards: GuardRegistry = {
  isApproved: (bb) => bb.get('status') === 'approved',
  hasUser: (bb) => bb.has('userId'),
};
const workflow = loadWorkflow(json, { guards });

// Serialize a programmatic workflow to JSON
const jsonStr = serializeWorkflow(workflow);

// Use the schema for build-tool / IDE validation
// workflowSchema is a JSON Schema draft-07 object
fs.writeFileSync('schema.json', JSON.stringify(workflowSchema, null, 2));
```

**JSON workflow format:**

```json
{
  "$schema": "https://github.com/corpus-relica/reflex/docs/workflow-schema.json",
  "id": "greeting",
  "entry": "ASK",
  "nodes": {
    "ASK":   { "id": "ASK",   "spec": { "prompt": "What is your name?" } },
    "GREET": { "id": "GREET", "spec": { "prompt": "Say hello" } },
    "DONE":  { "id": "DONE",  "spec": {} }
  },
  "edges": [
    { "id": "e1", "from": "ASK",   "to": "GREET", "event": "NEXT" },
    { "id": "e2", "from": "GREET", "to": "DONE",  "event": "NEXT" }
  ]
}
```

### Node contracts and static verification

*Added in v0.4.0*

Declare what each node reads (`inputs`) and writes (`outputs`), then verify data-flow consistency at registration time.

```typescript
import type { Workflow } from '@corpus-relica/reflex';

const workflow: Workflow = {
  id: 'pipeline',
  entry: 'FETCH',
  nodes: {
    FETCH: {
      id: 'FETCH',
      spec: { url: 'https://api.example.com/data' },
      outputs: [{ key: 'rawData', guaranteed: true }],
    },
    TRANSFORM: {
      id: 'TRANSFORM',
      spec: { format: 'csv' },
      inputs: [{ key: 'rawData', required: true }],
      outputs: [{ key: 'result', guaranteed: true }],
    },
    DONE: {
      id: 'DONE',
      spec: {},
      inputs: [{ key: 'result', required: true }],
    },
  },
  edges: [
    { id: 'e1', from: 'FETCH', to: 'TRANSFORM', event: 'NEXT' },
    { id: 'e2', from: 'TRANSFORM', to: 'DONE', event: 'NEXT' },
  ],
};

registry.register(workflow);

// Static verification — checks that required inputs have upstream producers
const result = registry.verify('pipeline');
console.log(result.valid);    // true
console.log(result.warnings); // [] — no data-flow gaps
```

Contracts are declarations only — they are not enforced at runtime. Use `verify()` in CI or at registration time to catch wiring errors early.

### Persistence: snapshot and restore

*Added in v0.5.0*

Capture the full engine state as a JSON-serializable snapshot and restore it in a new process.

```typescript
import { restoreEngine, type PersistenceAdapter } from '@corpus-relica/reflex';

// --- Save ---
const engine = createEngine(registry, agent);
await engine.init('my-workflow');
await engine.step();

const snapshot = engine.snapshot(); // JSON-serializable object
await fs.writeFile('session.json', JSON.stringify(snapshot));

// --- Restore (possibly in a different process) ---
const raw = JSON.parse(await fs.readFile('session.json', 'utf-8'));
const restored = restoreEngine(raw, registry, agent);
// Engine is positioned exactly where it left off
const result = await restored.run();
```

If your workflows use custom guards loaded via `loadWorkflow()`, pass the same guard registry at restore time:

```typescript
const restored = restoreEngine(raw, registry, agent, { guards });
```

**File-system adapter example:**

Reflex provides no built-in adapters — you supply your own. Here is a minimal file-system adapter for illustration:

```typescript
import type { PersistenceAdapter, EngineSnapshot } from '@corpus-relica/reflex';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

function createFileAdapter(dir: string): PersistenceAdapter {
  return {
    async save(sessionId: string, snapshot: EngineSnapshot): Promise<void> {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, `${sessionId}.json`), JSON.stringify(snapshot));
    },
    async load(sessionId: string): Promise<EngineSnapshot | null> {
      try {
        const data = await readFile(join(dir, `${sessionId}.json`), 'utf-8');
        return JSON.parse(data);
      } catch {
        return null;
      }
    },
  };
}
```

### Incremental blackboard reads: cursor API

*Added in v0.6.0*

Read only blackboard entries added since the last check — ideal for streaming persistence without re-scanning the entire history.

```typescript
const engine = createEngine(registry, agent);
await engine.init('my-workflow');

// Snapshot the current position
let cur = engine.currentBlackboard()!.cursor();

while (true) {
  const result = await engine.step();

  // Read only entries written since last step
  const [entries, next] = engine.currentBlackboard()!.entriesFrom(cur);
  for (const e of entries) {
    await db.append(e); // stream to your persistence layer
  }
  cur = next;

  if (result.status === 'completed') break;
}
```

**`blackboard()` vs `currentBlackboard()`**: Use `blackboard()` in decision agents — it returns a `BlackboardReader` that walks the full scope chain (local → parent → grandparent). Use `currentBlackboard()` in persistence layers — it returns a `CursorReader` for the current workflow's local blackboard only.

## Expanded ValidationErrorCode

`ValidationErrorCode` has grown from 7 codes in v0.1.0 to 10 in v1.0. If you have exhaustive `switch` statements on `WorkflowValidationError.code`, add cases for:

| Code | Thrown by | Meaning |
|------|-----------|---------|
| `SCHEMA_VIOLATION` | `loadWorkflow()` | JSON input fails schema validation |
| `UNKNOWN_GUARD_REFERENCE` | `loadWorkflow()` | Named custom guard not found in guard registry |
| `WORKFLOW_NOT_FOUND` | `registry.verify()` | Workflow ID not registered |

## Upgrade Checklist

- [ ] Remove any workarounds for missing `node:enter` on init (fixed in v0.2.1)
- [ ] Audit suspend decisions that included `writes` — they now take effect (fixed in v0.6.1)
- [ ] Update exhaustive `ValidationErrorCode` switch statements (+3 new codes)
- [ ] *(Optional)* Migrate hardcoded workflow objects to JSON + `loadWorkflow()`
- [ ] *(Optional)* Add `NodeInput`/`NodeOutput` contracts and `registry.verify()` to CI
- [ ] *(Optional)* Implement a `PersistenceAdapter` for durable sessions
- [ ] *(Optional)* Use cursor API for streaming persistence instead of full blackboard reads
