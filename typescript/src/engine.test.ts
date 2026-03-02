import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ReflexEngine, EngineError } from './engine';
import { WorkflowRegistry } from './registry';
import {
  Workflow,
  Node,
  DecisionAgent,
  DecisionContext,
  Decision,
  EngineEvent,
} from './types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal node with an opaque spec. */
function node(id: string): Node {
  return { id, spec: {} };
}

/** Wrap a resolve function as a DecisionAgent. */
function makeAgent(
  resolve: (ctx: DecisionContext) => Promise<Decision>,
): DecisionAgent {
  return { resolve };
}

/** Build a linear workflow: A → B → C → END (4 nodes, 3 edges). */
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

/** Build a single-node workflow (entry = terminal, 0 edges). */
function singleNodeWorkflow(): Workflow {
  return {
    id: 'single',
    entry: 'A',
    nodes: { A: node('A') },
    edges: [],
  };
}

/** Build a 2-node workflow for non-terminal complete testing. */
function nonTerminalCompleteWorkflow(): Workflow {
  return {
    id: 'non-terminal',
    entry: 'A',
    nodes: {
      A: node('A'),
      B: node('B'),
    },
    edges: [{ id: 'e-ab', from: 'A', to: 'B', event: 'NEXT' }],
  };
}

/** Build a fan-out workflow: CHOOSE → B (guarded), CHOOSE → C (no guard). */
function fanOutWorkflow(): Workflow {
  return {
    id: 'fanout',
    entry: 'CHOOSE',
    nodes: {
      CHOOSE: node('CHOOSE'),
      B: node('B'),
      C: node('C'),
    },
    edges: [
      {
        id: 'e-flag',
        from: 'CHOOSE',
        to: 'B',
        event: 'FLAGGED',
        guard: { type: 'exists', key: 'flag' },
      },
      { id: 'e-default', from: 'CHOOSE', to: 'C', event: 'DEFAULT' },
    ],
  };
}

/**
 * Build a fan-out workflow with a setup node before the fan-out point.
 * SETUP → CHOOSE → B (guarded) | C (no guard).
 * Allows writing 'flag' during the advance from SETUP to CHOOSE.
 */
function fanOutWithSetupWorkflow(): Workflow {
  return {
    id: 'fanout-setup',
    entry: 'SETUP',
    nodes: {
      SETUP: node('SETUP'),
      CHOOSE: node('CHOOSE'),
      B: node('B'),
      C: node('C'),
    },
    edges: [
      { id: 'e-setup', from: 'SETUP', to: 'CHOOSE', event: 'NEXT' },
      {
        id: 'e-flag',
        from: 'CHOOSE',
        to: 'B',
        event: 'FLAGGED',
        guard: { type: 'exists', key: 'flag' },
      },
      { id: 'e-default', from: 'CHOOSE', to: 'C', event: 'DEFAULT' },
    ],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ReflexEngine', () => {
  let registry: WorkflowRegistry;

  beforeEach(() => {
    registry = new WorkflowRegistry();
  });

  // -----------------------------------------------------------------------
  // init() and initial state
  // -----------------------------------------------------------------------

  describe('init() and initial state', () => {
    it('returns a non-empty session ID', async () => {
      registry.register(singleNodeWorkflow());
      const agent = makeAgent(vi.fn());
      const engine = new ReflexEngine(registry, agent);

      const sessionId = await engine.init('single');
      expect(sessionId).toBeTruthy();
      expect(typeof sessionId).toBe('string');
    });

    it('sessionId() matches the returned value', async () => {
      registry.register(singleNodeWorkflow());
      const agent = makeAgent(vi.fn());
      const engine = new ReflexEngine(registry, agent);

      const returned = await engine.init('single');
      expect(engine.sessionId()).toBe(returned);
    });

    it('currentNode() returns the entry node after init', async () => {
      registry.register(linearWorkflow());
      const agent = makeAgent(vi.fn());
      const engine = new ReflexEngine(registry, agent);

      await engine.init('linear');
      const current = engine.currentNode();
      expect(current).not.toBeNull();
      expect(current!.id).toBe('A');
    });

    it('currentWorkflow() returns the workflow after init', async () => {
      registry.register(linearWorkflow());
      const agent = makeAgent(vi.fn());
      const engine = new ReflexEngine(registry, agent);

      await engine.init('linear');
      const wf = engine.currentWorkflow();
      expect(wf).not.toBeNull();
      expect(wf!.id).toBe('linear');
    });

    it('status() is running after init', async () => {
      registry.register(singleNodeWorkflow());
      const agent = makeAgent(vi.fn());
      const engine = new ReflexEngine(registry, agent);

      await engine.init('single');
      expect(engine.status()).toBe('running');
    });

    it('blackboard is empty after init', async () => {
      registry.register(singleNodeWorkflow());
      const agent = makeAgent(vi.fn());
      const engine = new ReflexEngine(registry, agent);

      await engine.init('single');
      expect(engine.blackboard().entries()).toHaveLength(0);
    });

    it('stack is empty after init', async () => {
      registry.register(singleNodeWorkflow());
      const agent = makeAgent(vi.fn());
      const engine = new ReflexEngine(registry, agent);

      await engine.init('single');
      expect(engine.stack()).toHaveLength(0);
    });

    it('throws EngineError for unregistered workflow', async () => {
      const agent = makeAgent(vi.fn());
      const engine = new ReflexEngine(registry, agent);

      await expect(engine.init('nonexistent')).rejects.toThrowError(
        EngineError,
      );
    });
  });

  // -----------------------------------------------------------------------
  // init() — seed blackboard
  // -----------------------------------------------------------------------

  describe('init() with seed blackboard', () => {
    it('seed entries are present on blackboard after init', async () => {
      registry.register(singleNodeWorkflow());
      const engine = new ReflexEngine(registry, makeAgent(vi.fn()));

      await engine.init('single', {
        blackboard: [
          { key: 'userId', value: 'abc-123' },
          { key: 'mode', value: 'fast' },
        ],
      });

      expect(engine.blackboard().get('userId')).toBe('abc-123');
      expect(engine.blackboard().get('mode')).toBe('fast');
    });

    it('seed entries have nodeId "__init__" source', async () => {
      registry.register(singleNodeWorkflow());
      const engine = new ReflexEngine(registry, makeAgent(vi.fn()));

      await engine.init('single', {
        blackboard: [{ key: 'foo', value: 'bar' }],
      });

      const entry = engine.blackboard().entries()[0];
      expect(entry.source.nodeId).toBe('__init__');
      expect(entry.source.workflowId).toBe('single');
      expect(entry.source.stackDepth).toBe(0);
    });

    it('emits blackboard:write for seed entries during init', async () => {
      registry.register(singleNodeWorkflow());
      const engine = new ReflexEngine(registry, makeAgent(vi.fn()));

      const writePayloads: unknown[] = [];
      engine.on('blackboard:write', (payload) => writePayloads.push(payload));

      await engine.init('single', {
        blackboard: [{ key: 'seed', value: 'value' }],
      });

      expect(writePayloads).toHaveLength(1);
      const payload = writePayloads[0] as {
        entries: { key: string }[];
        workflow: { id: string };
      };
      expect(payload.entries[0].key).toBe('seed');
      expect(payload.workflow.id).toBe('single');
    });

    it('seed entries are visible to guard evaluation on first step', async () => {
      // fanOutWorkflow: CHOOSE → B (guard: exists 'flag'), CHOOSE → C (no guard)
      // Without seeding, e-flag is invalid. With seeding 'flag', both edges valid.
      registry.register(fanOutWorkflow());
      const resolveFn = vi
        .fn()
        .mockResolvedValueOnce({ type: 'advance', edge: 'e-flag' });
      const engine = new ReflexEngine(registry, makeAgent(resolveFn));

      await engine.init('fanout', {
        blackboard: [{ key: 'flag', value: true }],
      });

      const result = await engine.step();
      expect(result.status).toBe('advanced');
      if (result.status === 'advanced') {
        expect(result.node.id).toBe('B');
      }
    });

    it('init() without options leaves blackboard empty (backward compatible)', async () => {
      registry.register(singleNodeWorkflow());
      const engine = new ReflexEngine(registry, makeAgent(vi.fn()));

      await engine.init('single');
      expect(engine.blackboard().entries()).toHaveLength(0);
    });

    it('init() with empty blackboard array leaves blackboard empty', async () => {
      registry.register(singleNodeWorkflow());
      const engine = new ReflexEngine(registry, makeAgent(vi.fn()));

      await engine.init('single', { blackboard: [] });
      expect(engine.blackboard().entries()).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // init() — entry node event
  // -----------------------------------------------------------------------

  describe('init() — entry node event', () => {
    it('emits node:enter for the entry node during init', async () => {
      registry.register(linearWorkflow());
      const engine = new ReflexEngine(registry, makeAgent(vi.fn()));

      const enterPayloads: unknown[] = [];
      engine.on('node:enter', (payload) => enterPayloads.push(payload));

      await engine.init('linear');

      expect(enterPayloads).toHaveLength(1);
      const payload = enterPayloads[0] as {
        node: { id: string };
        workflow: { id: string };
      };
      expect(payload.node.id).toBe('A');
      expect(payload.workflow.id).toBe('linear');
    });

    it('node:enter fires after blackboard:write when seed entries present', async () => {
      registry.register(singleNodeWorkflow());
      const engine = new ReflexEngine(registry, makeAgent(vi.fn()));

      const events: string[] = [];
      engine.on('blackboard:write', () => events.push('blackboard:write'));
      engine.on('node:enter', () => events.push('node:enter'));

      await engine.init('single', {
        blackboard: [{ key: 'seed', value: 'value' }],
      });

      expect(events).toEqual(['blackboard:write', 'node:enter']);
    });

    it('first step does not double-emit node:enter for the entry node', async () => {
      registry.register(linearWorkflow());
      const resolveFn = vi
        .fn()
        .mockResolvedValueOnce({ type: 'advance', edge: 'e-ab' });
      const engine = new ReflexEngine(registry, makeAgent(resolveFn));

      const enterNodeIds: string[] = [];
      engine.on('node:enter', (payload) => {
        const p = payload as { node: { id: string } };
        enterNodeIds.push(p.node.id);
      });

      await engine.init('linear');
      await engine.step();

      // Init emits node:enter for A, step advances A→B emitting node:enter for B.
      // No double A.
      expect(enterNodeIds).toEqual(['A', 'B']);
    });
  });

  // -----------------------------------------------------------------------
  // step() — advance
  // -----------------------------------------------------------------------

  describe('step() — advance', () => {
    it('returns advanced status with the target node', async () => {
      registry.register(linearWorkflow());
      const resolveFn = vi
        .fn()
        .mockResolvedValueOnce({ type: 'advance', edge: 'e-ab' });
      const engine = new ReflexEngine(registry, makeAgent(resolveFn));

      await engine.init('linear');
      const result = await engine.step();

      expect(result.status).toBe('advanced');
      if (result.status === 'advanced') {
        expect(result.node.id).toBe('B');
      }
    });

    it('updates currentNode() to the target node', async () => {
      registry.register(linearWorkflow());
      const resolveFn = vi
        .fn()
        .mockResolvedValueOnce({ type: 'advance', edge: 'e-ab' });
      const engine = new ReflexEngine(registry, makeAgent(resolveFn));

      await engine.init('linear');
      await engine.step();

      expect(engine.currentNode()!.id).toBe('B');
    });

    it('status() remains running after advance', async () => {
      registry.register(linearWorkflow());
      const resolveFn = vi
        .fn()
        .mockResolvedValueOnce({ type: 'advance', edge: 'e-ab' });
      const engine = new ReflexEngine(registry, makeAgent(resolveFn));

      await engine.init('linear');
      await engine.step();

      expect(engine.status()).toBe('running');
    });

    it('emits events in order: node:exit → edge:traverse → node:enter (no writes)', async () => {
      registry.register(linearWorkflow());
      const resolveFn = vi
        .fn()
        .mockResolvedValueOnce({ type: 'advance', edge: 'e-ab' });
      const engine = new ReflexEngine(registry, makeAgent(resolveFn));

      const events: string[] = [];
      engine.on('node:exit', () => events.push('node:exit'));
      engine.on('edge:traverse', () => events.push('edge:traverse'));
      engine.on('blackboard:write', () => events.push('blackboard:write'));
      engine.on('node:enter', () => events.push('node:enter'));

      await engine.init('linear');
      await engine.step();

      expect(events).toEqual([
        'node:enter',
        'node:exit',
        'edge:traverse',
        'node:enter',
      ]);
    });

    it('emits blackboard:write between edge:traverse and node:enter when writes present', async () => {
      registry.register(linearWorkflow());
      const resolveFn = vi.fn().mockResolvedValueOnce({
        type: 'advance',
        edge: 'e-ab',
        writes: [{ key: 'result', value: 42 }],
      });
      const engine = new ReflexEngine(registry, makeAgent(resolveFn));

      const events: string[] = [];
      engine.on('node:exit', () => events.push('node:exit'));
      engine.on('edge:traverse', () => events.push('edge:traverse'));
      engine.on('blackboard:write', () => events.push('blackboard:write'));
      engine.on('node:enter', () => events.push('node:enter'));

      await engine.init('linear');
      await engine.step();

      expect(events).toEqual([
        'node:enter',
        'node:exit',
        'edge:traverse',
        'blackboard:write',
        'node:enter',
      ]);
    });

    it('persists blackboard writes from advance decisions', async () => {
      registry.register(linearWorkflow());
      const resolveFn = vi.fn().mockResolvedValueOnce({
        type: 'advance',
        edge: 'e-ab',
        writes: [{ key: 'answer', value: 42 }],
      });
      const engine = new ReflexEngine(registry, makeAgent(resolveFn));

      await engine.init('linear');
      await engine.step();

      expect(engine.blackboard().get('answer')).toBe(42);
    });
  });

  // -----------------------------------------------------------------------
  // step() — suspend
  // -----------------------------------------------------------------------

  describe('step() — suspend', () => {
    it('returns suspended status with reason', async () => {
      registry.register(linearWorkflow());
      const resolveFn = vi
        .fn()
        .mockResolvedValueOnce({ type: 'suspend', reason: 'awaiting input' });
      const engine = new ReflexEngine(registry, makeAgent(resolveFn));

      await engine.init('linear');
      const result = await engine.step();

      expect(result.status).toBe('suspended');
      if (result.status === 'suspended') {
        expect(result.reason).toBe('awaiting input');
      }
    });

    it('status() becomes suspended', async () => {
      registry.register(linearWorkflow());
      const resolveFn = vi
        .fn()
        .mockResolvedValueOnce({ type: 'suspend', reason: 'wait' });
      const engine = new ReflexEngine(registry, makeAgent(resolveFn));

      await engine.init('linear');
      await engine.step();

      expect(engine.status()).toBe('suspended');
    });

    it('currentNode() does not change after suspend', async () => {
      registry.register(linearWorkflow());
      const resolveFn = vi
        .fn()
        .mockResolvedValueOnce({ type: 'suspend', reason: 'wait' });
      const engine = new ReflexEngine(registry, makeAgent(resolveFn));

      await engine.init('linear');
      await engine.step();

      expect(engine.currentNode()!.id).toBe('A');
    });

    it('engine is resumable after suspend — next step() processes new decision', async () => {
      registry.register(linearWorkflow());
      const resolveFn = vi
        .fn()
        .mockResolvedValueOnce({ type: 'suspend', reason: 'wait' })
        .mockResolvedValueOnce({ type: 'advance', edge: 'e-ab' });
      const engine = new ReflexEngine(registry, makeAgent(resolveFn));

      await engine.init('linear');
      await engine.step(); // suspend
      expect(engine.status()).toBe('suspended');

      const result = await engine.step(); // resume and advance
      expect(result.status).toBe('advanced');
      expect(engine.status()).toBe('running');
      expect(engine.currentNode()!.id).toBe('B');
    });

    it('emits engine:suspend event', async () => {
      registry.register(linearWorkflow());
      const resolveFn = vi
        .fn()
        .mockResolvedValueOnce({ type: 'suspend', reason: 'awaiting input' });
      const engine = new ReflexEngine(registry, makeAgent(resolveFn));

      let suspendPayload: unknown = undefined;
      engine.on('engine:suspend', (payload) => {
        suspendPayload = payload;
      });

      await engine.init('linear');
      await engine.step();

      expect(suspendPayload).toBeDefined();
      expect((suspendPayload as { reason: string }).reason).toBe(
        'awaiting input',
      );
    });

    it('persists writes to blackboard when suspending with writes', async () => {
      registry.register(linearWorkflow());
      const resolveFn = vi
        .fn()
        .mockResolvedValueOnce({
          type: 'suspend',
          reason: 'rate limit',
          writes: [
            { key: 'progress', value: 25 },
            { key: 'status', value: 'processing' },
          ],
        });
      const engine = new ReflexEngine(registry, makeAgent(resolveFn));

      await engine.init('linear');
      const result = await engine.step();

      expect(result.status).toBe('suspended');
      expect(engine.blackboard().get('progress')).toBe(25);
      expect(engine.blackboard().get('status')).toBe('processing');
    });

    it('emits blackboard:write event before engine:suspend when writes present', async () => {
      registry.register(linearWorkflow());
      const resolveFn = vi.fn().mockResolvedValueOnce({
        type: 'suspend',
        reason: 'test',
        writes: [{ key: 'k', value: 'v' }],
      });
      const engine = new ReflexEngine(registry, makeAgent(resolveFn));

      const events: string[] = [];
      engine.on('blackboard:write', () => events.push('blackboard:write'));
      engine.on('engine:suspend', () => events.push('engine:suspend'));

      await engine.init('linear');
      await engine.step();

      expect(events).toEqual(['blackboard:write', 'engine:suspend']);
    });

    it('suspend writes are still visible on blackboard after resume and advance', async () => {
      registry.register(linearWorkflow());
      const resolveFn = vi
        .fn()
        .mockResolvedValueOnce({
          type: 'suspend',
          reason: 'rate limit',
          writes: [{ key: 'progress', value: 25 }],
        })
        .mockResolvedValueOnce({ type: 'advance', edge: 'e-ab' });
      const engine = new ReflexEngine(registry, makeAgent(resolveFn));

      await engine.init('linear');
      await engine.step(); // suspend with writes
      await engine.step(); // resume → advance

      expect(engine.status()).toBe('running');
      expect(engine.blackboard().get('progress')).toBe(25);
    });
  });

  // -----------------------------------------------------------------------
  // step() — complete at terminal node
  // -----------------------------------------------------------------------

  describe('step() — complete at terminal node', () => {
    it('returns completed status', async () => {
      registry.register(singleNodeWorkflow());
      const resolveFn = vi
        .fn()
        .mockResolvedValueOnce({ type: 'complete' });
      const engine = new ReflexEngine(registry, makeAgent(resolveFn));

      await engine.init('single');
      const result = await engine.step();

      expect(result.status).toBe('completed');
    });

    it('status() becomes completed', async () => {
      registry.register(singleNodeWorkflow());
      const resolveFn = vi
        .fn()
        .mockResolvedValueOnce({ type: 'complete' });
      const engine = new ReflexEngine(registry, makeAgent(resolveFn));

      await engine.init('single');
      await engine.step();

      expect(engine.status()).toBe('completed');
    });

    it('emits engine:complete and persists blackboard writes', async () => {
      registry.register(singleNodeWorkflow());
      const resolveFn = vi.fn().mockResolvedValueOnce({
        type: 'complete',
        writes: [{ key: 'final', value: 'done' }],
      });
      const engine = new ReflexEngine(registry, makeAgent(resolveFn));

      let completeFired = false;
      engine.on('engine:complete', () => {
        completeFired = true;
      });

      await engine.init('single');
      await engine.step();

      expect(completeFired).toBe(true);
      expect(engine.blackboard().get('final')).toBe('done');
    });
  });

  // -----------------------------------------------------------------------
  // step() — complete at non-terminal node
  // -----------------------------------------------------------------------

  describe('step() — complete at non-terminal node', () => {
    it('returns suspended status with non-terminal reason', async () => {
      registry.register(nonTerminalCompleteWorkflow());
      const resolveFn = vi
        .fn()
        .mockResolvedValueOnce({ type: 'complete' });
      const engine = new ReflexEngine(registry, makeAgent(resolveFn));

      await engine.init('non-terminal');
      const result = await engine.step();

      expect(result.status).toBe('suspended');
      if (result.status === 'suspended') {
        expect(result.reason).toBe('complete at non-terminal node');
      }
    });

    it('status() becomes suspended (not completed)', async () => {
      registry.register(nonTerminalCompleteWorkflow());
      const resolveFn = vi
        .fn()
        .mockResolvedValueOnce({ type: 'complete' });
      const engine = new ReflexEngine(registry, makeAgent(resolveFn));

      await engine.init('non-terminal');
      await engine.step();

      expect(engine.status()).toBe('suspended');
    });

    it('emits engine:error event', async () => {
      registry.register(nonTerminalCompleteWorkflow());
      const resolveFn = vi
        .fn()
        .mockResolvedValueOnce({ type: 'complete' });
      const engine = new ReflexEngine(registry, makeAgent(resolveFn));

      let errorPayload: unknown = undefined;
      engine.on('engine:error', (payload) => {
        errorPayload = payload;
      });

      await engine.init('non-terminal');
      await engine.step();

      expect(errorPayload).toBeDefined();
      expect((errorPayload as { nodeId: string }).nodeId).toBe('A');
    });
  });

  // -----------------------------------------------------------------------
  // step() — invalid edge selection
  // -----------------------------------------------------------------------

  describe('step() — invalid edge selection', () => {
    it('returns suspended status with invalid edge reason', async () => {
      registry.register(linearWorkflow());
      const resolveFn = vi
        .fn()
        .mockResolvedValueOnce({ type: 'advance', edge: 'nonexistent' });
      const engine = new ReflexEngine(registry, makeAgent(resolveFn));

      await engine.init('linear');
      const result = await engine.step();

      expect(result.status).toBe('suspended');
      if (result.status === 'suspended') {
        expect(result.reason).toBe('Invalid edge selection');
      }
    });

    it('status() becomes suspended', async () => {
      registry.register(linearWorkflow());
      const resolveFn = vi
        .fn()
        .mockResolvedValueOnce({ type: 'advance', edge: 'nonexistent' });
      const engine = new ReflexEngine(registry, makeAgent(resolveFn));

      await engine.init('linear');
      await engine.step();

      expect(engine.status()).toBe('suspended');
    });

    it('emits engine:error and currentNode() does not change', async () => {
      registry.register(linearWorkflow());
      const resolveFn = vi
        .fn()
        .mockResolvedValueOnce({ type: 'advance', edge: 'nonexistent' });
      const engine = new ReflexEngine(registry, makeAgent(resolveFn));

      let errorFired = false;
      engine.on('engine:error', () => {
        errorFired = true;
      });

      await engine.init('linear');
      await engine.step();

      expect(errorFired).toBe(true);
      expect(engine.currentNode()!.id).toBe('A');
    });
  });

  // -----------------------------------------------------------------------
  // step() — fan-out
  // -----------------------------------------------------------------------

  describe('step() — fan-out', () => {
    it('agent picks unguarded edge when guard condition is not met', async () => {
      registry.register(fanOutWorkflow());
      const resolveFn = vi
        .fn()
        .mockResolvedValueOnce({ type: 'advance', edge: 'e-default' });
      const engine = new ReflexEngine(registry, makeAgent(resolveFn));

      await engine.init('fanout');
      // No 'flag' on blackboard → only e-default is valid
      const result = await engine.step();

      expect(result.status).toBe('advanced');
      if (result.status === 'advanced') {
        expect(result.node.id).toBe('C');
      }
    });

    it('agent picks guarded edge when guard condition is met', async () => {
      registry.register(fanOutWithSetupWorkflow());
      const resolveFn = vi
        .fn()
        // Step 1: advance from SETUP → CHOOSE, writing 'flag'
        .mockResolvedValueOnce({
          type: 'advance',
          edge: 'e-setup',
          writes: [{ key: 'flag', value: true }],
        })
        // Step 2: at CHOOSE, both edges valid, pick guarded edge
        .mockResolvedValueOnce({ type: 'advance', edge: 'e-flag' });
      const engine = new ReflexEngine(registry, makeAgent(resolveFn));

      await engine.init('fanout-setup');
      await engine.step(); // SETUP → CHOOSE (writes flag)
      const result = await engine.step(); // CHOOSE → B (guarded edge)

      expect(result.status).toBe('advanced');
      if (result.status === 'advanced') {
        expect(result.node.id).toBe('B');
      }
    });

    it('engine error when agent picks edge whose guard failed', async () => {
      registry.register(fanOutWorkflow());
      // No 'flag' on blackboard → e-flag guard fails → only e-default valid
      // Agent tries to pick e-flag anyway
      const resolveFn = vi
        .fn()
        .mockResolvedValueOnce({ type: 'advance', edge: 'e-flag' });
      const engine = new ReflexEngine(registry, makeAgent(resolveFn));

      let errorFired = false;
      engine.on('engine:error', () => {
        errorFired = true;
      });

      await engine.init('fanout');
      const result = await engine.step();

      expect(result.status).toBe('suspended');
      expect(errorFired).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // run()
  // -----------------------------------------------------------------------

  describe('run()', () => {
    it('runs a linear workflow to completion', async () => {
      registry.register(linearWorkflow());
      const resolveFn = vi
        .fn()
        .mockResolvedValueOnce({ type: 'advance', edge: 'e-ab' })
        .mockResolvedValueOnce({ type: 'advance', edge: 'e-bc' })
        .mockResolvedValueOnce({ type: 'advance', edge: 'e-ce' })
        .mockResolvedValueOnce({ type: 'complete' });
      const engine = new ReflexEngine(registry, makeAgent(resolveFn));

      await engine.init('linear');
      const result = await engine.run();

      expect(result.status).toBe('completed');
      expect(engine.status()).toBe('completed');
      expect(resolveFn).toHaveBeenCalledTimes(4);
    });

    it('stops and returns suspended when agent suspends mid-run', async () => {
      registry.register(linearWorkflow());
      const resolveFn = vi
        .fn()
        .mockResolvedValueOnce({ type: 'advance', edge: 'e-ab' })
        .mockResolvedValueOnce({ type: 'suspend', reason: 'need input' });
      const engine = new ReflexEngine(registry, makeAgent(resolveFn));

      await engine.init('linear');
      const result = await engine.run();

      expect(result.status).toBe('suspended');
      if (result.status === 'suspended') {
        expect(result.reason).toBe('need input');
      }
      expect(engine.status()).toBe('suspended');
      expect(resolveFn).toHaveBeenCalledTimes(2);
    });

    it('returns error when engine error occurs mid-run', async () => {
      registry.register(linearWorkflow());
      const resolveFn = vi
        .fn()
        .mockResolvedValueOnce({ type: 'advance', edge: 'e-ab' })
        .mockResolvedValueOnce({ type: 'advance', edge: 'bad-edge' });
      const engine = new ReflexEngine(registry, makeAgent(resolveFn));

      await engine.init('linear');
      const result = await engine.run();

      expect(result.status).toBe('error');
    });
  });

  // -----------------------------------------------------------------------
  // step() preconditions
  // -----------------------------------------------------------------------

  describe('step() preconditions', () => {
    it('throws EngineError when called before init()', async () => {
      const agent = makeAgent(vi.fn());
      const engine = new ReflexEngine(registry, agent);

      await expect(engine.step()).rejects.toThrowError(EngineError);
    });

    it('throws EngineError when status is completed', async () => {
      registry.register(singleNodeWorkflow());
      const resolveFn = vi
        .fn()
        .mockResolvedValueOnce({ type: 'complete' });
      const engine = new ReflexEngine(registry, makeAgent(resolveFn));

      await engine.init('single');
      await engine.step(); // completes
      expect(engine.status()).toBe('completed');

      await expect(engine.step()).rejects.toThrowError(EngineError);
    });

    it('run() throws EngineError when called before init()', async () => {
      const agent = makeAgent(vi.fn());
      const engine = new ReflexEngine(registry, agent);

      await expect(engine.run()).rejects.toThrowError(EngineError);
    });
  });
});
