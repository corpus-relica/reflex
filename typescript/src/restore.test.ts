import { describe, it, expect, beforeEach } from 'vitest';
import { ReflexEngine, EngineError } from './engine';
import { WorkflowRegistry } from './registry';
import { restoreEngine } from './restore';
import type {
  Workflow,
  Node,
  DecisionAgent,
  DecisionContext,
  Decision,
  ReturnMapping,
  EngineSnapshot,
  PersistenceAdapter,
  RestoreOptions,
  CustomGuard,
} from './types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function node(id: string): Node {
  return { id, spec: {} };
}

function invocationNode(
  id: string,
  workflowId: string,
  returnMap: ReturnMapping[] = [],
): Node {
  return { id, spec: {}, invokes: { workflowId, returnMap } };
}

function makeAgent(
  resolve: (ctx: DecisionContext) => Promise<Decision>,
): DecisionAgent {
  return { resolve };
}

/** Auto-advance agent: picks first valid edge, completes at terminal nodes. */
function autoAgent(): DecisionAgent {
  return makeAgent(async (ctx) => {
    if (ctx.validEdges.length > 0) {
      return { type: 'advance', edge: ctx.validEdges[0].id };
    }
    return { type: 'complete' };
  });
}

/** Auto-advance agent that writes at every step. */
function writingAgent(key: string, value: unknown): DecisionAgent {
  return makeAgent(async (ctx) => {
    if (ctx.validEdges.length > 0) {
      return {
        type: 'advance',
        edge: ctx.validEdges[0].id,
        writes: [{ key, value }],
      };
    }
    return { type: 'complete', writes: [{ key, value }] };
  });
}

// ---------------------------------------------------------------------------
// Workflow Fixtures
// ---------------------------------------------------------------------------

/** A → B → C → END */
function linearWorkflow(): Workflow {
  return {
    id: 'linear',
    entry: 'A',
    nodes: {
      A: node('A'),
      B: node('B'),
      C: node('C'),
      END: node('END'),
    },
    edges: [
      { id: 'e-ab', from: 'A', to: 'B', event: 'NEXT' },
      { id: 'e-bc', from: 'B', to: 'C', event: 'NEXT' },
      { id: 'e-ce', from: 'C', to: 'END', event: 'NEXT' },
    ],
  };
}

/** SETUP → INVOKE_CHILD → END */
function parentWorkflow(): Workflow {
  return {
    id: 'parent',
    entry: 'SETUP',
    nodes: {
      SETUP: node('SETUP'),
      INVOKE_CHILD: invocationNode('INVOKE_CHILD', 'child', [
        { parentKey: 'result', childKey: 'output' },
      ]),
      END: node('END'),
    },
    edges: [
      { id: 'e1', from: 'SETUP', to: 'INVOKE_CHILD', event: 'NEXT' },
      { id: 'e2', from: 'INVOKE_CHILD', to: 'END', event: 'NEXT' },
    ],
  };
}

/** CHILD_A → CHILD_END */
function childWorkflow(): Workflow {
  return {
    id: 'child',
    entry: 'CHILD_A',
    nodes: {
      CHILD_A: node('CHILD_A'),
      CHILD_END: node('CHILD_END'),
    },
    edges: [
      { id: 'e-child', from: 'CHILD_A', to: 'CHILD_END', event: 'NEXT' },
    ],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('restoreEngine()', () => {
  let registry: WorkflowRegistry;

  beforeEach(() => {
    registry = new WorkflowRegistry();
  });

  // -----------------------------------------------------------------------
  // Basic restore — state inspection
  // -----------------------------------------------------------------------

  it('restores engine with correct sessionId, status, currentNode, and stack', async () => {
    registry.register(linearWorkflow());
    const agent = autoAgent();
    const engine = new ReflexEngine(registry, agent);

    await engine.init('linear');
    await engine.step(); // A → B

    const snap = engine.snapshot();

    // Restore into a fresh registry with the same workflow
    const registry2 = new WorkflowRegistry();
    registry2.register(linearWorkflow());
    const restored = restoreEngine(snap, registry2, agent);

    expect(restored.sessionId()).toBe(snap.sessionId);
    expect(restored.status()).toBe('running');
    expect(restored.currentNode()!.id).toBe('B');
    expect(restored.currentWorkflow()!.id).toBe('linear');
    expect(restored.stack()).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // Round-trip: snapshot mid-workflow → restore → continue → complete
  // -----------------------------------------------------------------------

  it('restored engine can step() to completion', async () => {
    registry.register(linearWorkflow());
    const agent = autoAgent();
    const engine = new ReflexEngine(registry, agent);

    await engine.init('linear');
    await engine.step(); // A → B

    const snap = engine.snapshot();

    const registry2 = new WorkflowRegistry();
    registry2.register(linearWorkflow());
    const restored = restoreEngine(snap, registry2, agent);

    // Continue from B
    const r1 = await restored.step(); // B → C
    expect(r1.status).toBe('advanced');
    expect(restored.currentNode()!.id).toBe('C');

    const r2 = await restored.step(); // C → END
    expect(r2.status).toBe('advanced');
    expect(restored.currentNode()!.id).toBe('END');

    const r3 = await restored.step(); // complete at END
    expect(r3.status).toBe('completed');
    expect(restored.status()).toBe('completed');
  });

  // -----------------------------------------------------------------------
  // Round-trip with run()
  // -----------------------------------------------------------------------

  it('restored engine can run() to completion', async () => {
    registry.register(linearWorkflow());
    const agent = autoAgent();
    const engine = new ReflexEngine(registry, agent);

    await engine.init('linear');
    await engine.step(); // A → B

    const snap = engine.snapshot();

    const registry2 = new WorkflowRegistry();
    registry2.register(linearWorkflow());
    const restored = restoreEngine(snap, registry2, agent);

    const result = await restored.run();
    expect(result.status).toBe('completed');
  });

  // -----------------------------------------------------------------------
  // Suspended engine restore → resume
  // -----------------------------------------------------------------------

  it('restores suspended engine and resumes to completion', async () => {
    registry.register(linearWorkflow());

    let callCount = 0;
    const suspendOnceAgent = makeAgent(async (ctx) => {
      callCount++;
      // Suspend on the first call (at A), then auto-advance
      if (callCount === 1) {
        return { type: 'suspend', reason: 'waiting' };
      }
      if (ctx.validEdges.length > 0) {
        return { type: 'advance', edge: ctx.validEdges[0].id };
      }
      return { type: 'complete' };
    });

    const engine = new ReflexEngine(registry, suspendOnceAgent);
    await engine.init('linear');
    await engine.step(); // suspend at A
    expect(engine.status()).toBe('suspended');

    const snap = engine.snapshot();

    // Restore — use a fresh auto-advance agent (the "waiting" is over)
    const registry2 = new WorkflowRegistry();
    registry2.register(linearWorkflow());
    const restored = restoreEngine(snap, registry2, autoAgent());

    expect(restored.status()).toBe('suspended');

    const result = await restored.run();
    expect(result.status).toBe('completed');
  });

  // -----------------------------------------------------------------------
  // Blackboard integrity
  // -----------------------------------------------------------------------

  it('preserves blackboard entries through snapshot/restore', async () => {
    registry.register(linearWorkflow());
    const agent = writingAgent('data', 42);
    const engine = new ReflexEngine(registry, agent);

    await engine.init('linear');
    await engine.step(); // A → B, writes data=42

    const snap = engine.snapshot();

    const registry2 = new WorkflowRegistry();
    registry2.register(linearWorkflow());
    const restored = restoreEngine(snap, registry2, agent);

    const bb = restored.blackboard();
    expect(bb.get('data')).toBe(42);
    expect(bb.entries()).toHaveLength(1);
  });

  it('preserved blackboard accepts new writes after restore', async () => {
    registry.register(linearWorkflow());
    const agent = writingAgent('step', 'value');
    const engine = new ReflexEngine(registry, agent);

    await engine.init('linear');
    await engine.step(); // A → B, writes step=value

    const snap = engine.snapshot();

    const registry2 = new WorkflowRegistry();
    registry2.register(linearWorkflow());
    const restored = restoreEngine(snap, registry2, agent);

    await restored.step(); // B → C, writes step=value again

    const bb = restored.blackboard();
    expect(bb.getAll('step')).toHaveLength(2);
  });

  // -----------------------------------------------------------------------
  // Seed blackboard round-trip
  // -----------------------------------------------------------------------

  it('preserves seed blackboard entries through snapshot/restore', async () => {
    registry.register(linearWorkflow());
    const agent = autoAgent();
    const engine = new ReflexEngine(registry, agent);

    await engine.init('linear', {
      blackboard: [{ key: 'seed', value: 'data' }],
    });

    const snap = engine.snapshot();

    const registry2 = new WorkflowRegistry();
    registry2.register(linearWorkflow());
    const restored = restoreEngine(snap, registry2, agent);

    expect(restored.blackboard().get('seed')).toBe('data');
  });

  // -----------------------------------------------------------------------
  // Stack depth > 1: sub-workflow snapshot/restore
  // -----------------------------------------------------------------------

  it('restores engine during sub-workflow execution and completes', async () => {
    registry.register(parentWorkflow());
    registry.register(childWorkflow());

    const agent = makeAgent(async (ctx) => {
      if (ctx.validEdges.length > 0) {
        return {
          type: 'advance',
          edge: ctx.validEdges[0].id,
          writes: [{ key: 'trace', value: ctx.node.id }],
        };
      }
      return {
        type: 'complete',
        writes: [{ key: 'output', value: 'done' }],
      };
    });

    const engine = new ReflexEngine(registry, agent);
    await engine.init('parent');
    await engine.step(); // SETUP → INVOKE_CHILD (writes trace=SETUP)
    await engine.step(); // invocation: push parent, enter child at CHILD_A

    expect(engine.currentWorkflow()!.id).toBe('child');
    expect(engine.currentNode()!.id).toBe('CHILD_A');
    expect(engine.stack()).toHaveLength(1);

    const snap = engine.snapshot();

    // Restore
    const registry2 = new WorkflowRegistry();
    registry2.register(parentWorkflow());
    registry2.register(childWorkflow());
    const restored = restoreEngine(snap, registry2, agent);

    expect(restored.currentWorkflow()!.id).toBe('child');
    expect(restored.stack()).toHaveLength(1);

    // Continue: CHILD_A → CHILD_END → complete → pop → INVOKE_CHILD → END → complete
    const result = await restored.run();
    expect(result.status).toBe('completed');
  });

  // -----------------------------------------------------------------------
  // skipInvocation flag preserved
  // -----------------------------------------------------------------------

  it('preserves skipInvocation=true and does not re-invoke after restore', async () => {
    registry.register(parentWorkflow());
    registry.register(childWorkflow());

    const agent = makeAgent(async (ctx) => {
      if (ctx.validEdges.length > 0) {
        return { type: 'advance', edge: ctx.validEdges[0].id };
      }
      return { type: 'complete', writes: [{ key: 'output', value: 'done' }] };
    });

    const engine = new ReflexEngine(registry, agent);
    await engine.init('parent');
    await engine.step(); // SETUP → INVOKE_CHILD
    await engine.step(); // invocation push, enter child CHILD_A
    await engine.step(); // CHILD_A → CHILD_END
    await engine.step(); // complete at CHILD_END → pop back to parent

    // At this point: at INVOKE_CHILD with skipInvocation=true
    expect(engine.currentNode()!.id).toBe('INVOKE_CHILD');
    const snap = engine.snapshot();
    expect(snap.skipInvocation).toBe(true);

    const registry2 = new WorkflowRegistry();
    registry2.register(parentWorkflow());
    registry2.register(childWorkflow());
    const restored = restoreEngine(snap, registry2, agent);

    // Next step should advance past INVOKE_CHILD → END (not re-invoke child)
    const result = await restored.step();
    expect(result.status).toBe('advanced');
    expect(restored.currentNode()!.id).toBe('END');
  });

  // -----------------------------------------------------------------------
  // Events fire correctly on restored engine
  // -----------------------------------------------------------------------

  it('emits events on restored engine', async () => {
    registry.register(linearWorkflow());
    const agent = autoAgent();
    const engine = new ReflexEngine(registry, agent);

    await engine.init('linear');
    await engine.step(); // A → B

    const snap = engine.snapshot();

    const registry2 = new WorkflowRegistry();
    registry2.register(linearWorkflow());
    const restored = restoreEngine(snap, registry2, agent);

    const events: string[] = [];
    restored.on('node:exit', () => events.push('node:exit'));
    restored.on('edge:traverse', () => events.push('edge:traverse'));
    restored.on('node:enter', () => events.push('node:enter'));

    await restored.step(); // B → C

    expect(events).toEqual(['node:exit', 'edge:traverse', 'node:enter']);
  });

  // -----------------------------------------------------------------------
  // Error: missing workflow in registry
  // -----------------------------------------------------------------------

  it('throws EngineError when registry is missing a required workflow', async () => {
    registry.register(linearWorkflow());
    const agent = autoAgent();
    const engine = new ReflexEngine(registry, agent);

    await engine.init('linear');
    const snap = engine.snapshot();

    // Restore with empty registry
    const emptyRegistry = new WorkflowRegistry();
    expect(() => restoreEngine(snap, emptyRegistry, agent)).toThrow(
      EngineError,
    );
    expect(() => restoreEngine(snap, emptyRegistry, agent)).toThrow(
      /missing workflow/,
    );
  });

  it('error message lists all missing workflow IDs', async () => {
    registry.register(parentWorkflow());
    registry.register(childWorkflow());
    const agent = autoAgent();
    const engine = new ReflexEngine(registry, agent);

    await engine.init('parent');
    const snap = engine.snapshot();

    // Registry with only one of two workflows
    const partialRegistry = new WorkflowRegistry();
    partialRegistry.register(parentWorkflow());

    expect(() => restoreEngine(snap, partialRegistry, agent)).toThrow(
      /child/,
    );
  });

  // -----------------------------------------------------------------------
  // Error: missing node in workflow
  // -----------------------------------------------------------------------

  it('throws EngineError when current node does not exist in workflow', async () => {
    registry.register(linearWorkflow());
    const agent = autoAgent();
    const engine = new ReflexEngine(registry, agent);

    await engine.init('linear');
    const snap = engine.snapshot();

    // Tamper with snapshot: invalid node ID
    snap.currentNodeId = 'NONEXISTENT';

    const registry2 = new WorkflowRegistry();
    registry2.register(linearWorkflow());
    expect(() => restoreEngine(snap, registry2, agent)).toThrow(
      /current node.*NONEXISTENT/,
    );
  });

  // -----------------------------------------------------------------------
  // Snapshot is detached from restored engine
  // -----------------------------------------------------------------------

  it('restored engine is independent of the snapshot object', async () => {
    registry.register(linearWorkflow());
    const agent = writingAgent('x', 1);
    const engine = new ReflexEngine(registry, agent);

    await engine.init('linear');
    await engine.step(); // A → B, writes x=1

    const snap = engine.snapshot();

    const registry2 = new WorkflowRegistry();
    registry2.register(linearWorkflow());
    const restored = restoreEngine(snap, registry2, agent);

    // Mutate the snapshot
    snap.currentBlackboard.push({
      key: 'injected',
      value: 'bad',
      source: { workflowId: 'x', nodeId: 'x', stackDepth: 0 },
      timestamp: 0,
    });

    // Restored engine should not be affected
    expect(restored.blackboard().entries()).toHaveLength(1);
    expect(restored.blackboard().get('x')).toBe(1);
  });

  // -----------------------------------------------------------------------
  // JSON roundtrip: serialize → deserialize → restore
  // -----------------------------------------------------------------------

  it('works after JSON.stringify/parse roundtrip of snapshot', async () => {
    registry.register(linearWorkflow());
    const agent = writingAgent('count', 99);
    const engine = new ReflexEngine(registry, agent);

    await engine.init('linear');
    await engine.step(); // A → B, writes count=99

    const snap = engine.snapshot();
    const json = JSON.stringify(snap);
    const parsed: EngineSnapshot = JSON.parse(json);

    const registry2 = new WorkflowRegistry();
    registry2.register(linearWorkflow());
    const restored = restoreEngine(parsed, registry2, agent);

    expect(restored.currentNode()!.id).toBe('B');
    expect(restored.blackboard().get('count')).toBe(99);

    const result = await restored.run();
    expect(result.status).toBe('completed');
  });

  // -----------------------------------------------------------------------
  // PersistenceAdapter type is usable
  // -----------------------------------------------------------------------

  it('PersistenceAdapter interface is implementable', () => {
    // Verify the type is usable — compile-time check via runtime object
    const inMemoryAdapter: PersistenceAdapter = {
      store: new Map<string, EngineSnapshot>(),
      async save(sessionId: string, snapshot: EngineSnapshot) {
        this.store.set(sessionId, snapshot);
      },
      async load(sessionId: string) {
        return this.store.get(sessionId) ?? null;
      },
    } as PersistenceAdapter & { store: Map<string, EngineSnapshot> };

    expect(typeof inMemoryAdapter.save).toBe('function');
    expect(typeof inMemoryAdapter.load).toBe('function');
  });

  // -----------------------------------------------------------------------
  // validEdges() works on restored engine
  // -----------------------------------------------------------------------

  it('validEdges() returns correct edges after restore', async () => {
    registry.register(linearWorkflow());
    const agent = autoAgent();
    const engine = new ReflexEngine(registry, agent);

    await engine.init('linear');
    await engine.step(); // A → B

    const snap = engine.snapshot();

    const registry2 = new WorkflowRegistry();
    registry2.register(linearWorkflow());
    const restored = restoreEngine(snap, registry2, agent);

    const edges = restored.validEdges();
    expect(edges).toHaveLength(1);
    expect(edges[0].id).toBe('e-bc');
    expect(edges[0].to).toBe('C');
  });
});
