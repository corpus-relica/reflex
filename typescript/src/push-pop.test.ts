import { describe, it, expect } from 'vitest';
import { ReflexEngine, EngineError } from './engine';
import { WorkflowRegistry } from './registry';
import {
  Workflow,
  Node,
  DecisionAgent,
  DecisionContext,
  Decision,
  ReturnMapping,
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

/** Parent workflow: INIT → WORK → END */
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
      { id: 'e-p-init-work', from: 'P_INIT', to: 'P_WORK', event: 'NEXT' },
      { id: 'e-p-work-end', from: 'P_WORK', to: 'P_END', event: 'NEXT' },
    ],
  };
}

/** Child workflow: ENTRY → FINISH (terminal) */
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

/** Parent with a declarative invocation node: INIT → INVOKE(child) → END */
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
// Setup helper — creates engine, registers workflows, inits parent
// ---------------------------------------------------------------------------

async function setup(opts?: {
  agent?: DecisionAgent;
  workflows?: Workflow[];
  initWorkflow?: string;
}) {
  const registry = new WorkflowRegistry();
  const workflows = opts?.workflows ?? [parentWorkflow(), childWorkflow()];
  for (const w of workflows) {
    registry.register(w);
  }

  const agent =
    opts?.agent ??
    makeAgent(async () => ({ type: 'suspend', reason: 'waiting' }));

  const engine = new ReflexEngine(registry, agent);
  await engine.init(opts?.initWorkflow ?? 'parent');
  return { engine, registry };
}

// ---------------------------------------------------------------------------
// pushWorkflow — basic push
// ---------------------------------------------------------------------------

describe('pushWorkflow — basic push', () => {
  it('switches to sub-workflow entry node', async () => {
    const { engine } = await setup();
    engine.pushWorkflow('child');
    expect(engine.currentWorkflow()!.id).toBe('child');
    expect(engine.currentNode()!.id).toBe('C_ENTRY');
  });

  it('grows the stack by 1', async () => {
    const { engine } = await setup();
    expect(engine.stack().length).toBe(0);
    engine.pushWorkflow('child');
    expect(engine.stack().length).toBe(1);
  });

  it('frame at index 0 has correct workflowId and currentNodeId', async () => {
    const { engine } = await setup();
    engine.pushWorkflow('child');
    const frame = engine.stack()[0];
    expect(frame.workflowId).toBe('parent');
    expect(frame.currentNodeId).toBe('P_INIT');
  });

  it('emits workflow:push event', async () => {
    const { engine } = await setup();
    const events: unknown[] = [];
    engine.on('workflow:push', (p) => events.push(p));
    engine.pushWorkflow('child');
    expect(events.length).toBe(1);
  });

  it('emits node:enter for sub-workflow entry node after workflow:push', async () => {
    const { engine } = await setup();
    const order: string[] = [];
    engine.on('workflow:push', () => order.push('workflow:push'));
    engine.on('node:enter', (p: any) => order.push(`node:enter:${p.node.id}`));
    engine.pushWorkflow('child');
    expect(order).toEqual(['workflow:push', 'node:enter:C_ENTRY']);
  });

  it('returns { status: invoked } with correct workflow and node', async () => {
    const { engine } = await setup();
    const result = engine.pushWorkflow('child');
    expect(result.status).toBe('invoked');
    if (result.status === 'invoked') {
      expect(result.workflow.id).toBe('child');
      expect(result.node.id).toBe('C_ENTRY');
    }
  });

  it('does not set _skipInvocation (snapshot shows false)', async () => {
    const { engine } = await setup();
    engine.pushWorkflow('child');
    const snap = engine.snapshot();
    expect(snap.skipInvocation).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// pushWorkflow — inputMap
// ---------------------------------------------------------------------------

describe('pushWorkflow — inputMap', () => {
  it('seeds child blackboard with mapped parent value', async () => {
    const agent = makeAgent(async () => ({
      type: 'advance',
      edge: 'e-p-init-work',
      writes: [{ key: 'Color', value: 'Red' }],
    }));
    const { engine } = await setup({ agent });
    // Write a value to parent blackboard
    await engine.step(); // advance P_INIT → P_WORK, writes Color=Red

    engine.pushWorkflow('child', {
      inputMap: [{ from: 'Color', to: 'ParentColor' }],
    });

    expect(engine.blackboard().get('ParentColor')).toBe('Red');
  });

  it('emits blackboard:write for seeded entries', async () => {
    const agent = makeAgent(async () => ({
      type: 'advance',
      edge: 'e-p-init-work',
      writes: [{ key: 'Color', value: 'Red' }],
    }));
    const { engine } = await setup({ agent });
    await engine.step();

    const bbEvents: unknown[] = [];
    engine.on('blackboard:write', (p) => bbEvents.push(p));

    engine.pushWorkflow('child', {
      inputMap: [{ from: 'Color', to: 'ParentColor' }],
    });

    expect(bbEvents.length).toBe(1);
  });

  it('seeded value is in child local scope, not via parent scope chain', async () => {
    const agent = makeAgent(async () => ({
      type: 'advance',
      edge: 'e-p-init-work',
      writes: [{ key: 'Color', value: 'Red' }],
    }));
    const { engine } = await setup({ agent });
    await engine.step();

    engine.pushWorkflow('child', {
      inputMap: [{ from: 'Color', to: 'ParentColor' }],
    });

    // Should be in local scope
    const localEntries = engine.blackboard().local();
    expect(localEntries.some((e) => e.key === 'ParentColor')).toBe(true);
  });

  it('unmapped parent keys are still readable via scope chain', async () => {
    const agent = makeAgent(async () => ({
      type: 'advance',
      edge: 'e-p-init-work',
      writes: [{ key: 'Color', value: 'Red' }, { key: 'Size', value: 'Large' }],
    }));
    const { engine } = await setup({ agent });
    await engine.step();

    engine.pushWorkflow('child', {
      inputMap: [{ from: 'Color', to: 'ParentColor' }],
    });

    // Size was not mapped but should be readable via scope chain
    expect(engine.blackboard().get('Size')).toBe('Large');
  });

  it('silently skips input keys not found in parent', async () => {
    const { engine } = await setup();
    // No writes to parent blackboard — 'Missing' doesn't exist
    const result = engine.pushWorkflow('child', {
      inputMap: [{ from: 'Missing', to: 'Target' }],
    });

    expect(result.status).toBe('invoked');
    expect(engine.blackboard().get('Target')).toBeUndefined();
  });

  it('batches multiple inputMap entries in a single blackboard:write', async () => {
    const agent = makeAgent(async () => ({
      type: 'advance',
      edge: 'e-p-init-work',
      writes: [{ key: 'A', value: 1 }, { key: 'B', value: 2 }],
    }));
    const { engine } = await setup({ agent });
    await engine.step();

    const bbEvents: any[] = [];
    engine.on('blackboard:write', (p) => bbEvents.push(p));

    engine.pushWorkflow('child', {
      inputMap: [{ from: 'A', to: 'X' }, { from: 'B', to: 'Y' }],
    });

    expect(bbEvents.length).toBe(1);
    expect(bbEvents[0].entries.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// pushWorkflow — returnMap
// ---------------------------------------------------------------------------

describe('pushWorkflow — returnMap', () => {
  it('returnMap is applied on pop', async () => {
    const agent = makeAgent(async (ctx) => {
      if (ctx.node.id === 'C_ENTRY') {
        return {
          type: 'advance',
          edge: 'e-c-entry-finish',
          writes: [{ key: 'output', value: 'hello' }],
        };
      }
      return { type: 'suspend', reason: 'waiting' };
    });
    const { engine } = await setup({ agent });

    engine.pushWorkflow('child', {
      returnMap: [{ parentKey: 'result', childKey: 'output' }],
    });

    // Advance child to terminal
    await engine.step(); // C_ENTRY → C_FINISH, writes output=hello

    engine.popWorkflow();

    expect(engine.blackboard().get('result')).toBe('hello');
  });

  it('default returnMap is empty — no writes on pop', async () => {
    const { engine } = await setup();
    engine.pushWorkflow('child'); // no returnMap

    const bbEvents: unknown[] = [];
    engine.on('blackboard:write', (p) => bbEvents.push(p));

    engine.popWorkflow();

    expect(bbEvents.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// popWorkflow — basic pop
// ---------------------------------------------------------------------------

describe('popWorkflow — basic pop', () => {
  it('restores parent workflow and node', async () => {
    const { engine } = await setup();
    engine.pushWorkflow('child');
    engine.popWorkflow();
    expect(engine.currentWorkflow()!.id).toBe('parent');
    expect(engine.currentNode()!.id).toBe('P_INIT');
  });

  it('shrinks the stack by 1', async () => {
    const { engine } = await setup();
    engine.pushWorkflow('child');
    expect(engine.stack().length).toBe(1);
    engine.popWorkflow();
    expect(engine.stack().length).toBe(0);
  });

  it('emits workflow:pop event', async () => {
    const { engine } = await setup();
    engine.pushWorkflow('child');

    const events: unknown[] = [];
    engine.on('workflow:pop', (p) => events.push(p));
    engine.popWorkflow();

    expect(events.length).toBe(1);
  });

  it('emits node:enter for restored parent node after workflow:pop', async () => {
    const { engine } = await setup();
    engine.pushWorkflow('child');

    const order: string[] = [];
    engine.on('workflow:pop', () => order.push('workflow:pop'));
    engine.on('node:enter', (p: any) => order.push(`node:enter:${p.node.id}`));
    engine.popWorkflow();

    expect(order).toEqual(['workflow:pop', 'node:enter:P_INIT']);
  });

  it('returns { status: popped } with correct workflow and node', async () => {
    const { engine } = await setup();
    engine.pushWorkflow('child');
    const result = engine.popWorkflow();

    expect(result.status).toBe('popped');
    if (result.status === 'popped') {
      expect(result.workflow.id).toBe('parent');
      expect(result.node.id).toBe('P_INIT');
    }
  });

  it('sets _skipInvocation to true after pop', async () => {
    const { engine } = await setup();
    engine.pushWorkflow('child');
    engine.popWorkflow();
    const snap = engine.snapshot();
    expect(snap.skipInvocation).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// popWorkflow — returnMap execution
// ---------------------------------------------------------------------------

describe('popWorkflow — returnMap execution', () => {
  it('child value appears in parent blackboard under parentKey', async () => {
    const agent = makeAgent(async (ctx) => {
      if (ctx.node.id === 'C_ENTRY') {
        return {
          type: 'advance',
          edge: 'e-c-entry-finish',
          writes: [{ key: 'childResult', value: 42 }],
        };
      }
      return { type: 'suspend', reason: 'waiting' };
    });
    const { engine } = await setup({ agent });

    engine.pushWorkflow('child', {
      returnMap: [{ parentKey: 'answer', childKey: 'childResult' }],
    });

    await engine.step(); // advance in child, writes childResult=42
    engine.popWorkflow();

    expect(engine.blackboard().get('answer')).toBe(42);
  });

  it('missing childKey is gracefully skipped', async () => {
    const { engine } = await setup();
    engine.pushWorkflow('child', {
      returnMap: [{ parentKey: 'answer', childKey: 'nonexistent' }],
    });

    const bbEvents: unknown[] = [];
    engine.on('blackboard:write', (p) => bbEvents.push(p));

    engine.popWorkflow();

    expect(bbEvents.length).toBe(0);
    expect(engine.blackboard().get('answer')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// _skipInvocation behavior after popWorkflow
// ---------------------------------------------------------------------------

describe('_skipInvocation behavior after popWorkflow', () => {
  it('restored parent node with invokes: next step() runs agent, not invocation', async () => {
    const agentCalls: string[] = [];
    const agent = makeAgent(async (ctx) => {
      agentCalls.push(ctx.node.id);
      if (ctx.node.id === 'PI_INIT') {
        return { type: 'advance', edge: 'e-pi-init-invoke', writes: [] };
      }
      if (ctx.node.id === 'PI_INVOKE') {
        return { type: 'advance', edge: 'e-pi-invoke-end', writes: [] };
      }
      return { type: 'suspend', reason: 'waiting' };
    });

    const registry = new WorkflowRegistry();
    registry.register(parentWithInvoke());
    registry.register(childWorkflow());
    const engine = new ReflexEngine(registry, agent);
    await engine.init('parent-inv');

    // Advance to the invocation node
    await engine.step(); // PI_INIT → PI_INVOKE (agent called for PI_INIT)

    // Now at PI_INVOKE — instead of letting declarative invocation fire,
    // do a manual push/pop cycle
    engine.pushWorkflow('child');
    engine.popWorkflow();

    // Next step should run the agent at PI_INVOKE (skip re-invocation)
    agentCalls.length = 0;
    await engine.step(); // should call agent for PI_INVOKE, advance to PI_END

    expect(agentCalls).toContain('PI_INVOKE');
    expect(engine.currentNode()!.id).toBe('PI_END');
  });
});

// ---------------------------------------------------------------------------
// Full round-trip: push → step in child → pop
// ---------------------------------------------------------------------------

describe('full round-trip: push → step in child → pop', () => {
  it('push child, advance through it, pop, resume parent', async () => {
    const agent = makeAgent(async (ctx) => {
      if (ctx.node.id === 'P_INIT') {
        return { type: 'advance', edge: 'e-p-init-work', writes: [] };
      }
      if (ctx.node.id === 'C_ENTRY') {
        return {
          type: 'advance',
          edge: 'e-c-entry-finish',
          writes: [{ key: 'output', value: 'done' }],
        };
      }
      return { type: 'suspend', reason: 'waiting' };
    });
    const { engine } = await setup({ agent });

    // Advance parent to P_WORK
    await engine.step();
    expect(engine.currentNode()!.id).toBe('P_WORK');

    // Push child workflow with returnMap
    engine.pushWorkflow('child', {
      returnMap: [{ parentKey: 'childOutput', childKey: 'output' }],
    });
    expect(engine.currentWorkflow()!.id).toBe('child');

    // Step through child
    await engine.step(); // C_ENTRY → C_FINISH
    expect(engine.currentNode()!.id).toBe('C_FINISH');

    // Pop back to parent
    engine.popWorkflow();
    expect(engine.currentWorkflow()!.id).toBe('parent');
    expect(engine.currentNode()!.id).toBe('P_WORK');
    expect(engine.blackboard().get('childOutput')).toBe('done');
  });
});

// ---------------------------------------------------------------------------
// Coexistence with declarative node.invokes
// ---------------------------------------------------------------------------

describe('coexistence with declarative node.invokes', () => {
  it('declarative invocation still triggers after a manual push/pop', async () => {
    const agent = makeAgent(async (ctx) => {
      if (ctx.node.id === 'PI_INIT') {
        return { type: 'advance', edge: 'e-pi-init-invoke', writes: [] };
      }
      if (ctx.node.id === 'C_ENTRY') {
        return { type: 'advance', edge: 'e-c-entry-finish', writes: [] };
      }
      if (ctx.node.id === 'C_FINISH') {
        return { type: 'complete', writes: [{ key: 'output', value: 'v1' }] };
      }
      if (ctx.node.id === 'PI_INVOKE') {
        return { type: 'advance', edge: 'e-pi-invoke-end', writes: [] };
      }
      return { type: 'suspend', reason: 'waiting' };
    });

    const registry = new WorkflowRegistry();
    registry.register(parentWithInvoke());
    registry.register(childWorkflow());
    const engine = new ReflexEngine(registry, agent);
    await engine.init('parent-inv');

    // Manual push/pop at entry node (before reaching the invocation node)
    engine.pushWorkflow('child');
    engine.popWorkflow();

    // Now advance to PI_INVOKE — the declarative invocation should fire
    await engine.step(); // agent resolves PI_INIT, advances to PI_INVOKE
    const stepResult = await engine.step(); // PI_INVOKE has invokes → auto push

    expect(stepResult.status).toBe('invoked');
    expect(engine.currentWorkflow()!.id).toBe('child');
  });

  it('manual push clears _skipInvocation so child invocations work', async () => {
    // After an automatic pop, _skipInvocation is true. If we then manually
    // push into a workflow whose entry node has invokes, the flag must be
    // cleared so the declarative invocation fires.
    const childWithInvoke: Workflow = {
      id: 'child-inv',
      entry: 'CI_ENTRY',
      nodes: {
        CI_ENTRY: invocationNode('CI_ENTRY', 'child'),
        CI_END: node('CI_END'),
      },
      edges: [
        { id: 'e-ci-entry-end', from: 'CI_ENTRY', to: 'CI_END', event: 'NEXT' },
      ],
    };

    const agent = makeAgent(async (ctx) => {
      if (ctx.node.id === 'C_ENTRY') {
        return { type: 'advance', edge: 'e-c-entry-finish', writes: [] };
      }
      if (ctx.node.id === 'C_FINISH') {
        return { type: 'complete', writes: [] };
      }
      return { type: 'suspend', reason: 'waiting' };
    });

    const registry = new WorkflowRegistry();
    registry.register(parentWorkflow());
    registry.register(childWorkflow());
    registry.register(childWithInvoke);
    const engine = new ReflexEngine(registry, agent);
    await engine.init('parent');

    // Simulate a prior pop that set _skipInvocation = true
    engine.pushWorkflow('child');
    engine.popWorkflow();
    expect(engine.snapshot().skipInvocation).toBe(true);

    // Now push into child-inv whose entry has invokes
    engine.pushWorkflow('child-inv');
    expect(engine.snapshot().skipInvocation).toBe(false);

    // Next step should trigger the declarative invocation at CI_ENTRY
    const result = await engine.step();
    expect(result.status).toBe('invoked');
    expect(engine.currentWorkflow()!.id).toBe('child');
  });
});

// ---------------------------------------------------------------------------
// Suspended-state behavior
// ---------------------------------------------------------------------------

describe('suspended-state behavior', () => {
  it('pushWorkflow works when status is suspended', async () => {
    const agent = makeAgent(async () => ({
      type: 'suspend',
      reason: 'awaiting input',
    }));
    const { engine } = await setup({ agent });

    // Suspend the engine
    await engine.step();
    expect(engine.status()).toBe('suspended');

    // Push should work
    const result = engine.pushWorkflow('child');
    expect(result.status).toBe('invoked');
    expect(engine.currentWorkflow()!.id).toBe('child');
  });

  it('popWorkflow works when status is suspended', async () => {
    const agent = makeAgent(async () => ({
      type: 'suspend',
      reason: 'awaiting input',
    }));
    const { engine } = await setup({ agent });

    // Push then suspend in child
    engine.pushWorkflow('child');
    await engine.step();
    expect(engine.status()).toBe('suspended');

    // Pop should work
    const result = engine.popWorkflow();
    expect(result.status).toBe('popped');
    expect(engine.currentWorkflow()!.id).toBe('parent');
  });

  it('engine status is preserved across push/pop', async () => {
    const agent = makeAgent(async () => ({
      type: 'suspend',
      reason: 'awaiting input',
    }));
    const { engine } = await setup({ agent });

    // Suspend the engine
    await engine.step();
    expect(engine.status()).toBe('suspended');

    // Push and pop — status should remain suspended
    engine.pushWorkflow('child');
    expect(engine.status()).toBe('suspended');
    engine.popWorkflow();
    expect(engine.status()).toBe('suspended');
  });
});

// ---------------------------------------------------------------------------
// Preconditions
// ---------------------------------------------------------------------------

describe('preconditions', () => {
  it('pushWorkflow throws before init()', () => {
    const registry = new WorkflowRegistry();
    registry.register(parentWorkflow());
    registry.register(childWorkflow());
    const agent = makeAgent(async () => ({ type: 'suspend', reason: '' }));
    const engine = new ReflexEngine(registry, agent);

    expect(() => engine.pushWorkflow('child')).toThrow(EngineError);
  });

  it('pushWorkflow throws for unregistered workflowId', async () => {
    const { engine } = await setup();
    expect(() => engine.pushWorkflow('nonexistent')).toThrow(EngineError);
  });

  it('pushWorkflow throws when status is completed', async () => {
    const agent = makeAgent(async () => ({ type: 'complete', writes: [] }));
    // Single-node workflow that completes immediately
    const singleNode: Workflow = {
      id: 'single',
      entry: 'ONLY',
      nodes: { ONLY: node('ONLY') },
      edges: [],
    };
    const registry = new WorkflowRegistry();
    registry.register(singleNode);
    registry.register(childWorkflow());
    const engine = new ReflexEngine(registry, agent);
    await engine.init('single');
    await engine.step(); // completes

    expect(engine.status()).toBe('completed');
    expect(() => engine.pushWorkflow('child')).toThrow(EngineError);
  });

  it('popWorkflow throws before init()', () => {
    const registry = new WorkflowRegistry();
    registry.register(parentWorkflow());
    const agent = makeAgent(async () => ({ type: 'suspend', reason: '' }));
    const engine = new ReflexEngine(registry, agent);

    expect(() => engine.popWorkflow()).toThrow(EngineError);
  });

  it('popWorkflow throws when stack is empty', async () => {
    const { engine } = await setup();
    expect(() => engine.popWorkflow()).toThrow(EngineError);
  });

  it('popWorkflow throws when status is completed', async () => {
    const agent = makeAgent(async () => ({ type: 'complete', writes: [] }));
    const singleNode: Workflow = {
      id: 'single',
      entry: 'ONLY',
      nodes: { ONLY: node('ONLY') },
      edges: [],
    };
    const registry = new WorkflowRegistry();
    registry.register(singleNode);
    const engine = new ReflexEngine(registry, agent);
    await engine.init('single');
    await engine.step();

    expect(engine.status()).toBe('completed');
    expect(() => engine.popWorkflow()).toThrow(EngineError);
  });
});
