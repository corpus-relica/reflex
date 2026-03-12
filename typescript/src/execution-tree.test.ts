import { describe, it, expect } from 'vitest';
import { ExecutionTree } from './execution-tree.js';

describe('ExecutionTree', () => {
  // -------------------------------------------------------------------------
  // record()
  // -------------------------------------------------------------------------

  describe('record()', () => {
    it('creates an active record with correct fields', () => {
      const tree = new ExecutionTree();
      const id = tree.record('parent-wf', 'node-A', 'child-wf');
      const record = tree.get(id)!;

      expect(record).toBeDefined();
      expect(record.invocationId).toBe(id);
      expect(record.parentWorkflowId).toBe('parent-wf');
      expect(record.parentNodeId).toBe('node-A');
      expect(record.childWorkflowId).toBe('child-wf');
      expect(record.status).toBe('active');
      expect(record.childInvocationIds).toEqual([]);
      expect(record.parentInvocationId).toBeUndefined();
      expect(record.returnMap).toBeUndefined();
    });

    it('stores parentInvocationId and returnMap when provided', () => {
      const tree = new ExecutionTree();
      const id = tree.record('parent-wf', 'node-A', 'child-wf', {
        parentInvocationId: 'parent-inv-1',
        returnMap: [{ parentKey: 'result', childKey: 'output' }],
      });
      const record = tree.get(id)!;

      expect(record.parentInvocationId).toBe('parent-inv-1');
      expect(record.returnMap).toEqual([
        { parentKey: 'result', childKey: 'output' },
      ]);
    });

    it('generates unique invocation IDs', () => {
      const tree = new ExecutionTree();
      const id1 = tree.record('wf', 'n', 'child');
      const id2 = tree.record('wf', 'n', 'child');
      expect(id1).not.toBe(id2);
    });
  });

  // -------------------------------------------------------------------------
  // complete()
  // -------------------------------------------------------------------------

  describe('complete()', () => {
    it('transitions active → completed', () => {
      const tree = new ExecutionTree();
      const id = tree.record('wf', 'n', 'child');
      tree.complete(id);
      expect(tree.get(id)!.status).toBe('completed');
    });

    it('is a no-op for unknown ID', () => {
      const tree = new ExecutionTree();
      // Should not throw
      tree.complete('nonexistent');
    });

    it('is a no-op if already completed', () => {
      const tree = new ExecutionTree();
      const id = tree.record('wf', 'n', 'child');
      tree.complete(id);
      tree.complete(id); // second call
      expect(tree.get(id)!.status).toBe('completed');
    });

    it('does not complete invalidated records', () => {
      const tree = new ExecutionTree();
      const id = tree.record('wf', 'n', 'child');
      tree.invalidate([id]);
      tree.complete(id);
      expect(tree.get(id)!.status).toBe('invalidated');
    });
  });

  // -------------------------------------------------------------------------
  // invalidate()
  // -------------------------------------------------------------------------

  describe('invalidate()', () => {
    it('marks records as invalidated', () => {
      const tree = new ExecutionTree();
      const id = tree.record('wf', 'n', 'child');
      const changed = tree.invalidate([id]);
      expect(tree.get(id)!.status).toBe('invalidated');
      expect(changed).toEqual([id]);
    });

    it('cascades to child invocations', () => {
      const tree = new ExecutionTree();
      const parentId = tree.record('wf', 'n', 'child-wf');
      const childId = tree.record('child-wf', 'cn', 'grandchild-wf');
      tree.addChildInvocation(parentId, childId);

      const changed = tree.invalidate([parentId]);
      expect(tree.get(parentId)!.status).toBe('invalidated');
      expect(tree.get(childId)!.status).toBe('invalidated');
      expect(changed).toContain(parentId);
      expect(changed).toContain(childId);
    });

    it('is idempotent for already-invalidated records', () => {
      const tree = new ExecutionTree();
      const id = tree.record('wf', 'n', 'child');
      tree.invalidate([id]);
      const changed = tree.invalidate([id]);
      expect(changed).toEqual([]);
    });

    it('returns empty array for unknown IDs', () => {
      const tree = new ExecutionTree();
      const changed = tree.invalidate(['nonexistent']);
      expect(changed).toEqual([]);
    });

    it('handles deep cascades (3 levels)', () => {
      const tree = new ExecutionTree();
      const a = tree.record('wf', 'n1', 'child1');
      const b = tree.record('child1', 'n2', 'child2');
      const c = tree.record('child2', 'n3', 'child3');
      tree.addChildInvocation(a, b);
      tree.addChildInvocation(b, c);

      const changed = tree.invalidate([a]);
      expect(changed).toHaveLength(3);
      expect(tree.get(a)!.status).toBe('invalidated');
      expect(tree.get(b)!.status).toBe('invalidated');
      expect(tree.get(c)!.status).toBe('invalidated');
    });
  });

  // -------------------------------------------------------------------------
  // pruneForReinvoke()
  // -------------------------------------------------------------------------

  describe('pruneForReinvoke()', () => {
    it('invalidates prior records for a (parent, node) pair', () => {
      const tree = new ExecutionTree();
      const first = tree.record('wf', 'nodeA', 'child');
      tree.complete(first);

      const pruned = tree.pruneForReinvoke('wf', 'nodeA');
      expect(pruned).toContain(first);
      expect(tree.get(first)!.status).toBe('invalidated');
    });

    it('returns empty array if no prior records', () => {
      const tree = new ExecutionTree();
      const pruned = tree.pruneForReinvoke('wf', 'nodeA');
      expect(pruned).toEqual([]);
    });

    it('does not affect records at different nodes', () => {
      const tree = new ExecutionTree();
      const atA = tree.record('wf', 'nodeA', 'child');
      const atB = tree.record('wf', 'nodeB', 'child');

      tree.pruneForReinvoke('wf', 'nodeA');
      expect(tree.get(atA)!.status).toBe('invalidated');
      expect(tree.get(atB)!.status).toBe('active');
    });

    it('cascades to descendants of pruned records', () => {
      const tree = new ExecutionTree();
      const parent = tree.record('wf', 'nodeA', 'child-wf');
      const child = tree.record('child-wf', 'cn', 'grandchild');
      tree.addChildInvocation(parent, child);

      const pruned = tree.pruneForReinvoke('wf', 'nodeA');
      expect(pruned).toHaveLength(2);
      expect(tree.get(child)!.status).toBe('invalidated');
    });
  });

  // -------------------------------------------------------------------------
  // addChildInvocation()
  // -------------------------------------------------------------------------

  describe('addChildInvocation()', () => {
    it('links child to parent record', () => {
      const tree = new ExecutionTree();
      const parentId = tree.record('wf', 'n', 'child-wf');
      const childId = tree.record('child-wf', 'cn', 'grandchild');

      tree.addChildInvocation(parentId, childId);
      expect(tree.get(parentId)!.childInvocationIds).toContain(childId);
    });

    it('is a no-op for unknown parent', () => {
      const tree = new ExecutionTree();
      const childId = tree.record('wf', 'n', 'child');
      // Should not throw
      tree.addChildInvocation('nonexistent', childId);
    });
  });

  // -------------------------------------------------------------------------
  // Query methods
  // -------------------------------------------------------------------------

  describe('query methods', () => {
    it('activeRecords() returns only active records', () => {
      const tree = new ExecutionTree();
      const a = tree.record('wf', 'n1', 'c1');
      const b = tree.record('wf', 'n2', 'c2');
      tree.complete(a);

      const active = tree.activeRecords();
      expect(active).toHaveLength(1);
      expect(active[0].invocationId).toBe(b);
    });

    it('completedAt() filters by parent workflow and node', () => {
      const tree = new ExecutionTree();
      tree.record('wf', 'nodeA', 'child1');
      const b = tree.record('wf', 'nodeA', 'child2');
      tree.complete(b);
      tree.record('wf', 'nodeB', 'child3');

      const completed = tree.completedAt('wf', 'nodeA');
      expect(completed).toHaveLength(1);
      expect(completed[0].invocationId).toBe(b);
    });

    it('invalidatedRecords() returns only invalidated', () => {
      const tree = new ExecutionTree();
      const a = tree.record('wf', 'n1', 'c1');
      tree.record('wf', 'n2', 'c2');
      tree.invalidate([a]);

      const inv = tree.invalidatedRecords();
      expect(inv).toHaveLength(1);
      expect(inv[0].invocationId).toBe(a);
    });

    it('allRecords() returns full map', () => {
      const tree = new ExecutionTree();
      tree.record('wf', 'n1', 'c1');
      tree.record('wf', 'n2', 'c2');

      const all = tree.allRecords();
      expect(all.size).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // Serialization
  // -------------------------------------------------------------------------

  describe('toState() / fromState()', () => {
    it('round-trips all records and status', () => {
      const tree = new ExecutionTree();
      const a = tree.record('wf', 'n1', 'c1', {
        parentInvocationId: undefined,
        returnMap: [{ parentKey: 'r', childKey: 'c' }],
      });
      const b = tree.record('wf', 'n2', 'c2', {
        parentInvocationId: a,
      });
      tree.addChildInvocation(a, b);
      tree.complete(a);

      const state = tree.toState();
      const restored = ExecutionTree.fromState(state);

      expect(restored.get(a)!.status).toBe('completed');
      expect(restored.get(a)!.childInvocationIds).toContain(b);
      expect(restored.get(a)!.returnMap).toEqual([
        { parentKey: 'r', childKey: 'c' },
      ]);
      expect(restored.get(b)!.status).toBe('active');
      expect(restored.get(b)!.parentInvocationId).toBe(a);
    });

    it('produces JSON-serializable state', () => {
      const tree = new ExecutionTree();
      tree.record('wf', 'n', 'child');

      const state = tree.toState();
      const json = JSON.stringify(state);
      const parsed = JSON.parse(json);
      const restored = ExecutionTree.fromState(parsed);

      expect(restored.allRecords().size).toBe(1);
    });

    it('restores from empty state', () => {
      const tree = ExecutionTree.fromState({ records: [] });
      expect(tree.allRecords().size).toBe(0);
    });
  });
});
