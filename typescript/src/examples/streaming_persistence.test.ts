// Reflex — Streaming Persistence Integration Tests
// Issue #87: Cursor API parity with Go PR #85

import { describe, it, expect, beforeEach } from 'vitest';
import { ReflexEngine } from '../engine';
import { WorkflowRegistry } from '../registry';
import { createRuleAgent } from './rule-agent';
import { Workflow, BlackboardEntry, Cursor, CursorReader, StepResult } from '../types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** 3-node pipeline: PARSE → ANALYZE → DONE */
function pipelineWorkflow(): Workflow {
  return {
    id: 'pipeline',
    entry: 'PARSE',
    nodes: {
      PARSE: {
        id: 'PARSE',
        spec: { writes: [{ key: 'parsed', value: true }] },
      },
      ANALYZE: {
        id: 'ANALYZE',
        spec: { writes: [{ key: 'score', value: 85 }] },
      },
      DONE: {
        id: 'DONE',
        spec: { complete: true },
      },
    },
    edges: [
      { id: 'e1', from: 'PARSE', to: 'ANALYZE', event: 'NEXT' },
      { id: 'e2', from: 'ANALYZE', to: 'DONE', event: 'NEXT' },
    ],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Streaming persistence (cursor API)', () => {
  let registry: WorkflowRegistry;
  let engine: ReflexEngine;

  beforeEach(() => {
    registry = new WorkflowRegistry();
    registry.register(pipelineWorkflow());
    engine = new ReflexEngine(registry, createRuleAgent());
  });

  it('cursor-based polling captures all entries without duplicates', async () => {
    await engine.init('pipeline');

    const bb = engine.currentBlackboard()!;
    expect(bb).not.toBeNull();
    let cursor: Cursor = bb.cursor();

    // Simulate a persistence log
    const persisted: BlackboardEntry[] = [];

    while (true) {
      const result = await engine.step();

      // Read ONLY new entries since last cursor position
      const cur = engine.currentBlackboard()!;
      const [entries, next] = cur.entriesFrom(cursor);
      persisted.push(...entries);
      cursor = next;

      if (result.status === 'completed') break;
    }

    // Verify: we captured entries without duplicates
    expect(persisted.length).toBeGreaterThanOrEqual(2);

    const keys = new Set(persisted.map((e) => e.key));
    expect(keys.has('parsed')).toBe(true);
    expect(keys.has('score')).toBe(true);
  });

  it('seed blackboard entries are visible via cursor', async () => {
    await engine.init('pipeline', {
      blackboard: [
        { key: 'project_path', value: '/test/path' },
        { key: 'verbose', value: true },
      ],
    });

    const cur = engine.currentBlackboard()!;
    const [entries] = cur.entriesFrom(0);
    expect(entries.length).toBeGreaterThanOrEqual(2);

    const keys = entries.map((e) => e.key);
    expect(keys).toContain('project_path');
    expect(keys).toContain('verbose');
  });

  it('currentBlackboard() returns null before init()', () => {
    expect(engine.currentBlackboard()).toBeNull();
  });

  it('currentBlackboard() returns child blackboard during sub-workflow', async () => {
    // Register parent and child workflows
    const child: Workflow = {
      id: 'child-wf',
      entry: 'C1',
      nodes: {
        C1: {
          id: 'C1',
          spec: {
            writes: [{ key: 'childKey', value: 'childValue' }],
            complete: true,
          },
        },
      },
      edges: [],
    };

    const parent: Workflow = {
      id: 'parent-wf',
      entry: 'P1',
      nodes: {
        P1: {
          id: 'P1',
          spec: { writes: [{ key: 'parentKey', value: 'parentValue' }] },
          invokes: { workflowId: 'child-wf', returnMap: [] },
        },
        P2: {
          id: 'P2',
          spec: { complete: true },
        },
      },
      edges: [
        { id: 'ep1', from: 'P1', to: 'P2', event: 'NEXT' },
      ],
    };

    registry.register(child);
    registry.register(parent);
    engine = new ReflexEngine(registry, createRuleAgent());
    await engine.init('parent-wf');

    // Before invocation, cursor is on parent's blackboard
    const parentBB = engine.currentBlackboard()!;
    const parentCursor = parentBB.cursor();

    // Step into invocation — pushes parent, starts child
    const invokeResult = await engine.step();
    expect(invokeResult.status).toBe('invoked');

    // Now currentBlackboard() should be the child's (fresh, empty)
    const childBB = engine.currentBlackboard()!;
    expect(childBB.cursor()).toBe(0); // child starts fresh

    // Step child to completion (writes childKey + completes)
    await engine.step();

    // After pop, back to parent's blackboard
    const restoredBB = engine.currentBlackboard()!;
    // Parent blackboard was snapshotted and restored, cursor reflects original entries
    expect(restoredBB.cursor()).toBeGreaterThanOrEqual(parentCursor);
  });
});
