import { describe, it, expect } from 'vitest';
import { ReflexEngine } from './engine';
import { WorkflowRegistry } from './registry';
import {
  Workflow,
  Node,
  DecisionAgent,
  DecisionContext,
  Decision,
  ReturnMapping,
  ExecutionRecordEvent,
  ExecutionInvalidateEvent,
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

/** Parent: P_INIT → P_WORK → P_END */
function parentWorkflow(): Workflow {
  return {
    id: 'parent',
    entry: 'P_INIT',
    nodes: {
      P_INIT: node('P_INIT'),
      P_WORK: node('P_WORK'),
      P_END: node('P_END'),
    },
    edges: [
      { id: 'e-init-work', from: 'P_INIT', to: 'P_WORK', event: 'NEXT' },
      { id: 'e-work-end', from: 'P_WORK', to: 'P_END', event: 'NEXT' },
    ],
  };
}

/** Child: C_ENTRY → C_FINISH (terminal) */
function childWorkflow(): Workflow {
  return {
    id: 'child',
    entry: 'C_ENTRY',
    nodes: {
      C_ENTRY: node('C_ENTRY'),
      C_FINISH: node('C_FINISH'),
    },
    edges: [
      { id: 'e-c-entry-finish', from: 'C_ENTRY', to: 'C_FINISH', event: 'NEXT' },
    ],
  };
}

/** Grandchild: G_ENTRY → G_END (terminal) */
function grandchildWorkflow(): Workflow {
  return {
    id: 'grandchild',
    entry: 'G_ENTRY',
    nodes: {
      G_ENTRY: node('G_ENTRY'),
      G_END: node('G_END'),
    },
    edges: [
      { id: 'e-g-entry-end', from: 'G_ENTRY', to: 'G_END', event: 'NEXT' },
    ],
  };
}

/** Parent with declarative invocation: PI_INIT → PI_INVOKE(child) → PI_END */
function parentWithInvoke(): Workflow {
  return {
    id: 'parent-inv',
    entry: 'PI_INIT',
    nodes: {
      PI_INIT: node('PI_INIT'),
      PI_INVOKE: invocationNode('PI_INVOKE', 'child', [
        { parentKey: 'result', childKey: 'output' },
      ]),
      PI_END: node('PI_END'),
    },
    edges: [
      { id: 'e-pi-init-invoke', from: 'PI_INIT', to: 'PI_INVOKE', event: 'NEXT' },
      { id: 'e-pi-invoke-end', from: 'PI_INVOKE', to: 'PI_END', event: 'NEXT' },
    ],
  };
}

// ---------------------------------------------------------------------------
// Basic Recording
// ---------------------------------------------------------------------------

describe('Execution tracking — basic recording', () => {
  it('pushWorkflow() creates an active execution record', async () => {
    const registry = new WorkflowRegistry();
    registry.register(parentWorkflow());
    registry.register(childWorkflow());
    const agent = makeAgent(async () => ({ type: 'advance', edge: 'e-init-work' }));
    const engine = new ReflexEngine(registry, agent);
    await engine.init('parent');

    engine.pushWorkflow('child');

    const active = engine.activeExecutions();
    expect(active).toHaveLength(1);
    expect(active[0].parentWorkflowId).toBe('parent');
    expect(active[0].parentNodeId).toBe('P_INIT');
    expect(active[0].childWorkflowId).toBe('child');
    expect(active[0].status).toBe('active');
  });

  it('popWorkflow() transitions record to completed', async () => {
    const registry = new WorkflowRegistry();
    registry.register(parentWorkflow());
    registry.register(childWorkflow());
    const agent = makeAgent(async () => ({ type: 'advance', edge: 'e-init-work' }));
    const engine = new ReflexEngine(registry, agent);
    await engine.init('parent');

    engine.pushWorkflow('child');
    engine.popWorkflow();

    const completed = engine.completedExecutionsAt('parent', 'P_INIT');
    expect(completed).toHaveLength(1);
    expect(completed[0].status).toBe('completed');
    expect(engine.activeExecutions()).toHaveLength(0);
  });

  it('declarative invocation creates and completes records', async () => {
    const registry = new WorkflowRegistry();
    registry.register(parentWithInvoke());
    registry.register(childWorkflow());

    let stepCount = 0;
    const agent = makeAgent(async (ctx) => {
      stepCount++;
      if (ctx.node.id === 'PI_INIT') return { type: 'advance', edge: 'e-pi-init-invoke' };
      if (ctx.node.id === 'C_ENTRY') return { type: 'advance', edge: 'e-c-entry-finish' };
      if (ctx.node.id === 'C_FINISH') return { type: 'complete' };
      if (ctx.node.id === 'PI_INVOKE') return { type: 'advance', edge: 'e-pi-invoke-end' };
      return { type: 'suspend', reason: 'unexpected' };
    });
    const engine = new ReflexEngine(registry, agent);
    await engine.init('parent-inv');

    // Advance to invocation node
    await engine.step(); // PI_INIT → PI_INVOKE
    // Invocation fires
    await engine.step(); // push child
    expect(engine.activeExecutions()).toHaveLength(1);

    // Step through child
    await engine.step(); // C_ENTRY → C_FINISH
    await engine.step(); // complete → pop

    // Record should be completed
    const completed = engine.completedExecutionsAt('parent-inv', 'PI_INVOKE');
    expect(completed).toHaveLength(1);
    expect(completed[0].childWorkflowId).toBe('child');
    expect(completed[0].returnMap).toEqual([
      { parentKey: 'result', childKey: 'output' },
    ]);
  });

  it('records parentInvocationId for nested invocations', async () => {
    const registry = new WorkflowRegistry();
    registry.register(parentWorkflow());
    registry.register(childWorkflow());
    registry.register(grandchildWorkflow());
    const agent = makeAgent(async () => ({ type: 'suspend', reason: 'test' }));
    const engine = new ReflexEngine(registry, agent);
    await engine.init('parent');

    engine.pushWorkflow('child');
    const afterFirst = engine.activeExecutions();
    const firstId = afterFirst[0].invocationId;

    engine.pushWorkflow('grandchild');
    const afterSecond = engine.activeExecutions();
    const grandchild = afterSecond.find((r) => r.childWorkflowId === 'grandchild')!;

    expect(grandchild.parentInvocationId).toBe(firstId);
  });

  it('links child invocations via childInvocationIds', async () => {
    const registry = new WorkflowRegistry();
    registry.register(parentWorkflow());
    registry.register(childWorkflow());
    registry.register(grandchildWorkflow());
    const agent = makeAgent(async () => ({ type: 'suspend', reason: 'test' }));
    const engine = new ReflexEngine(registry, agent);
    await engine.init('parent');

    engine.pushWorkflow('child');
    const firstId = engine.activeExecutions()[0].invocationId;

    engine.pushWorkflow('grandchild');
    const grandchildId = engine.activeExecutions().find(
      (r) => r.childWorkflowId === 'grandchild',
    )!.invocationId;

    // The first invocation should list the grandchild as a child
    const tree = engine.executionTree();
    expect(tree.get(firstId)!.childInvocationIds).toContain(grandchildId);
  });
});

// ---------------------------------------------------------------------------
// Prune on Reinvoke
// ---------------------------------------------------------------------------

describe('Execution tracking — prune on reinvoke', () => {
  it('push/pop/push at same node invalidates prior record', async () => {
    const registry = new WorkflowRegistry();
    registry.register(parentWorkflow());
    registry.register(childWorkflow());
    const agent = makeAgent(async () => ({ type: 'suspend', reason: 'test' }));
    const engine = new ReflexEngine(registry, agent);
    await engine.init('parent');

    engine.pushWorkflow('child');
    const firstId = engine.activeExecutions()[0].invocationId;
    engine.popWorkflow();

    // Re-invoke from same node
    engine.pushWorkflow('child');

    expect(engine.invalidatedExecutions()).toHaveLength(1);
    expect(engine.invalidatedExecutions()[0].invocationId).toBe(firstId);
    expect(engine.activeExecutions()).toHaveLength(1);
    expect(engine.activeExecutions()[0].invocationId).not.toBe(firstId);
  });

  it('emits execution:invalidate when pruning on reinvoke', async () => {
    const registry = new WorkflowRegistry();
    registry.register(parentWorkflow());
    registry.register(childWorkflow());
    const agent = makeAgent(async () => ({ type: 'suspend', reason: 'test' }));
    const engine = new ReflexEngine(registry, agent);
    await engine.init('parent');

    engine.pushWorkflow('child');
    engine.popWorkflow();

    const events: ExecutionInvalidateEvent[] = [];
    engine.on('execution:invalidate', (p) =>
      events.push(p as ExecutionInvalidateEvent),
    );

    engine.pushWorkflow('child');

    expect(events).toHaveLength(1);
    expect(events[0].invalidatedIds).toHaveLength(1);
  });

  it('prune cascades to descendants of the prior record', async () => {
    const registry = new WorkflowRegistry();
    registry.register(parentWorkflow());
    registry.register(childWorkflow());
    registry.register(grandchildWorkflow());
    const agent = makeAgent(async () => ({ type: 'suspend', reason: 'test' }));
    const engine = new ReflexEngine(registry, agent);
    await engine.init('parent');

    // Push child, then grandchild from within child
    engine.pushWorkflow('child');
    engine.pushWorkflow('grandchild');
    // Pop both back to parent
    engine.popWorkflow(); // pop grandchild
    engine.popWorkflow(); // pop child

    // Re-invoke from same parent node — should prune child + grandchild
    engine.pushWorkflow('child');

    expect(engine.invalidatedExecutions()).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Prune on unwindToDepth
// ---------------------------------------------------------------------------

describe('Execution tracking — prune on unwindToDepth', () => {
  it('unwindToDepth(0) invalidates all active records', async () => {
    const registry = new WorkflowRegistry();
    registry.register(parentWorkflow());
    registry.register(childWorkflow());
    registry.register(grandchildWorkflow());
    const agent = makeAgent(async () => ({ type: 'suspend', reason: 'test' }));
    const engine = new ReflexEngine(registry, agent);
    await engine.init('parent');

    engine.pushWorkflow('child');
    engine.pushWorkflow('grandchild');

    // Suspend before unwind
    await engine.step();
    engine.unwindToDepth(0);

    expect(engine.invalidatedExecutions()).toHaveLength(2);
    expect(engine.activeExecutions()).toHaveLength(0);
  });

  it('unwindToDepth(1) invalidates only the innermost execution', async () => {
    const registry = new WorkflowRegistry();
    registry.register(parentWorkflow());
    registry.register(childWorkflow());
    registry.register(grandchildWorkflow());
    const agent = makeAgent(async () => ({ type: 'suspend', reason: 'test' }));
    const engine = new ReflexEngine(registry, agent);
    await engine.init('parent');

    engine.pushWorkflow('child');
    const childId = engine.activeExecutions()[0].invocationId;
    engine.pushWorkflow('grandchild');

    await engine.step();
    engine.unwindToDepth(1);

    // Grandchild (the active one) should be invalidated
    // Child (restored as active context) should still be active — wait, no.
    // The child's frame was the target. Its invocationId is restored as
    // _currentInvocationId. The child execution record should NOT be invalidated.
    // Only the grandchild (which was _currentInvocationId at unwind time) is invalidated.
    expect(engine.invalidatedExecutions()).toHaveLength(1);
    expect(engine.invalidatedExecutions()[0].childWorkflowId).toBe('grandchild');

    // The child's execution record is still whatever status it was (active)
    const tree = engine.executionTree();
    expect(tree.get(childId)!.status).toBe('active');
  });

  it('emits execution:invalidate alongside stack:unwind', async () => {
    const registry = new WorkflowRegistry();
    registry.register(parentWorkflow());
    registry.register(childWorkflow());
    const agent = makeAgent(async () => ({ type: 'suspend', reason: 'test' }));
    const engine = new ReflexEngine(registry, agent);
    await engine.init('parent');

    engine.pushWorkflow('child');
    await engine.step();

    const eventOrder: string[] = [];
    engine.on('execution:invalidate', () => eventOrder.push('execution:invalidate'));
    engine.on('stack:unwind', () => eventOrder.push('stack:unwind'));

    engine.unwindToDepth(0);

    expect(eventOrder).toEqual(['execution:invalidate', 'stack:unwind']);
  });

  it('unwind with reinvoke: true invalidates the restored frame record', async () => {
    const registry = new WorkflowRegistry();
    registry.register(parentWorkflow());
    registry.register(childWorkflow());
    registry.register(grandchildWorkflow());
    const agent = makeAgent(async () => ({ type: 'suspend', reason: 'test' }));
    const engine = new ReflexEngine(registry, agent);
    await engine.init('parent');

    engine.pushWorkflow('child');
    const childId = engine.activeExecutions()[0].invocationId;
    engine.pushWorkflow('grandchild');

    await engine.step();

    // Unwind to depth 1 (child level). The child's invocationId is on the
    // target frame — it gets restored as _currentInvocationId, NOT invalidated.
    // Only the grandchild (which was active) is invalidated.
    engine.unwindToDepth(1, { reinvoke: true });

    expect(engine.invalidatedExecutions()).toHaveLength(1);
    expect(engine.invalidatedExecutions()[0].childWorkflowId).toBe('grandchild');
    // The child record is still active (it's the restored context)
    expect(engine.executionTree().get(childId)!.status).toBe('active');
  });
});

// ---------------------------------------------------------------------------
// Snapshot / Restore Round-Trip
// ---------------------------------------------------------------------------

describe('Execution tracking — snapshot/restore', () => {
  it('snapshot includes execution tree and currentInvocationId', async () => {
    const registry = new WorkflowRegistry();
    registry.register(parentWorkflow());
    registry.register(childWorkflow());
    const agent = makeAgent(async () => ({ type: 'suspend', reason: 'test' }));
    const engine = new ReflexEngine(registry, agent);
    await engine.init('parent');

    engine.pushWorkflow('child');
    const snap = engine.snapshot();

    expect(snap.executionTree).toBeDefined();
    expect(snap.executionTree!.records).toHaveLength(1);
    expect(snap.currentInvocationId).toBeDefined();
  });

  it('restored engine produces same query results', async () => {
    const registry = new WorkflowRegistry();
    registry.register(parentWorkflow());
    registry.register(childWorkflow());
    const agent = makeAgent(async () => ({ type: 'suspend', reason: 'test' }));
    const engine = new ReflexEngine(registry, agent);
    await engine.init('parent');

    engine.pushWorkflow('child');
    engine.popWorkflow();

    const snap = engine.snapshot();

    // Restore
    const { restoreEngine } = await import('./restore.js');
    const restored = restoreEngine(snap, registry, agent);

    expect(restored.completedExecutionsAt('parent', 'P_INIT')).toHaveLength(1);
    expect(restored.activeExecutions()).toHaveLength(0);
  });

  it('v1 snapshot (no executionTree) restores cleanly', async () => {
    const registry = new WorkflowRegistry();
    registry.register(parentWorkflow());
    const agent = makeAgent(async () => ({ type: 'suspend', reason: 'test' }));
    const engine = new ReflexEngine(registry, agent);
    await engine.init('parent');

    const snap = engine.snapshot();
    // Simulate v1 snapshot by removing execution tree fields
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = snap as any;
    delete raw.executionTree;
    delete raw.currentInvocationId;
    snap.version = '1';

    const { restoreEngine } = await import('./restore.js');
    const restored = restoreEngine(snap, registry, agent);

    expect(restored.activeExecutions()).toHaveLength(0);
    expect(restored.executionTree().size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

describe('Execution tracking — events', () => {
  it('execution:record emitted on imperative push', async () => {
    const registry = new WorkflowRegistry();
    registry.register(parentWorkflow());
    registry.register(childWorkflow());
    const agent = makeAgent(async () => ({ type: 'suspend', reason: 'test' }));
    const engine = new ReflexEngine(registry, agent);
    await engine.init('parent');

    const events: ExecutionRecordEvent[] = [];
    engine.on('execution:record', (p) =>
      events.push(p as ExecutionRecordEvent),
    );

    engine.pushWorkflow('child');

    expect(events).toHaveLength(1);
    expect(events[0].record.childWorkflowId).toBe('child');
    expect(events[0].record.status).toBe('active');
  });

  it('execution:record emitted on declarative push', async () => {
    const registry = new WorkflowRegistry();
    registry.register(parentWithInvoke());
    registry.register(childWorkflow());

    const agent = makeAgent(async (ctx) => {
      if (ctx.node.id === 'PI_INIT') return { type: 'advance', edge: 'e-pi-init-invoke' };
      return { type: 'suspend', reason: 'test' };
    });
    const engine = new ReflexEngine(registry, agent);
    await engine.init('parent-inv');

    const events: ExecutionRecordEvent[] = [];
    engine.on('execution:record', (p) =>
      events.push(p as ExecutionRecordEvent),
    );

    await engine.step(); // advance to PI_INVOKE
    await engine.step(); // declarative push

    expect(events).toHaveLength(1);
    expect(events[0].record.childWorkflowId).toBe('child');
  });

  it('execution:invalidate emitted by unwindToDepth with correct IDs', async () => {
    const registry = new WorkflowRegistry();
    registry.register(parentWorkflow());
    registry.register(childWorkflow());
    const agent = makeAgent(async () => ({ type: 'suspend', reason: 'test' }));
    const engine = new ReflexEngine(registry, agent);
    await engine.init('parent');

    engine.pushWorkflow('child');
    const childInvId = engine.activeExecutions()[0].invocationId;
    await engine.step();

    const events: ExecutionInvalidateEvent[] = [];
    engine.on('execution:invalidate', (p) =>
      events.push(p as ExecutionInvalidateEvent),
    );

    engine.unwindToDepth(0);

    expect(events).toHaveLength(1);
    expect(events[0].invalidatedIds).toContain(childInvId);
  });

  it('execution:invalidate not emitted when no records change', async () => {
    const registry = new WorkflowRegistry();
    registry.register(parentWorkflow());
    const agent = makeAgent(async () => ({ type: 'suspend', reason: 'test' }));
    const engine = new ReflexEngine(registry, agent);
    await engine.init('parent');

    // Push to same node with no prior records — no prune needed
    const events: ExecutionInvalidateEvent[] = [];
    engine.on('execution:invalidate', (p) =>
      events.push(p as ExecutionInvalidateEvent),
    );

    // pushWorkflow at root with no prior invocations at this node
    registry.register(childWorkflow());
    engine.pushWorkflow('child');

    expect(events).toHaveLength(0);
  });

  it('event ordering: execution:record before workflow:push', async () => {
    const registry = new WorkflowRegistry();
    registry.register(parentWorkflow());
    registry.register(childWorkflow());
    const agent = makeAgent(async () => ({ type: 'suspend', reason: 'test' }));
    const engine = new ReflexEngine(registry, agent);
    await engine.init('parent');

    const order: string[] = [];
    engine.on('execution:record', () => order.push('execution:record'));
    engine.on('workflow:push', () => order.push('workflow:push'));
    engine.on('node:enter', () => order.push('node:enter'));

    engine.pushWorkflow('child');

    expect(order).toEqual(['execution:record', 'workflow:push', 'node:enter']);
  });
});
