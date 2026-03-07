import { describe, it, expect, vi } from 'vitest';
import { ReflexEngine, EngineError } from './engine';
import { WorkflowRegistry } from './registry';
import {
  Workflow,
  Node,
  DecisionAgent,
  DecisionContext,
  Decision,
  EngineEvent,
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
// Workflow Fixtures — 3-level chain: gp → mid → deep
// ---------------------------------------------------------------------------

function gpWorkflow(): Workflow {
  return {
    id: 'gp',
    entry: 'GP_INIT',
    nodes: {
      GP_INIT: node('GP_INIT'),
      GP_INVOKE: invocationNode('GP_INVOKE', 'mid', [
        { parentKey: 'gp_result', childKey: 'mid_output' },
      ]),
      GP_END: node('GP_END'),
    },
    edges: [
      { id: 'e-gp-init-invoke', from: 'GP_INIT', to: 'GP_INVOKE', event: 'NEXT' },
      { id: 'e-gp-invoke-end', from: 'GP_INVOKE', to: 'GP_END', event: 'NEXT' },
    ],
  };
}

function midWorkflow(): Workflow {
  return {
    id: 'mid',
    entry: 'MID_INIT',
    nodes: {
      MID_INIT: node('MID_INIT'),
      MID_INVOKE: invocationNode('MID_INVOKE', 'deep', [
        { parentKey: 'mid_output', childKey: 'deep_output' },
      ]),
      MID_END: node('MID_END'),
    },
    edges: [
      { id: 'e-mid-init-invoke', from: 'MID_INIT', to: 'MID_INVOKE', event: 'NEXT' },
      { id: 'e-mid-invoke-end', from: 'MID_INVOKE', to: 'MID_END', event: 'NEXT' },
    ],
  };
}

function deepWorkflow(): Workflow {
  return {
    id: 'deep',
    entry: 'DEEP_INIT',
    nodes: {
      DEEP_INIT: node('DEEP_INIT'),
      DEEP_END: node('DEEP_END'),
    },
    edges: [
      { id: 'e-deep-init-end', from: 'DEEP_INIT', to: 'DEEP_END', event: 'NEXT' },
    ],
  };
}

// ---------------------------------------------------------------------------
// Shared setup: drive engine to 3-deep suspended state
// ---------------------------------------------------------------------------

/**
 * Sets up gp → mid → deep, drives the engine to DEEP_INIT (suspended).
 * Stack = [mid_frame, gp_frame] (length 2), active = deep at DEEP_INIT.
 *
 * gp blackboard has 'gp_value', mid blackboard has 'mid_value'.
 */
async function setupSuspendedAtDepth3() {
  const registry = new WorkflowRegistry();
  registry.register(gpWorkflow());
  registry.register(midWorkflow());
  registry.register(deepWorkflow());

  const resolveFn = vi.fn()
    // GP_INIT → GP_INVOKE (writes gp_value)
    .mockResolvedValueOnce({
      type: 'advance',
      edge: 'e-gp-init-invoke',
      writes: [{ key: 'gp_value', value: 'from_gp' }],
    })
    // MID_INIT → MID_INVOKE (writes mid_value)
    .mockResolvedValueOnce({
      type: 'advance',
      edge: 'e-mid-init-invoke',
      writes: [{ key: 'mid_value', value: 'from_mid' }],
    })
    // DEEP_INIT → suspend
    .mockResolvedValueOnce({
      type: 'suspend',
      reason: 'awaiting input',
    });

  const engine = new ReflexEngine(registry, makeAgent(resolveFn));
  await engine.init('gp');
  await engine.run(); // runs until suspended at DEEP_INIT

  return { engine, registry, resolveFn };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('unwindToDepth', () => {
  // -------------------------------------------------------------------------
  // Basic unwind
  // -------------------------------------------------------------------------

  describe('basic unwind', () => {
    it('unwinds to depth 1 — mid becomes active, stack has gp only', async () => {
      const { engine } = await setupSuspendedAtDepth3();

      // Before: stack = [mid, gp] (length 2), active = deep
      expect(engine.stack()).toHaveLength(2);
      expect(engine.currentWorkflow()!.id).toBe('deep');

      engine.unwindToDepth(1);

      expect(engine.stack()).toHaveLength(1);
      expect(engine.stack()[0].workflowId).toBe('gp');
      expect(engine.currentWorkflow()!.id).toBe('mid');
      expect(engine.currentNode()!.id).toBe('MID_INVOKE');
    });

    it('unwinds to depth 0 — gp becomes active, stack empty', async () => {
      const { engine } = await setupSuspendedAtDepth3();

      engine.unwindToDepth(0);

      expect(engine.stack()).toHaveLength(0);
      expect(engine.currentWorkflow()!.id).toBe('gp');
      expect(engine.currentNode()!.id).toBe('GP_INVOKE');
    });
  });

  // -------------------------------------------------------------------------
  // No returnMap processing
  // -------------------------------------------------------------------------

  describe('no returnMap processing', () => {
    it('parent blackboard has no returnMap-promoted values after unwind', async () => {
      const { engine } = await setupSuspendedAtDepth3();

      engine.unwindToDepth(0);

      // gp's returnMap expects 'gp_result' from child's 'mid_output'.
      // After unwind (not normal pop), 'gp_result' should NOT exist.
      expect(engine.blackboard().get('gp_result')).toBeUndefined();
      expect(engine.blackboard().has('gp_result')).toBe(false);
    });

    it('ancestor blackboard values written before invocation are preserved', async () => {
      const { engine } = await setupSuspendedAtDepth3();

      engine.unwindToDepth(0);

      // gp wrote 'gp_value' before invoking mid — this is in gp's own blackboard
      expect(engine.blackboard().get('gp_value')).toBe('from_gp');
    });
  });

  // -------------------------------------------------------------------------
  // No events emitted
  // -------------------------------------------------------------------------

  describe('no events emitted', () => {
    it('does not emit any events during unwind', async () => {
      const { engine } = await setupSuspendedAtDepth3();

      const allEvents: EngineEvent[] = [
        'node:enter',
        'node:exit',
        'edge:traverse',
        'workflow:push',
        'workflow:pop',
        'blackboard:write',
        'engine:complete',
        'engine:suspend',
        'engine:error',
      ];
      const fired: EngineEvent[] = [];
      for (const evt of allEvents) {
        engine.on(evt, () => fired.push(evt));
      }

      engine.unwindToDepth(0);

      expect(fired).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Engine status
  // -------------------------------------------------------------------------

  describe('engine status', () => {
    it('remains suspended after unwind', async () => {
      const { engine } = await setupSuspendedAtDepth3();

      engine.unwindToDepth(1);

      expect(engine.status()).toBe('suspended');
    });
  });

  // -------------------------------------------------------------------------
  // No-op when n === stack.length
  // -------------------------------------------------------------------------

  describe('no-op at current depth', () => {
    it('n === stack.length is a no-op — state unchanged', async () => {
      const { engine } = await setupSuspendedAtDepth3();

      const stackBefore = engine.stack();
      const workflowBefore = engine.currentWorkflow()!.id;
      const nodeBefore = engine.currentNode()!.id;

      engine.unwindToDepth(2); // stack.length is 2

      expect(engine.stack()).toHaveLength(stackBefore.length);
      expect(engine.currentWorkflow()!.id).toBe(workflowBefore);
      expect(engine.currentNode()!.id).toBe(nodeBefore);
    });
  });

  // -------------------------------------------------------------------------
  // Resume after unwind
  // -------------------------------------------------------------------------

  describe('resume after unwind', () => {
    it('run() resumes at target node — agent can advance normally', async () => {
      const { engine, resolveFn } = await setupSuspendedAtDepth3();

      engine.unwindToDepth(0); // back to gp at GP_INVOKE

      // Now set up agent to advance from GP_INVOKE → GP_END → complete
      resolveFn
        .mockResolvedValueOnce({ type: 'advance', edge: 'e-gp-invoke-end' })
        .mockResolvedValueOnce({ type: 'complete' });

      const result = await engine.run();

      expect(result.status).toBe('completed');
    });

    it('skipInvocation is set — does not re-trigger sub-workflow', async () => {
      const { engine, resolveFn } = await setupSuspendedAtDepth3();

      engine.unwindToDepth(0); // back to gp at GP_INVOKE

      // Agent should be called at GP_INVOKE (normal edge logic, not invocation)
      resolveFn
        .mockResolvedValueOnce({ type: 'advance', edge: 'e-gp-invoke-end' })
        .mockResolvedValueOnce({ type: 'complete' });

      await engine.run();

      // Agent was called at GP_INVOKE (advance) and GP_END (complete) — not invocation
      // Total calls: 3 from setup + 2 from resume = 5
      expect(resolveFn).toHaveBeenCalledTimes(5);
    });
  });

  // -------------------------------------------------------------------------
  // Precondition errors
  // -------------------------------------------------------------------------

  describe('precondition errors', () => {
    it('throws when called before init()', () => {
      const registry = new WorkflowRegistry();
      registry.register(gpWorkflow());
      const agent = makeAgent(async () => ({ type: 'complete' }));
      const engine = new ReflexEngine(registry, agent);

      expect(() => engine.unwindToDepth(0)).toThrow(EngineError);
      expect(() => engine.unwindToDepth(0)).toThrow(/before init/);
    });

    it('throws when engine is idle', () => {
      const registry = new WorkflowRegistry();
      registry.register(gpWorkflow());
      const agent = makeAgent(async () => ({ type: 'complete' }));
      const engine = new ReflexEngine(registry, agent);

      expect(() => engine.unwindToDepth(0)).toThrow(EngineError);
    });

    it('throws when engine is running', async () => {
      const registry = new WorkflowRegistry();
      registry.register(gpWorkflow());
      registry.register(midWorkflow());
      registry.register(deepWorkflow());

      let capturedEngine: ReflexEngine | null = null;
      let caughtError: Error | null = null;

      const agent = makeAgent(async (ctx) => {
        // Try calling unwindToDepth during agent resolution (engine is running)
        if (ctx.node.id === 'GP_INIT' && capturedEngine) {
          try {
            capturedEngine.unwindToDepth(0);
          } catch (e) {
            caughtError = e as Error;
          }
        }
        return { type: 'suspend', reason: 'stop' };
      });

      const engine = new ReflexEngine(registry, agent);
      capturedEngine = engine;
      await engine.init('gp');
      await engine.step();

      expect(caughtError).toBeInstanceOf(EngineError);
      expect(caughtError!.message).toMatch(/suspended/);
    });

    it('throws when engine is completed', async () => {
      const registry = new WorkflowRegistry();
      const simple: Workflow = {
        id: 'simple',
        entry: 'ONLY',
        nodes: { ONLY: node('ONLY') },
        edges: [],
      };
      registry.register(simple);

      const agent = makeAgent(async () => ({ type: 'complete' }));
      const engine = new ReflexEngine(registry, agent);
      await engine.init('simple');
      await engine.run();

      expect(engine.status()).toBe('completed');
      expect(() => engine.unwindToDepth(0)).toThrow(EngineError);
      expect(() => engine.unwindToDepth(0)).toThrow(/suspended/);
    });

    it('throws for negative depth', async () => {
      const { engine } = await setupSuspendedAtDepth3();

      expect(() => engine.unwindToDepth(-1)).toThrow(EngineError);
      expect(() => engine.unwindToDepth(-1)).toThrow(/out of range/);
    });

    it('throws for depth > stack.length', async () => {
      const { engine } = await setupSuspendedAtDepth3();

      expect(() => engine.unwindToDepth(3)).toThrow(EngineError);
      expect(() => engine.unwindToDepth(3)).toThrow(/out of range/);
    });
  });

  // -------------------------------------------------------------------------
  // Snapshot after unwind
  // -------------------------------------------------------------------------

  describe('snapshot after unwind', () => {
    it('snapshot captures unwound state correctly', async () => {
      const { engine } = await setupSuspendedAtDepth3();

      engine.unwindToDepth(1);

      const snap = engine.snapshot();
      expect(snap.currentWorkflowId).toBe('mid');
      expect(snap.currentNodeId).toBe('MID_INVOKE');
      expect(snap.stack).toHaveLength(1);
      expect(snap.stack[0].workflowId).toBe('gp');
      expect(snap.status).toBe('suspended');
      expect(snap.skipInvocation).toBe(true);
    });
  });
});
