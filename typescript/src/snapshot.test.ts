import { describe, it, expect, beforeEach } from 'vitest';
import { ReflexEngine, EngineError } from './engine';
import { WorkflowRegistry } from './registry';
import type {
  Workflow,
  Node,
  DecisionAgent,
  DecisionContext,
  Decision,
  ReturnMapping,
  EngineSnapshot,
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

// ---------------------------------------------------------------------------
// Workflow Fixtures
// ---------------------------------------------------------------------------

/** A → B → END */
function linearWorkflow(): Workflow {
  return {
    id: 'linear',
    entry: 'A',
    nodes: { A: node('A'), B: node('B'), END: node('END') },
    edges: [
      { id: 'e-ab', from: 'A', to: 'B', event: 'NEXT' },
      { id: 'e-be', from: 'B', to: 'END', event: 'NEXT' },
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

describe('snapshot()', () => {
  let registry: WorkflowRegistry;

  beforeEach(() => {
    registry = new WorkflowRegistry();
  });

  // -----------------------------------------------------------------------
  // Pre-init error
  // -----------------------------------------------------------------------

  it('throws EngineError if called before init()', () => {
    const agent = makeAgent(async () => ({ type: 'complete' }));
    const engine = new ReflexEngine(registry, agent);

    expect(() => engine.snapshot()).toThrow(EngineError);
  });

  // -----------------------------------------------------------------------
  // Basic snapshot after init
  // -----------------------------------------------------------------------

  it('returns correct fields after init()', async () => {
    registry.register(linearWorkflow());
    const agent = makeAgent(async () => ({ type: 'complete' }));
    const engine = new ReflexEngine(registry, agent);

    const sessionId = await engine.init('linear');
    const snap = engine.snapshot();

    expect(snap.version).toBe('1');
    expect(snap.sessionId).toBe(sessionId);
    expect(snap.status).toBe('running');
    expect(snap.currentWorkflowId).toBe('linear');
    expect(snap.currentNodeId).toBe('A');
    expect(snap.stack).toHaveLength(0);
    expect(snap.currentBlackboard).toHaveLength(0);
    expect(snap.skipInvocation).toBe(false);
    expect(snap.workflowIds).toEqual(['linear']);
  });

  // -----------------------------------------------------------------------
  // Version and createdAt format
  // -----------------------------------------------------------------------

  it('has version "1" and valid ISO 8601 createdAt', async () => {
    registry.register(linearWorkflow());
    const agent = makeAgent(async () => ({ type: 'complete' }));
    const engine = new ReflexEngine(registry, agent);

    await engine.init('linear');
    const snap = engine.snapshot();

    expect(snap.version).toBe('1');
    // ISO 8601 roundtrip: Date constructor should parse it
    const parsed = new Date(snap.createdAt);
    expect(parsed.toISOString()).toBe(snap.createdAt);
  });

  // -----------------------------------------------------------------------
  // JSON roundtrip
  // -----------------------------------------------------------------------

  it('survives JSON.stringify / JSON.parse roundtrip', async () => {
    registry.register(linearWorkflow());
    const agent = makeAgent(async (ctx) => {
      if (ctx.validEdges.length > 0) {
        return {
          type: 'advance',
          edge: ctx.validEdges[0].id,
          writes: [{ key: 'data', value: 42 }],
        };
      }
      return { type: 'complete' };
    });
    const engine = new ReflexEngine(registry, agent);

    await engine.init('linear');
    await engine.step(); // A → B, writes data=42

    const snap = engine.snapshot();
    const json = JSON.stringify(snap);
    const restored: EngineSnapshot = JSON.parse(json);

    expect(restored.version).toBe(snap.version);
    expect(restored.sessionId).toBe(snap.sessionId);
    expect(restored.status).toBe(snap.status);
    expect(restored.currentWorkflowId).toBe(snap.currentWorkflowId);
    expect(restored.currentNodeId).toBe(snap.currentNodeId);
    expect(restored.skipInvocation).toBe(snap.skipInvocation);
    expect(restored.workflowIds).toEqual(snap.workflowIds);
    expect(restored.currentBlackboard).toEqual(snap.currentBlackboard);
    expect(restored.stack).toEqual(snap.stack);
  });

  // -----------------------------------------------------------------------
  // Mid-workflow snapshot
  // -----------------------------------------------------------------------

  it('captures correct currentNodeId at mid-workflow', async () => {
    registry.register(linearWorkflow());
    const agent = makeAgent(async (ctx) => {
      if (ctx.validEdges.length > 0) {
        return { type: 'advance', edge: ctx.validEdges[0].id };
      }
      return { type: 'complete' };
    });
    const engine = new ReflexEngine(registry, agent);

    await engine.init('linear');
    await engine.step(); // A → B

    const snap = engine.snapshot();
    expect(snap.currentNodeId).toBe('B');
    expect(snap.currentWorkflowId).toBe('linear');
  });

  // -----------------------------------------------------------------------
  // Snapshot with blackboard entries
  // -----------------------------------------------------------------------

  it('includes blackboard entries from writes', async () => {
    registry.register(linearWorkflow());
    const agent = makeAgent(async (ctx) => {
      if (ctx.validEdges.length > 0) {
        return {
          type: 'advance',
          edge: ctx.validEdges[0].id,
          writes: [{ key: 'answer', value: 'yes' }],
        };
      }
      return { type: 'complete' };
    });
    const engine = new ReflexEngine(registry, agent);

    await engine.init('linear');
    await engine.step(); // A → B, writes answer=yes

    const snap = engine.snapshot();
    expect(snap.currentBlackboard.length).toBe(1);
    expect(snap.currentBlackboard[0].key).toBe('answer');
    expect(snap.currentBlackboard[0].value).toBe('yes');
  });

  // -----------------------------------------------------------------------
  // Snapshot with seed blackboard
  // -----------------------------------------------------------------------

  it('includes seed blackboard entries', async () => {
    registry.register(linearWorkflow());
    const agent = makeAgent(async () => ({ type: 'suspend', reason: 'wait' }));
    const engine = new ReflexEngine(registry, agent);

    await engine.init('linear', {
      blackboard: [{ key: 'seed', value: 'data' }],
    });

    const snap = engine.snapshot();
    expect(snap.currentBlackboard.length).toBe(1);
    expect(snap.currentBlackboard[0].key).toBe('seed');
    expect(snap.currentBlackboard[0].value).toBe('data');
  });

  // -----------------------------------------------------------------------
  // Snapshot with call stack (invocation)
  // -----------------------------------------------------------------------

  it('captures call stack during sub-workflow execution', async () => {
    registry.register(parentWorkflow());
    registry.register(childWorkflow());

    const agent = makeAgent(async (ctx) => {
      if (ctx.validEdges.length > 0) {
        return {
          type: 'advance',
          edge: ctx.validEdges[0].id,
          writes: [{ key: 'parentData', value: 100 }],
        };
      }
      return { type: 'complete' };
    });
    const engine = new ReflexEngine(registry, agent);

    await engine.init('parent');
    await engine.step(); // SETUP → INVOKE_CHILD (writes parentData=100)
    await engine.step(); // invocation: push parent, enter child at CHILD_A

    const snap = engine.snapshot();
    expect(snap.currentWorkflowId).toBe('child');
    expect(snap.currentNodeId).toBe('CHILD_A');
    expect(snap.stack).toHaveLength(1);
    expect(snap.stack[0].workflowId).toBe('parent');
    expect(snap.stack[0].currentNodeId).toBe('INVOKE_CHILD');
    expect(snap.stack[0].blackboard.length).toBe(1);
    expect(snap.stack[0].blackboard[0].key).toBe('parentData');
    expect(snap.currentBlackboard).toHaveLength(0); // child bb is fresh
  });

  // -----------------------------------------------------------------------
  // skipInvocation flag
  // -----------------------------------------------------------------------

  it('skipInvocation is false during normal execution', async () => {
    registry.register(linearWorkflow());
    const agent = makeAgent(async (ctx) => {
      if (ctx.validEdges.length > 0) {
        return { type: 'advance', edge: ctx.validEdges[0].id };
      }
      return { type: 'complete' };
    });
    const engine = new ReflexEngine(registry, agent);

    await engine.init('linear');
    const snap = engine.snapshot();
    expect(snap.skipInvocation).toBe(false);
  });

  it('skipInvocation is true after sub-workflow pop', async () => {
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
    await engine.step(); // invocation: push, enter child CHILD_A
    await engine.step(); // CHILD_A → CHILD_END
    await engine.step(); // complete at CHILD_END → pop back to parent

    const snap = engine.snapshot();
    expect(snap.skipInvocation).toBe(true);
    expect(snap.currentWorkflowId).toBe('parent');
    expect(snap.currentNodeId).toBe('INVOKE_CHILD');
    expect(snap.stack).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // workflowIds
  // -----------------------------------------------------------------------

  it('workflowIds matches registered workflow IDs', async () => {
    registry.register(linearWorkflow());
    registry.register(parentWorkflow());
    registry.register(childWorkflow());

    const agent = makeAgent(async () => ({ type: 'suspend', reason: 'wait' }));
    const engine = new ReflexEngine(registry, agent);

    await engine.init('linear');
    const snap = engine.snapshot();

    expect(snap.workflowIds).toHaveLength(3);
    expect(snap.workflowIds).toContain('linear');
    expect(snap.workflowIds).toContain('parent');
    expect(snap.workflowIds).toContain('child');
  });

  // -----------------------------------------------------------------------
  // Snapshot is a detached copy (mutations don't affect engine)
  // -----------------------------------------------------------------------

  it('snapshot is a detached copy of engine state', async () => {
    registry.register(linearWorkflow());
    const agent = makeAgent(async (ctx) => {
      if (ctx.validEdges.length > 0) {
        return {
          type: 'advance',
          edge: ctx.validEdges[0].id,
          writes: [{ key: 'x', value: 1 }],
        };
      }
      return { type: 'complete' };
    });
    const engine = new ReflexEngine(registry, agent);

    await engine.init('linear');
    await engine.step(); // A → B, writes x=1

    const snap1 = engine.snapshot();

    // Mutate the snapshot — should not affect subsequent snapshots
    snap1.currentBlackboard.push({
      key: 'injected',
      value: 'bad',
      source: { workflowId: 'x', nodeId: 'x', stackDepth: 0 },
      timestamp: 0,
    });

    const snap2 = engine.snapshot();
    expect(snap2.currentBlackboard).toHaveLength(1); // only x=1
    expect(snap2.currentBlackboard[0].key).toBe('x');
  });
});
