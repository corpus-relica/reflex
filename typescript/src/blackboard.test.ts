import { describe, it, expect } from 'vitest';
import { ScopedBlackboardReader, ScopedBlackboard } from './blackboard';
import { BlackboardEntry, BlackboardSource, BlackboardWrite, Cursor } from './types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a BlackboardEntry with minimal required fields. */
function entry(
  key: string,
  value: unknown,
  opts: { workflowId?: string; nodeId?: string; stackDepth?: number; timestamp?: number } = {},
): BlackboardEntry {
  return {
    key,
    value,
    source: {
      workflowId: opts.workflowId ?? 'wf',
      nodeId: opts.nodeId ?? 'n',
      stackDepth: opts.stackDepth ?? 0,
    },
    timestamp: opts.timestamp ?? Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ScopedBlackboardReader', () => {
  // -----------------------------------------------------------------------
  // Empty reader
  // -----------------------------------------------------------------------

  describe('empty reader', () => {
    it('returns undefined from get()', () => {
      const reader = new ScopedBlackboardReader([]);
      expect(reader.get('anything')).toBeUndefined();
    });

    it('returns false from has()', () => {
      const reader = new ScopedBlackboardReader([]);
      expect(reader.has('anything')).toBe(false);
    });

    it('returns empty array from getAll()', () => {
      const reader = new ScopedBlackboardReader([]);
      expect(reader.getAll('anything')).toEqual([]);
    });

    it('returns empty array from entries()', () => {
      const reader = new ScopedBlackboardReader([]);
      expect(reader.entries()).toEqual([]);
    });

    it('returns empty array from keys()', () => {
      const reader = new ScopedBlackboardReader([]);
      expect(reader.keys()).toEqual([]);
    });

    it('returns empty array from local()', () => {
      const reader = new ScopedBlackboardReader([]);
      expect(reader.local()).toEqual([]);
    });

    it('handles no-arg constructor as empty', () => {
      const reader = new ScopedBlackboardReader();
      expect(reader.get('x')).toBeUndefined();
      expect(reader.entries()).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // Single scope
  // -----------------------------------------------------------------------

  describe('single scope', () => {
    it('get() returns value for existing key', () => {
      const e = entry('color', 'blue');
      const reader = new ScopedBlackboardReader([[e]]);
      expect(reader.get('color')).toBe('blue');
    });

    it('has() returns true for existing key', () => {
      const reader = new ScopedBlackboardReader([[entry('color', 'blue')]]);
      expect(reader.has('color')).toBe(true);
    });

    it('has() returns false for missing key', () => {
      const reader = new ScopedBlackboardReader([[entry('color', 'blue')]]);
      expect(reader.has('size')).toBe(false);
    });

    it('keys() returns all unique keys', () => {
      const reader = new ScopedBlackboardReader([
        [entry('color', 'blue'), entry('size', 'large')],
      ]);
      expect(reader.keys()).toContain('color');
      expect(reader.keys()).toContain('size');
      expect(reader.keys()).toHaveLength(2);
    });

    it('get() returns each key correctly with multiple entries', () => {
      const reader = new ScopedBlackboardReader([
        [entry('color', 'blue'), entry('size', 'large')],
      ]);
      expect(reader.get('color')).toBe('blue');
      expect(reader.get('size')).toBe('large');
    });

    it('same-key shadowing: get() returns latest entry (last in array)', () => {
      const reader = new ScopedBlackboardReader([
        [entry('color', 'blue'), entry('color', 'red')],
      ]);
      expect(reader.get('color')).toBe('red');
    });

    it('same-key shadowing: getAll() returns both entries in order', () => {
      const e1 = entry('color', 'blue');
      const e2 = entry('color', 'red');
      const reader = new ScopedBlackboardReader([[e1, e2]]);
      const all = reader.getAll('color');
      expect(all).toHaveLength(2);
      expect(all[0].value).toBe('blue');
      expect(all[1].value).toBe('red');
    });

    it('local() returns all entries from the single scope', () => {
      const e1 = entry('color', 'blue');
      const e2 = entry('size', 'large');
      const reader = new ScopedBlackboardReader([[e1, e2]]);
      const loc = reader.local();
      expect(loc).toHaveLength(2);
      expect(loc[0]).toEqual(e1);
      expect(loc[1]).toEqual(e2);
    });
  });

  // -----------------------------------------------------------------------
  // Multi-scope: lexical scoping
  // -----------------------------------------------------------------------

  describe('multi-scope lexical scoping', () => {
    it('local shadows parent: get() returns local value', () => {
      const local = [entry('color', 'local-red')];
      const parent = [entry('color', 'parent-blue')];
      const reader = new ScopedBlackboardReader([local, parent]);
      expect(reader.get('color')).toBe('local-red');
    });

    it('parent fallback: get() returns parent value when not in local', () => {
      const local = [entry('size', 'large')];
      const parent = [entry('color', 'parent-blue')];
      const reader = new ScopedBlackboardReader([local, parent]);
      expect(reader.get('color')).toBe('parent-blue');
    });

    it('grandparent fallback: get() walks 3 scopes deep', () => {
      const local: BlackboardEntry[] = [];
      const parent: BlackboardEntry[] = [];
      const grandparent = [entry('origin', 'root-value')];
      const reader = new ScopedBlackboardReader([local, parent, grandparent]);
      expect(reader.get('origin')).toBe('root-value');
    });

    it('has() returns true if key in any scope', () => {
      const local: BlackboardEntry[] = [];
      const parent = [entry('color', 'blue')];
      const reader = new ScopedBlackboardReader([local, parent]);
      expect(reader.has('color')).toBe(true);
    });

    it('has() returns false if key in no scope', () => {
      const local = [entry('size', 'big')];
      const parent = [entry('color', 'blue')];
      const reader = new ScopedBlackboardReader([local, parent]);
      expect(reader.has('weight')).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // getAll() across scopes
  // -----------------------------------------------------------------------

  describe('getAll() across scopes', () => {
    it('includes shadowed entries from all scopes, most-local first', () => {
      const local = [entry('color', 'local-red')];
      const parent = [entry('color', 'parent-blue')];
      const grandparent = [entry('color', 'gp-green')];
      const reader = new ScopedBlackboardReader([local, parent, grandparent]);

      const all = reader.getAll('color');
      expect(all).toHaveLength(3);
      expect(all[0].value).toBe('local-red');
      expect(all[1].value).toBe('parent-blue');
      expect(all[2].value).toBe('gp-green');
    });

    it('preserves entry order within each scope', () => {
      const local = [entry('x', 1), entry('x', 2)];
      const parent = [entry('x', 10), entry('x', 20)];
      const reader = new ScopedBlackboardReader([local, parent]);

      const all = reader.getAll('x');
      expect(all).toHaveLength(4);
      expect(all.map((e) => e.value)).toEqual([1, 2, 10, 20]);
    });

    it('returns empty for non-existent key', () => {
      const reader = new ScopedBlackboardReader([[entry('a', 1)]]);
      expect(reader.getAll('z')).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // entries() across scopes
  // -----------------------------------------------------------------------

  describe('entries()', () => {
    it('concatenates all scopes, local first', () => {
      const eLocal = entry('a', 1);
      const eParent = entry('b', 2);
      const eGP = entry('c', 3);
      const reader = new ScopedBlackboardReader([[eLocal], [eParent], [eGP]]);

      const all = reader.entries();
      expect(all).toHaveLength(3);
      expect(all[0]).toEqual(eLocal);
      expect(all[1]).toEqual(eParent);
      expect(all[2]).toEqual(eGP);
    });
  });

  // -----------------------------------------------------------------------
  // keys() deduplication
  // -----------------------------------------------------------------------

  describe('keys()', () => {
    it('deduplicates keys across scopes', () => {
      const local = [entry('color', 'red')];
      const parent = [entry('color', 'blue'), entry('size', 'big')];
      const reader = new ScopedBlackboardReader([local, parent]);

      const k = reader.keys();
      expect(k).toHaveLength(2);
      expect(k).toContain('color');
      expect(k).toContain('size');
    });
  });

  // -----------------------------------------------------------------------
  // local()
  // -----------------------------------------------------------------------

  describe('local()', () => {
    it('returns only innermost scope entries', () => {
      const eLocal = entry('a', 1);
      const eParent = entry('b', 2);
      const reader = new ScopedBlackboardReader([[eLocal], [eParent]]);

      const loc = reader.local();
      expect(loc).toHaveLength(1);
      expect(loc[0]).toEqual(eLocal);
    });

    it('returns empty array when innermost scope is empty', () => {
      const reader = new ScopedBlackboardReader([[], [entry('b', 2)]]);
      expect(reader.local()).toEqual([]);
    });

    it('returns a copy — mutations do not affect reader', () => {
      const e = entry('a', 1);
      const reader = new ScopedBlackboardReader([[e]]);
      const loc = reader.local();
      loc.pop();
      expect(reader.local()).toHaveLength(1);
    });
  });
});

// ===========================================================================
// ScopedBlackboard (write side)
// ===========================================================================

describe('ScopedBlackboard', () => {
  const source: BlackboardSource = {
    workflowId: 'wf-1',
    nodeId: 'node-A',
    stackDepth: 0,
  };

  // -----------------------------------------------------------------------
  // append() basics
  // -----------------------------------------------------------------------

  describe('append()', () => {
    it('creates entries with correct key and value', () => {
      const bb = new ScopedBlackboard();
      bb.append([{ key: 'color', value: 'blue' }], source);
      const entries = bb.getEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0].key).toBe('color');
      expect(entries[0].value).toBe('blue');
    });

    it('attaches source metadata to every entry', () => {
      const bb = new ScopedBlackboard();
      bb.append([{ key: 'x', value: 1 }], source);
      const e = bb.getEntries()[0];
      expect(e.source.workflowId).toBe('wf-1');
      expect(e.source.nodeId).toBe('node-A');
      expect(e.source.stackDepth).toBe(0);
    });

    it('attaches a numeric timestamp to every entry', () => {
      const bb = new ScopedBlackboard();
      const before = Date.now();
      bb.append([{ key: 'x', value: 1 }], source);
      const after = Date.now();
      const ts = bb.getEntries()[0].timestamp;
      expect(ts).toBeGreaterThanOrEqual(before);
      expect(ts).toBeLessThanOrEqual(after);
    });

    it('gives all entries in one call the same timestamp and source', () => {
      const bb = new ScopedBlackboard();
      const writes: BlackboardWrite[] = [
        { key: 'a', value: 1 },
        { key: 'b', value: 2 },
        { key: 'c', value: 3 },
      ];
      bb.append(writes, source);
      const entries = bb.getEntries();
      expect(entries).toHaveLength(3);
      const ts = entries[0].timestamp;
      for (const e of entries) {
        expect(e.timestamp).toBe(ts);
        expect(e.source).toBe(source);
      }
    });

    it('returns the newly created entries', () => {
      const bb = new ScopedBlackboard();
      const result = bb.append([{ key: 'x', value: 42 }], source);
      expect(result).toHaveLength(1);
      expect(result[0].key).toBe('x');
      expect(result[0].value).toBe(42);
      expect(result[0].source).toBe(source);
    });
  });

  // -----------------------------------------------------------------------
  // Append-only invariant
  // -----------------------------------------------------------------------

  describe('append-only invariant', () => {
    it('entries accumulate across multiple append() calls', () => {
      const bb = new ScopedBlackboard();
      bb.append([{ key: 'a', value: 1 }], source);
      bb.append([{ key: 'b', value: 2 }], source);
      bb.append([{ key: 'c', value: 3 }], source);
      expect(bb.getEntries()).toHaveLength(3);
    });

    it('existing entries are unchanged after a new append', () => {
      const bb = new ScopedBlackboard();
      bb.append([{ key: 'a', value: 1 }], source);
      const first = bb.getEntries()[0];
      bb.append([{ key: 'b', value: 2 }], source);
      const entries = bb.getEntries();
      expect(entries[0].key).toBe(first.key);
      expect(entries[0].value).toBe(first.value);
      expect(entries[0].timestamp).toBe(first.timestamp);
    });
  });

  // -----------------------------------------------------------------------
  // Same-key shadowing (via reader integration)
  // -----------------------------------------------------------------------

  describe('same-key shadowing', () => {
    it('reader.get() returns the latest value for a shadowed key', () => {
      const bb = new ScopedBlackboard();
      bb.append([{ key: 'color', value: 'blue' }], source);
      bb.append([{ key: 'color', value: 'red' }], source);
      const reader = bb.reader();
      expect(reader.get('color')).toBe('red');
    });
  });

  // -----------------------------------------------------------------------
  // getEntries()
  // -----------------------------------------------------------------------

  describe('getEntries()', () => {
    it('returns current entries reflecting all appends', () => {
      const bb = new ScopedBlackboard();
      bb.append([{ key: 'x', value: 1 }], source);
      bb.append([{ key: 'y', value: 2 }], source);
      const entries = bb.getEntries();
      expect(entries).toHaveLength(2);
      expect(entries[0].key).toBe('x');
      expect(entries[1].key).toBe('y');
    });

    it('returns a copy — mutations do not affect internal state', () => {
      const bb = new ScopedBlackboard();
      bb.append([{ key: 'x', value: 1 }], source);
      const snapshot = bb.getEntries();
      // Mutate the returned array
      (snapshot as BlackboardEntry[]).push(entry('hack', 99));
      expect(bb.getEntries()).toHaveLength(1);
    });
  });

  // -----------------------------------------------------------------------
  // reader()
  // -----------------------------------------------------------------------

  describe('reader()', () => {
    it('constructs a working ScopedBlackboardReader', () => {
      const bb = new ScopedBlackboard();
      bb.append([{ key: 'color', value: 'green' }], source);
      const reader = bb.reader();
      expect(reader.get('color')).toBe('green');
      expect(reader.has('color')).toBe(true);
      expect(reader.keys()).toContain('color');
    });

    it('includes parent scopes in the reader', () => {
      const bb = new ScopedBlackboard();
      const parentEntries = [entry('origin', 'parent-value')];
      const reader = bb.reader([parentEntries]);
      expect(reader.get('origin')).toBe('parent-value');
    });

    it('local scope reflects writes, shadowing parent values', () => {
      const bb = new ScopedBlackboard();
      const parentEntries = [entry('color', 'parent-blue')];
      bb.append([{ key: 'color', value: 'local-red' }], source);
      const reader = bb.reader([parentEntries]);
      expect(reader.get('color')).toBe('local-red');
    });
  });

  // -----------------------------------------------------------------------
  // Empty blackboard
  // -----------------------------------------------------------------------

  describe('empty blackboard', () => {
    it('getEntries() returns empty array', () => {
      const bb = new ScopedBlackboard();
      expect(bb.getEntries()).toEqual([]);
    });

    it('reader().get() returns undefined', () => {
      const bb = new ScopedBlackboard();
      expect(bb.reader().get('anything')).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // Constructor with seed entries
  // -----------------------------------------------------------------------

  describe('constructor with seed entries', () => {
    it('initializes with provided entries', () => {
      const seed = [entry('x', 1), entry('y', 2)];
      const bb = new ScopedBlackboard(seed);
      expect(bb.getEntries()).toHaveLength(2);
      expect(bb.reader().get('x')).toBe(1);
      expect(bb.reader().get('y')).toBe(2);
    });

    it('append adds to seed entries', () => {
      const seed = [entry('x', 1)];
      const bb = new ScopedBlackboard(seed);
      bb.append([{ key: 'y', value: 2 }], source);
      expect(bb.getEntries()).toHaveLength(2);
    });
  });
});

// ===========================================================================
// Blackboard integration tests (M2-3: issue #6)
// ===========================================================================

describe('Blackboard integration (M2-3)', () => {
  const src: BlackboardSource = {
    workflowId: 'wf-int',
    nodeId: 'node-int',
    stackDepth: 0,
  };

  // -----------------------------------------------------------------------
  // 1. Write and read back single value
  // -----------------------------------------------------------------------

  describe('write and read back', () => {
    it('round-trips a single key/value through append → reader.get()', () => {
      const bb = new ScopedBlackboard();
      bb.append([{ key: 'color', value: 'blue' }], src);
      const reader = bb.reader();
      expect(reader.get('color')).toBe('blue');
    });

    it('round-trips multiple keys written in one append call', () => {
      const bb = new ScopedBlackboard();
      bb.append(
        [
          { key: 'color', value: 'red' },
          { key: 'size', value: 'large' },
          { key: 'count', value: 42 },
        ],
        src,
      );
      const reader = bb.reader();
      expect(reader.get('color')).toBe('red');
      expect(reader.get('size')).toBe('large');
      expect(reader.get('count')).toBe(42);
    });

    it('round-trips values written across multiple append calls', () => {
      const bb = new ScopedBlackboard();
      bb.append([{ key: 'a', value: 1 }], src);
      bb.append([{ key: 'b', value: 2 }], src);
      const reader = bb.reader();
      expect(reader.get('a')).toBe(1);
      expect(reader.get('b')).toBe(2);
    });
  });

  // -----------------------------------------------------------------------
  // 2. Same-key shadowing within a scope
  // -----------------------------------------------------------------------

  describe('same-key shadowing within a scope', () => {
    it('reader.get() returns the latest value after two writes to same key', () => {
      const bb = new ScopedBlackboard();
      bb.append([{ key: 'color', value: 'blue' }], src);
      bb.append([{ key: 'color', value: 'red' }], src);
      const reader = bb.reader();
      expect(reader.get('color')).toBe('red');
    });

    it('reader.getAll() returns both entries in chronological order', () => {
      const bb = new ScopedBlackboard();
      bb.append([{ key: 'color', value: 'blue' }], src);
      bb.append([{ key: 'color', value: 'red' }], src);
      const reader = bb.reader();
      const all = reader.getAll('color');
      expect(all).toHaveLength(2);
      expect(all[0].value).toBe('blue');
      expect(all[1].value).toBe('red');
    });

    it('reader.has() returns true for a shadowed key', () => {
      const bb = new ScopedBlackboard();
      bb.append([{ key: 'x', value: 1 }], src);
      bb.append([{ key: 'x', value: 2 }], src);
      expect(bb.reader().has('x')).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // 3. Cross-scope read precedence (local shadows parent)
  // -----------------------------------------------------------------------

  describe('cross-scope read precedence', () => {
    it('child scope shadows parent scope for same key', () => {
      const parent = new ScopedBlackboard();
      parent.append([{ key: 'color', value: 'parent-blue' }], {
        ...src,
        stackDepth: 0,
      });

      const child = new ScopedBlackboard();
      child.append([{ key: 'color', value: 'child-red' }], {
        ...src,
        stackDepth: 1,
      });

      const reader = child.reader([parent.getEntries() as BlackboardEntry[]]);
      expect(reader.get('color')).toBe('child-red');
    });

    it('child reader falls back to parent for keys not in child', () => {
      const parent = new ScopedBlackboard();
      parent.append([{ key: 'origin', value: 'from-parent' }], src);

      const child = new ScopedBlackboard();
      child.append([{ key: 'local-only', value: 'yes' }], src);

      const reader = child.reader([parent.getEntries() as BlackboardEntry[]]);
      expect(reader.get('origin')).toBe('from-parent');
      expect(reader.get('local-only')).toBe('yes');
    });

    it('three-deep scope chain: grandparent → parent → child', () => {
      const grandparent = new ScopedBlackboard();
      grandparent.append([{ key: 'deep', value: 'gp-value' }], {
        ...src,
        stackDepth: 0,
      });

      const parent = new ScopedBlackboard();
      parent.append([{ key: 'mid', value: 'parent-value' }], {
        ...src,
        stackDepth: 1,
      });

      const child = new ScopedBlackboard();
      child.append([{ key: 'top', value: 'child-value' }], {
        ...src,
        stackDepth: 2,
      });

      const reader = child.reader([
        parent.getEntries() as BlackboardEntry[],
        grandparent.getEntries() as BlackboardEntry[],
      ]);

      expect(reader.get('top')).toBe('child-value');
      expect(reader.get('mid')).toBe('parent-value');
      expect(reader.get('deep')).toBe('gp-value');
    });

    it('child shadows grandparent even when parent has no entry for that key', () => {
      const grandparent = new ScopedBlackboard();
      grandparent.append([{ key: 'color', value: 'gp-green' }], src);

      const parent = new ScopedBlackboard();
      // parent does NOT write 'color'

      const child = new ScopedBlackboard();
      child.append([{ key: 'color', value: 'child-red' }], src);

      const reader = child.reader([
        parent.getEntries() as BlackboardEntry[],
        grandparent.getEntries() as BlackboardEntry[],
      ]);
      expect(reader.get('color')).toBe('child-red');
    });
  });

  // -----------------------------------------------------------------------
  // 4. getAll() returns shadowed entries in correct order
  // -----------------------------------------------------------------------

  describe('getAll() cross-scope ordering', () => {
    it('returns entries from child first, then parent, then grandparent', () => {
      const grandparent = new ScopedBlackboard();
      grandparent.append([{ key: 'x', value: 'gp' }], src);

      const parent = new ScopedBlackboard();
      parent.append([{ key: 'x', value: 'parent' }], src);

      const child = new ScopedBlackboard();
      child.append([{ key: 'x', value: 'child' }], src);

      const reader = child.reader([
        parent.getEntries() as BlackboardEntry[],
        grandparent.getEntries() as BlackboardEntry[],
      ]);

      const all = reader.getAll('x');
      expect(all).toHaveLength(3);
      expect(all[0].value).toBe('child');
      expect(all[1].value).toBe('parent');
      expect(all[2].value).toBe('gp');
    });

    it('preserves chronological order within each scope', () => {
      const parent = new ScopedBlackboard();
      parent.append([{ key: 'x', value: 'p1' }], src);
      parent.append([{ key: 'x', value: 'p2' }], src);

      const child = new ScopedBlackboard();
      child.append([{ key: 'x', value: 'c1' }], src);
      child.append([{ key: 'x', value: 'c2' }], src);

      const reader = child.reader([parent.getEntries() as BlackboardEntry[]]);
      const all = reader.getAll('x');
      expect(all).toHaveLength(4);
      expect(all.map((e) => e.value)).toEqual(['c1', 'c2', 'p1', 'p2']);
    });
  });

  // -----------------------------------------------------------------------
  // 5. local() returns only innermost scope
  // -----------------------------------------------------------------------

  describe('local() returns only innermost scope', () => {
    it('returns only child entries when parent scope exists', () => {
      const parent = new ScopedBlackboard();
      parent.append([{ key: 'origin', value: 'parent' }], src);

      const child = new ScopedBlackboard();
      child.append([{ key: 'local-key', value: 'child' }], src);

      const reader = child.reader([parent.getEntries() as BlackboardEntry[]]);
      const loc = reader.local();
      expect(loc).toHaveLength(1);
      expect(loc[0].key).toBe('local-key');
      expect(loc[0].value).toBe('child');
    });

    it('parent entries are not included in local()', () => {
      const parent = new ScopedBlackboard();
      parent.append(
        [
          { key: 'a', value: 1 },
          { key: 'b', value: 2 },
        ],
        src,
      );

      const child = new ScopedBlackboard();
      child.append([{ key: 'c', value: 3 }], src);

      const reader = child.reader([parent.getEntries() as BlackboardEntry[]]);
      const loc = reader.local();
      expect(loc).toHaveLength(1);
      expect(loc.every((e) => e.key === 'c')).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // 6. Append-only invariant: no mutation, no deletion
  // -----------------------------------------------------------------------

  describe('append-only invariant', () => {
    it('all previous entries remain present after additional appends', () => {
      const bb = new ScopedBlackboard();
      bb.append([{ key: 'a', value: 1 }], src);
      bb.append([{ key: 'b', value: 2 }], src);
      bb.append([{ key: 'c', value: 3 }], src);

      const entries = bb.getEntries();
      expect(entries).toHaveLength(3);
      expect(entries[0].key).toBe('a');
      expect(entries[1].key).toBe('b');
      expect(entries[2].key).toBe('c');
    });

    it('values and timestamps of existing entries are preserved after new appends', () => {
      const bb = new ScopedBlackboard();
      bb.append([{ key: 'first', value: 'original' }], src);
      const snapshot = bb.getEntries()[0];

      bb.append([{ key: 'second', value: 'new' }], src);
      bb.append([{ key: 'third', value: 'newer' }], src);

      const entries = bb.getEntries();
      expect(entries[0].key).toBe(snapshot.key);
      expect(entries[0].value).toBe(snapshot.value);
      expect(entries[0].timestamp).toBe(snapshot.timestamp);
      expect(entries[0].source).toEqual(snapshot.source);
    });

    it('getEntries() length only grows, never shrinks', () => {
      const bb = new ScopedBlackboard();
      expect(bb.getEntries()).toHaveLength(0);

      bb.append([{ key: 'a', value: 1 }], src);
      expect(bb.getEntries()).toHaveLength(1);

      bb.append([{ key: 'b', value: 2 }], src);
      expect(bb.getEntries()).toHaveLength(2);

      bb.append([{ key: 'a', value: 99 }], src); // shadow, not replace
      expect(bb.getEntries()).toHaveLength(3);
    });

    it('shadowing a key does not remove the original entry', () => {
      const bb = new ScopedBlackboard();
      bb.append([{ key: 'color', value: 'blue' }], src);
      bb.append([{ key: 'color', value: 'red' }], src);

      const reader = bb.reader();
      expect(reader.get('color')).toBe('red'); // latest wins
      expect(reader.getAll('color')).toHaveLength(2); // both still present
      expect(reader.getAll('color')[0].value).toBe('blue'); // original preserved
    });
  });

  // -----------------------------------------------------------------------
  // 7. Empty blackboard returns undefined / false / empty arrays
  // -----------------------------------------------------------------------

  describe('empty blackboard', () => {
    it('reader.get() returns undefined', () => {
      const bb = new ScopedBlackboard();
      expect(bb.reader().get('anything')).toBeUndefined();
    });

    it('reader.has() returns false', () => {
      const bb = new ScopedBlackboard();
      expect(bb.reader().has('anything')).toBe(false);
    });

    it('reader.getAll() returns empty array', () => {
      const bb = new ScopedBlackboard();
      expect(bb.reader().getAll('anything')).toEqual([]);
    });

    it('reader.entries() returns empty array', () => {
      const bb = new ScopedBlackboard();
      expect(bb.reader().entries()).toEqual([]);
    });

    it('reader.keys() returns empty array', () => {
      const bb = new ScopedBlackboard();
      expect(bb.reader().keys()).toEqual([]);
    });

    it('reader.local() returns empty array', () => {
      const bb = new ScopedBlackboard();
      expect(bb.reader().local()).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // Cursor API (issue #87 — parity with Go #83/#85)
  // -----------------------------------------------------------------------

  describe('Cursor API', () => {
    it('cursor() returns 0 on empty blackboard', () => {
      const bb = new ScopedBlackboard();
      expect(bb.cursor()).toBe(0);
    });

    it('cursor() reflects entry count after append', () => {
      const bb = new ScopedBlackboard();
      expect(bb.cursor()).toBe(0);
      bb.append([{ key: 'a', value: 1 }], src);
      expect(bb.cursor()).toBe(1);
      bb.append([{ key: 'b', value: 2 }, { key: 'c', value: 3 }], src);
      expect(bb.cursor()).toBe(3);
    });

    it('entriesFrom(0) returns all entries', () => {
      const bb = new ScopedBlackboard();
      bb.append([{ key: 'a', value: 1 }], src);
      bb.append([{ key: 'b', value: 2 }], src);
      const [entries, next] = bb.entriesFrom(0);
      expect(entries).toHaveLength(2);
      expect(entries[0].key).toBe('a');
      expect(entries[1].key).toBe('b');
      expect(next).toBe(2);
    });

    it('entriesFrom(cursor) returns only new entries since that cursor', () => {
      const bb = new ScopedBlackboard();
      bb.append([{ key: 'a', value: 1 }], src);
      const cursor: Cursor = bb.cursor(); // 1
      bb.append([{ key: 'b', value: 2 }], src);
      bb.append([{ key: 'c', value: 3 }], src);

      const [entries, next] = bb.entriesFrom(cursor);
      expect(entries).toHaveLength(2);
      expect(entries[0].key).toBe('b');
      expect(entries[1].key).toBe('c');
      expect(next).toBe(3);
    });

    it('entriesFrom past end returns empty array and current position', () => {
      const bb = new ScopedBlackboard();
      bb.append([{ key: 'a', value: 1 }], src);
      const end = bb.cursor();

      const [entries, next] = bb.entriesFrom(end);
      expect(entries).toEqual([]);
      expect(next).toBe(end);

      // Past end also works
      const [entries2, next2] = bb.entriesFrom(end + 10);
      expect(entries2).toEqual([]);
      expect(next2).toBe(end);
    });

    it('entriesFrom(-1) treated as 0, returns all entries', () => {
      const bb = new ScopedBlackboard();
      bb.append([{ key: 'a', value: 1 }], src);
      bb.append([{ key: 'b', value: 2 }], src);
      const [entries, next] = bb.entriesFrom(-1);
      expect(entries).toHaveLength(2);
      expect(next).toBe(2);
    });

    it('cursor() on seeded blackboard starts at seed length', () => {
      const seed = [entry('x', 1), entry('y', 2), entry('z', 3)];
      const bb = new ScopedBlackboard(seed);
      expect(bb.cursor()).toBe(3);
    });

    it('multiple sequential reads accumulate without duplicates', () => {
      const bb = new ScopedBlackboard();
      const collected: string[] = [];
      let cursor: Cursor = bb.cursor();

      bb.append([{ key: 'a', value: 1 }], src);
      {
        const [entries, next] = bb.entriesFrom(cursor);
        collected.push(...entries.map((e) => e.key));
        cursor = next;
      }

      bb.append([{ key: 'b', value: 2 }], src);
      bb.append([{ key: 'c', value: 3 }], src);
      {
        const [entries, next] = bb.entriesFrom(cursor);
        collected.push(...entries.map((e) => e.key));
        cursor = next;
      }

      // No new entries
      {
        const [entries, next] = bb.entriesFrom(cursor);
        collected.push(...entries.map((e) => e.key));
        cursor = next;
      }

      expect(collected).toEqual(['a', 'b', 'c']);
    });

    it('entriesFrom() returns a copy — mutations do not affect internal state', () => {
      const bb = new ScopedBlackboard();
      bb.append([{ key: 'a', value: 1 }], src);
      const [entries] = bb.entriesFrom(0);
      entries.push(entry('hack', 99));
      const [fresh] = bb.entriesFrom(0);
      expect(fresh).toHaveLength(1);
    });
  });
});
