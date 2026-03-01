// Reflex — Comprehensive Test Suite for Node Contracts (M8-3, Issue #60)
//
// Tests node contract declarations (inputs/outputs) and static verification
// via registry.verify(). Covers the full issue checklist:
//   - Satisfied inputs
//   - Missing required inputs
//   - Optional inputs
//   - ReturnMap verification
//   - Invocation boundaries
//   - Conditional paths (guarded edges)
//   - Workflows without contracts
//   - Mixed contracts (partial declarations)

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  WorkflowRegistry,
  WorkflowValidationError,
  VerificationResult,
} from './registry';
import { Workflow, Node, Edge } from './types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a node with optional contract declarations and invocation spec. */
function contractNode(
  id: string,
  opts?: {
    inputs?: Node['inputs'];
    outputs?: Node['outputs'];
    invokes?: Node['invokes'];
    description?: string;
  },
): Node {
  return {
    id,
    spec: {},
    ...(opts?.inputs !== undefined ? { inputs: opts.inputs } : {}),
    ...(opts?.outputs !== undefined ? { outputs: opts.outputs } : {}),
    ...(opts?.invokes !== undefined ? { invokes: opts.invokes } : {}),
    ...(opts?.description !== undefined ? { description: opts.description } : {}),
  };
}

/** Create a bare node with no contracts. */
function bareNode(id: string): Node {
  return { id, spec: {} };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Node Contracts (M8-3)', () => {
  let registry: WorkflowRegistry;

  beforeEach(() => {
    registry = new WorkflowRegistry();
  });

  // -----------------------------------------------------------------------
  // 1. Basic contract verification (issue checklist parity)
  // -----------------------------------------------------------------------

  describe('basic contract verification', () => {
    it('node with satisfied inputs passes verification', () => {
      // A (outputs: x) → B (inputs: x required)
      const wf: Workflow = {
        id: 'satisfied',
        entry: 'A',
        nodes: {
          A: contractNode('A', {
            outputs: [{ key: 'x', guaranteed: true }],
          }),
          B: contractNode('B', {
            inputs: [{ key: 'x', required: true }],
          }),
        },
        edges: [{ id: 'e1', from: 'A', to: 'B', event: 'NEXT' }],
      };

      registry.register(wf);
      const result = registry.verify('satisfied');

      expect(result.valid).toBe(true);
      expect(result.warnings).toHaveLength(0);
      expect(result.workflowId).toBe('satisfied');
    });

    it('node with missing required input produces warning', () => {
      // A (no outputs) → B (inputs: x required)
      const wf: Workflow = {
        id: 'missing',
        entry: 'A',
        nodes: {
          A: contractNode('A'),
          B: contractNode('B', {
            inputs: [{ key: 'x', required: true }],
          }),
        },
        edges: [{ id: 'e1', from: 'A', to: 'B', event: 'NEXT' }],
      };

      registry.register(wf);
      const result = registry.verify('missing');

      expect(result.valid).toBe(false);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0].code).toBe('MISSING_REQUIRED_INPUT');
      expect(result.warnings[0].nodeId).toBe('B');
      expect(result.warnings[0].key).toBe('x');
    });

    it('node with optional input and no producer passes clean', () => {
      // A (no outputs) → B (inputs: x optional)
      const wf: Workflow = {
        id: 'optional-clean',
        entry: 'A',
        nodes: {
          A: contractNode('A'),
          B: contractNode('B', {
            inputs: [{ key: 'x', required: false }],
          }),
        },
        edges: [{ id: 'e1', from: 'A', to: 'B', event: 'NEXT' }],
      };

      registry.register(wf);
      const result = registry.verify('optional-clean');

      expect(result.valid).toBe(true);
      expect(result.warnings).toHaveLength(0);
    });

    it('returnMap verified against sub-workflow outputs', () => {
      // Child workflow has terminal with outputs: [actualKey]
      // Parent returnMap references wrongKey → warning
      const child: Workflow = {
        id: 'child',
        entry: 'C1',
        nodes: {
          C1: contractNode('C1', {
            outputs: [{ key: 'actualKey', guaranteed: true }],
          }),
        },
        edges: [],
      };

      const parent: Workflow = {
        id: 'parent',
        entry: 'P1',
        nodes: {
          P1: contractNode('P1', {
            invokes: {
              workflowId: 'child',
              returnMap: [{ parentKey: 'result', childKey: 'wrongKey' }],
            },
          }),
          P2: contractNode('P2'),
        },
        edges: [{ id: 'e1', from: 'P1', to: 'P2', event: 'NEXT' }],
      };

      registry.register(child);
      registry.register(parent);
      const result = registry.verify('parent');

      expect(result.valid).toBe(false);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0].code).toBe('RETURNMAP_KEY_NOT_IN_CHILD_OUTPUTS');
      expect(result.warnings[0].key).toBe('wrongKey');
    });

    it('returnMap passes when childKey matches terminal outputs', () => {
      const child: Workflow = {
        id: 'child-ok',
        entry: 'C1',
        nodes: {
          C1: contractNode('C1', {
            outputs: [{ key: 'result', guaranteed: true }],
          }),
        },
        edges: [],
      };

      const parent: Workflow = {
        id: 'parent-ok',
        entry: 'P1',
        nodes: {
          P1: contractNode('P1', {
            invokes: {
              workflowId: 'child-ok',
              returnMap: [{ parentKey: 'myResult', childKey: 'result' }],
            },
          }),
          P2: contractNode('P2'),
        },
        edges: [{ id: 'e1', from: 'P1', to: 'P2', event: 'NEXT' }],
      };

      registry.register(child);
      registry.register(parent);
      const result = registry.verify('parent-ok');

      expect(result.valid).toBe(true);
      expect(result.warnings).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // 2. Verification across invocation boundaries
  // -----------------------------------------------------------------------

  describe('invocation boundary verification', () => {
    it('returnMap keys checked against child terminal outputs across boundary', () => {
      // Child: C1 → C2(terminal, outputs: [childOut])
      // Parent: P1(invokes child, returnMap: childOut→parentVal) → P2
      const child: Workflow = {
        id: 'inv-child',
        entry: 'C1',
        nodes: {
          C1: contractNode('C1'),
          C2: contractNode('C2', {
            outputs: [{ key: 'childOut', guaranteed: true }],
          }),
        },
        edges: [{ id: 'ce1', from: 'C1', to: 'C2', event: 'NEXT' }],
      };

      const parent: Workflow = {
        id: 'inv-parent',
        entry: 'P1',
        nodes: {
          P1: contractNode('P1', {
            invokes: {
              workflowId: 'inv-child',
              returnMap: [{ parentKey: 'parentVal', childKey: 'childOut' }],
            },
          }),
          P2: contractNode('P2'),
        },
        edges: [{ id: 'pe1', from: 'P1', to: 'P2', event: 'NEXT' }],
      };

      registry.register(child);
      registry.register(parent);

      const result = registry.verify('inv-parent');
      expect(result.valid).toBe(true);
      expect(result.warnings).toHaveLength(0);
    });

    it('warns when returnMap childKey not in any terminal of multi-terminal child', () => {
      // Child has two terminal nodes: T1 (outputs: [a]) and T2 (outputs: [b])
      // Parent returnMap requests childKey 'c' → not in either → warning
      const child: Workflow = {
        id: 'multi-term-child',
        entry: 'C',
        nodes: {
          C: contractNode('C'),
          T1: contractNode('T1', {
            outputs: [{ key: 'a', guaranteed: true }],
          }),
          T2: contractNode('T2', {
            outputs: [{ key: 'b', guaranteed: true }],
          }),
        },
        edges: [
          { id: 'ce1', from: 'C', to: 'T1', event: 'LEFT' },
          { id: 'ce2', from: 'C', to: 'T2', event: 'RIGHT' },
        ],
      };

      const parent: Workflow = {
        id: 'multi-term-parent',
        entry: 'P',
        nodes: {
          P: contractNode('P', {
            invokes: {
              workflowId: 'multi-term-child',
              returnMap: [{ parentKey: 'result', childKey: 'c' }],
            },
          }),
          DONE: contractNode('DONE'),
        },
        edges: [{ id: 'pe1', from: 'P', to: 'DONE', event: 'NEXT' }],
      };

      registry.register(child);
      registry.register(parent);

      const result = registry.verify('multi-term-parent');
      expect(result.valid).toBe(false);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0].code).toBe('RETURNMAP_KEY_NOT_IN_CHILD_OUTPUTS');
      expect(result.warnings[0].key).toBe('c');
    });

    it('returnMap passes when childKey is in one of multiple terminals', () => {
      // Child terminals: T1 (outputs: [a]) and T2 (outputs: [b])
      // Parent returnMap requests 'a' → found in T1 → valid
      const child: Workflow = {
        id: 'multi-term-child-ok',
        entry: 'C',
        nodes: {
          C: contractNode('C'),
          T1: contractNode('T1', {
            outputs: [{ key: 'a', guaranteed: true }],
          }),
          T2: contractNode('T2', {
            outputs: [{ key: 'b', guaranteed: true }],
          }),
        },
        edges: [
          { id: 'ce1', from: 'C', to: 'T1', event: 'LEFT' },
          { id: 'ce2', from: 'C', to: 'T2', event: 'RIGHT' },
        ],
      };

      const parent: Workflow = {
        id: 'multi-term-parent-ok',
        entry: 'P',
        nodes: {
          P: contractNode('P', {
            invokes: {
              workflowId: 'multi-term-child-ok',
              returnMap: [{ parentKey: 'result', childKey: 'a' }],
            },
          }),
          DONE: contractNode('DONE'),
        },
        edges: [{ id: 'pe1', from: 'P', to: 'DONE', event: 'NEXT' }],
      };

      registry.register(child);
      registry.register(parent);

      const result = registry.verify('multi-term-parent-ok');
      expect(result.valid).toBe(true);
    });

    it('gracefully skips when invoked child workflow is not registered', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const wf: Workflow = {
        id: 'parent-no-child',
        entry: 'P',
        nodes: {
          P: contractNode('P', {
            invokes: {
              workflowId: 'nonexistent',
              returnMap: [{ parentKey: 'x', childKey: 'y' }],
            },
          }),
          DONE: contractNode('DONE'),
        },
        edges: [{ id: 'e1', from: 'P', to: 'DONE', event: 'NEXT' }],
      };

      registry.register(wf);
      const result = registry.verify('parent-no-child');

      // No warnings — can't verify what we can't see
      expect(result.valid).toBe(true);
      expect(result.warnings).toHaveLength(0);

      warnSpy.mockRestore();
    });

    it('multi-level invocation: grandparent → parent → child returnMap checking', () => {
      // grandchild: single terminal with output 'deep'
      const grandchild: Workflow = {
        id: 'grandchild',
        entry: 'GC',
        nodes: {
          GC: contractNode('GC', {
            outputs: [{ key: 'deep', guaranteed: true }],
          }),
        },
        edges: [],
      };

      // parent: invokes grandchild, returnMap maps deep→mid
      // parent terminal has output 'mid'
      const parent: Workflow = {
        id: 'mid-parent',
        entry: 'MP1',
        nodes: {
          MP1: contractNode('MP1', {
            invokes: {
              workflowId: 'grandchild',
              returnMap: [{ parentKey: 'mid', childKey: 'deep' }],
            },
          }),
          MP2: contractNode('MP2', {
            outputs: [{ key: 'mid', guaranteed: true }],
          }),
        },
        edges: [{ id: 'me1', from: 'MP1', to: 'MP2', event: 'NEXT' }],
      };

      // grandparent: invokes parent, returnMap maps mid→top
      const grandparent: Workflow = {
        id: 'grandparent',
        entry: 'GP1',
        nodes: {
          GP1: contractNode('GP1', {
            invokes: {
              workflowId: 'mid-parent',
              returnMap: [{ parentKey: 'top', childKey: 'mid' }],
            },
          }),
          GP2: contractNode('GP2'),
        },
        edges: [{ id: 'ge1', from: 'GP1', to: 'GP2', event: 'NEXT' }],
      };

      registry.register(grandchild);
      registry.register(parent);
      registry.register(grandparent);

      // Verify each level independently
      const gcResult = registry.verify('grandchild');
      expect(gcResult.valid).toBe(true);

      const midResult = registry.verify('mid-parent');
      expect(midResult.valid).toBe(true);

      const gpResult = registry.verify('grandparent');
      expect(gpResult.valid).toBe(true);
    });

    it('multi-level invocation detects bad returnMap at any level', () => {
      const grandchild: Workflow = {
        id: 'gc-bad',
        entry: 'GC',
        nodes: {
          GC: contractNode('GC', {
            outputs: [{ key: 'deep', guaranteed: true }],
          }),
        },
        edges: [],
      };

      // Parent returnMap references wrong key from grandchild
      const parent: Workflow = {
        id: 'mid-bad',
        entry: 'MP1',
        nodes: {
          MP1: contractNode('MP1', {
            invokes: {
              workflowId: 'gc-bad',
              returnMap: [{ parentKey: 'mid', childKey: 'WRONG' }],
            },
          }),
          MP2: contractNode('MP2', {
            outputs: [{ key: 'mid', guaranteed: true }],
          }),
        },
        edges: [{ id: 'me1', from: 'MP1', to: 'MP2', event: 'NEXT' }],
      };

      registry.register(grandchild);
      registry.register(parent);

      const midResult = registry.verify('mid-bad');
      expect(midResult.valid).toBe(false);
      expect(midResult.warnings[0].code).toBe('RETURNMAP_KEY_NOT_IN_CHILD_OUTPUTS');
      expect(midResult.warnings[0].key).toBe('WRONG');
    });
  });

  // -----------------------------------------------------------------------
  // 3. Conditional paths (guarded edges)
  // -----------------------------------------------------------------------

  describe('conditional paths (guarded edges)', () => {
    it('fan-out: required input satisfied when one branch produces it', () => {
      // A → B (outputs: x), A → C (no outputs), B → D, C → D
      // D requires input 'x' — B produces it upstream.
      // Verifier accumulates keys globally in topo order, so 'x' is
      // produced by B before D is checked → no warning.
      const wf: Workflow = {
        id: 'fanout-one-branch',
        entry: 'A',
        nodes: {
          A: contractNode('A'),
          B: contractNode('B', {
            outputs: [{ key: 'x', guaranteed: true }],
          }),
          C: contractNode('C'),
          D: contractNode('D', {
            inputs: [{ key: 'x', required: true }],
          }),
        },
        edges: [
          { id: 'e-ab', from: 'A', to: 'B', event: 'LEFT' },
          { id: 'e-ac', from: 'A', to: 'C', event: 'RIGHT' },
          { id: 'e-bd', from: 'B', to: 'D', event: 'NEXT' },
          { id: 'e-cd', from: 'C', to: 'D', event: 'NEXT' },
        ],
      };

      registry.register(wf);
      const result = registry.verify('fanout-one-branch');

      // Static verifier is optimistic: ANY upstream path producing the key counts
      expect(result.valid).toBe(true);
      expect(result.warnings).toHaveLength(0);
    });

    it('fan-out with guards: guarded edges do not affect verification', () => {
      // A → B (guarded, outputs: x), A → C (guarded, no outputs)
      // B → END, C → END. END requires input 'x'.
      // Guards are runtime-only — verifier treats all paths equally.
      const wf: Workflow = {
        id: 'guarded-fanout',
        entry: 'A',
        nodes: {
          A: contractNode('A'),
          B: contractNode('B', {
            outputs: [{ key: 'x', guaranteed: true }],
          }),
          C: contractNode('C'),
          END: contractNode('END', {
            inputs: [{ key: 'x', required: true }],
          }),
        },
        edges: [
          {
            id: 'e-ab',
            from: 'A',
            to: 'B',
            event: 'LEFT',
            guard: { type: 'exists', key: 'flag' },
          },
          {
            id: 'e-ac',
            from: 'A',
            to: 'C',
            event: 'RIGHT',
            guard: { type: 'not-exists', key: 'flag' },
          },
          { id: 'e-bend', from: 'B', to: 'END', event: 'NEXT' },
          { id: 'e-cend', from: 'C', to: 'END', event: 'NEXT' },
        ],
      };

      registry.register(wf);
      const result = registry.verify('guarded-fanout');

      // B produces 'x' on one guarded path — verifier sees it as produced
      expect(result.valid).toBe(true);
      expect(result.warnings).toHaveLength(0);
    });

    it('diamond pattern: all paths produce input → no warning', () => {
      // A → B (outputs: x), A → C (outputs: x), B → D, C → D
      // D requires 'x' — both paths produce it
      const wf: Workflow = {
        id: 'diamond-both',
        entry: 'A',
        nodes: {
          A: contractNode('A'),
          B: contractNode('B', {
            outputs: [{ key: 'x', guaranteed: true }],
          }),
          C: contractNode('C', {
            outputs: [{ key: 'x', guaranteed: true }],
          }),
          D: contractNode('D', {
            inputs: [{ key: 'x', required: true }],
          }),
        },
        edges: [
          { id: 'e-ab', from: 'A', to: 'B', event: 'LEFT' },
          { id: 'e-ac', from: 'A', to: 'C', event: 'RIGHT' },
          { id: 'e-bd', from: 'B', to: 'D', event: 'NEXT' },
          { id: 'e-cd', from: 'C', to: 'D', event: 'NEXT' },
        ],
      };

      registry.register(wf);
      const result = registry.verify('diamond-both');

      expect(result.valid).toBe(true);
      expect(result.warnings).toHaveLength(0);
    });

    it('diamond pattern: no path produces required input → warning', () => {
      // A → B (no outputs), A → C (no outputs), B → D, C → D
      // D requires 'x' — neither path produces it
      const wf: Workflow = {
        id: 'diamond-none',
        entry: 'A',
        nodes: {
          A: contractNode('A'),
          B: contractNode('B'),
          C: contractNode('C'),
          D: contractNode('D', {
            inputs: [{ key: 'x', required: true }],
          }),
        },
        edges: [
          { id: 'e-ab', from: 'A', to: 'B', event: 'LEFT' },
          { id: 'e-ac', from: 'A', to: 'C', event: 'RIGHT' },
          { id: 'e-bd', from: 'B', to: 'D', event: 'NEXT' },
          { id: 'e-cd', from: 'C', to: 'D', event: 'NEXT' },
        ],
      };

      registry.register(wf);
      const result = registry.verify('diamond-none');

      expect(result.valid).toBe(false);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0].code).toBe('MISSING_REQUIRED_INPUT');
      expect(result.warnings[0].nodeId).toBe('D');
      expect(result.warnings[0].key).toBe('x');
    });

    it('sequential chain: upstream output satisfies downstream input across multiple hops', () => {
      // A (outputs: x) → B → C → D (inputs: x required)
      // x produced at A, consumed at D — should pass
      const wf: Workflow = {
        id: 'chain-pass',
        entry: 'A',
        nodes: {
          A: contractNode('A', {
            outputs: [{ key: 'x', guaranteed: true }],
          }),
          B: contractNode('B'),
          C: contractNode('C'),
          D: contractNode('D', {
            inputs: [{ key: 'x', required: true }],
          }),
        },
        edges: [
          { id: 'e1', from: 'A', to: 'B', event: 'NEXT' },
          { id: 'e2', from: 'B', to: 'C', event: 'NEXT' },
          { id: 'e3', from: 'C', to: 'D', event: 'NEXT' },
        ],
      };

      registry.register(wf);
      const result = registry.verify('chain-pass');

      expect(result.valid).toBe(true);
      expect(result.warnings).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // 4. Programmatic workflow without contracts
  // -----------------------------------------------------------------------

  describe('workflow without contracts', () => {
    it('verification returns clean for workflow with no contracts at all', () => {
      const wf: Workflow = {
        id: 'no-contracts',
        entry: 'A',
        nodes: {
          A: bareNode('A'),
          B: bareNode('B'),
          C: bareNode('C'),
        },
        edges: [
          { id: 'e1', from: 'A', to: 'B', event: 'NEXT' },
          { id: 'e2', from: 'B', to: 'C', event: 'NEXT' },
        ],
      };

      registry.register(wf);
      const result = registry.verify('no-contracts');

      expect(result.valid).toBe(true);
      expect(result.warnings).toHaveLength(0);
      expect(result.workflowId).toBe('no-contracts');
    });

    it('single-node workflow without contracts verifies clean', () => {
      const wf: Workflow = {
        id: 'single-bare',
        entry: 'A',
        nodes: { A: bareNode('A') },
        edges: [],
      };

      registry.register(wf);
      const result = registry.verify('single-bare');

      expect(result.valid).toBe(true);
      expect(result.warnings).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // 5. Mixed workflow (some nodes with contracts, some without)
  // -----------------------------------------------------------------------

  describe('mixed contracts', () => {
    it('only declared nodes are checked — undeclared nodes silently skipped', () => {
      // A (bare) → B (bare) → C (inputs: x required)
      // Neither A nor B declares outputs, but they also don't declare inputs
      // so no warnings for them. Only C gets checked and x is missing → 1 warning.
      const wf: Workflow = {
        id: 'mixed-check',
        entry: 'A',
        nodes: {
          A: bareNode('A'),
          B: bareNode('B'),
          C: contractNode('C', {
            inputs: [{ key: 'x', required: true }],
          }),
        },
        edges: [
          { id: 'e1', from: 'A', to: 'B', event: 'NEXT' },
          { id: 'e2', from: 'B', to: 'C', event: 'NEXT' },
        ],
      };

      registry.register(wf);
      const result = registry.verify('mixed-check');

      expect(result.valid).toBe(false);
      expect(result.warnings).toHaveLength(1);
      // Only node C has a warning — bare nodes generate nothing
      expect(result.warnings[0].nodeId).toBe('C');
    });

    it('bare node with declared outputs contributes to upstream tracking', () => {
      // A (outputs: x, no inputs) → B (bare) → C (inputs: x required)
      // A has outputs but no inputs — its output still satisfies C
      const wf: Workflow = {
        id: 'output-only-node',
        entry: 'A',
        nodes: {
          A: contractNode('A', {
            outputs: [{ key: 'x', guaranteed: true }],
          }),
          B: bareNode('B'),
          C: contractNode('C', {
            inputs: [{ key: 'x', required: true }],
          }),
        },
        edges: [
          { id: 'e1', from: 'A', to: 'B', event: 'NEXT' },
          { id: 'e2', from: 'B', to: 'C', event: 'NEXT' },
        ],
      };

      registry.register(wf);
      const result = registry.verify('output-only-node');

      expect(result.valid).toBe(true);
      expect(result.warnings).toHaveLength(0);
    });

    it('node with inputs but no outputs is still checked', () => {
      // A (bare) → B (inputs: x required, no outputs)
      // B declares inputs but not outputs — should still get checked
      const wf: Workflow = {
        id: 'input-only-node',
        entry: 'A',
        nodes: {
          A: bareNode('A'),
          B: contractNode('B', {
            inputs: [{ key: 'x', required: true }],
          }),
        },
        edges: [{ id: 'e1', from: 'A', to: 'B', event: 'NEXT' }],
      };

      registry.register(wf);
      const result = registry.verify('input-only-node');

      expect(result.valid).toBe(false);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0].nodeId).toBe('B');
      expect(result.warnings[0].key).toBe('x');
    });

    it('mixed: contracted node satisfied by another contracted node among bare nodes', () => {
      // A (bare) → B (outputs: x) → C (bare) → D (inputs: x required)
      // Only B and D have contracts; B's output satisfies D's input
      const wf: Workflow = {
        id: 'mixed-satisfied',
        entry: 'A',
        nodes: {
          A: bareNode('A'),
          B: contractNode('B', {
            outputs: [{ key: 'x', guaranteed: true }],
          }),
          C: bareNode('C'),
          D: contractNode('D', {
            inputs: [{ key: 'x', required: true }],
          }),
        },
        edges: [
          { id: 'e1', from: 'A', to: 'B', event: 'NEXT' },
          { id: 'e2', from: 'B', to: 'C', event: 'NEXT' },
          { id: 'e3', from: 'C', to: 'D', event: 'NEXT' },
        ],
      };

      registry.register(wf);
      const result = registry.verify('mixed-satisfied');

      expect(result.valid).toBe(true);
      expect(result.warnings).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // 6. Edge cases
  // -----------------------------------------------------------------------

  describe('edge cases', () => {
    it('single-node workflow with contracts verifies (entry = terminal)', () => {
      // A is both entry and terminal, has an input requirement
      // No upstream exists → warning
      const wf: Workflow = {
        id: 'single-contract',
        entry: 'A',
        nodes: {
          A: contractNode('A', {
            inputs: [{ key: 'x', required: true }],
            outputs: [{ key: 'y', guaranteed: true }],
          }),
        },
        edges: [],
      };

      registry.register(wf);
      const result = registry.verify('single-contract');

      expect(result.valid).toBe(false);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0].code).toBe('MISSING_REQUIRED_INPUT');
      expect(result.warnings[0].nodeId).toBe('A');
    });

    it('single-node workflow with only outputs verifies clean', () => {
      const wf: Workflow = {
        id: 'single-output',
        entry: 'A',
        nodes: {
          A: contractNode('A', {
            outputs: [{ key: 'y', guaranteed: true }],
          }),
        },
        edges: [],
      };

      registry.register(wf);
      const result = registry.verify('single-output');

      expect(result.valid).toBe(true);
      expect(result.warnings).toHaveLength(0);
    });

    it('empty inputs array is treated as no inputs (no warnings)', () => {
      const wf: Workflow = {
        id: 'empty-inputs',
        entry: 'A',
        nodes: {
          A: contractNode('A', { inputs: [] }),
          B: contractNode('B'),
        },
        edges: [{ id: 'e1', from: 'A', to: 'B', event: 'NEXT' }],
      };

      registry.register(wf);
      const result = registry.verify('empty-inputs');

      expect(result.valid).toBe(true);
      expect(result.warnings).toHaveLength(0);
    });

    it('empty outputs array is treated as no outputs', () => {
      // A (outputs: []) → B (inputs: x required) → x still missing
      const wf: Workflow = {
        id: 'empty-outputs',
        entry: 'A',
        nodes: {
          A: contractNode('A', { outputs: [] }),
          B: contractNode('B', {
            inputs: [{ key: 'x', required: true }],
          }),
        },
        edges: [{ id: 'e1', from: 'A', to: 'B', event: 'NEXT' }],
      };

      registry.register(wf);
      const result = registry.verify('empty-outputs');

      expect(result.valid).toBe(false);
      expect(result.warnings).toHaveLength(1);
    });

    it('description fields on contracts are informational only', () => {
      // Descriptions don't affect verification logic
      const wf: Workflow = {
        id: 'with-descriptions',
        entry: 'A',
        nodes: {
          A: contractNode('A', {
            outputs: [
              {
                key: 'x',
                guaranteed: true,
                description: 'The main output value',
              },
            ],
          }),
          B: contractNode('B', {
            inputs: [
              {
                key: 'x',
                required: true,
                description: 'Expects the main output',
              },
            ],
          }),
        },
        edges: [{ id: 'e1', from: 'A', to: 'B', event: 'NEXT' }],
      };

      registry.register(wf);
      const result = registry.verify('with-descriptions');

      expect(result.valid).toBe(true);
      expect(result.warnings).toHaveLength(0);
    });

    it('multiple required inputs: each checked independently', () => {
      // B requires x, y, z — A only produces x
      const wf: Workflow = {
        id: 'multi-input',
        entry: 'A',
        nodes: {
          A: contractNode('A', {
            outputs: [{ key: 'x', guaranteed: true }],
          }),
          B: contractNode('B', {
            inputs: [
              { key: 'x', required: true },
              { key: 'y', required: true },
              { key: 'z', required: true },
            ],
          }),
        },
        edges: [{ id: 'e1', from: 'A', to: 'B', event: 'NEXT' }],
      };

      registry.register(wf);
      const result = registry.verify('multi-input');

      expect(result.valid).toBe(false);
      expect(result.warnings).toHaveLength(2);
      const missingKeys = result.warnings.map((w) => w.key).sort();
      expect(missingKeys).toEqual(['y', 'z']);
    });

    it('multiple nodes producing same key: later consumer sees it satisfied', () => {
      // A (outputs: x) → B (outputs: x) → C (inputs: x required)
      // Both A and B produce x — no conflict, C is satisfied
      const wf: Workflow = {
        id: 'duplicate-output',
        entry: 'A',
        nodes: {
          A: contractNode('A', {
            outputs: [{ key: 'x', guaranteed: true }],
          }),
          B: contractNode('B', {
            outputs: [{ key: 'x', guaranteed: true }],
          }),
          C: contractNode('C', {
            inputs: [{ key: 'x', required: true }],
          }),
        },
        edges: [
          { id: 'e1', from: 'A', to: 'B', event: 'NEXT' },
          { id: 'e2', from: 'B', to: 'C', event: 'NEXT' },
        ],
      };

      registry.register(wf);
      const result = registry.verify('duplicate-output');

      expect(result.valid).toBe(true);
      expect(result.warnings).toHaveLength(0);
    });

    it('node reads its own output: input satisfied if declared before outputs in same node', () => {
      // A single node with both input x (required) and output x
      // The verifier checks inputs BEFORE adding outputs for the current node
      // So this should warn — the node can't satisfy its own input
      const wf: Workflow = {
        id: 'self-reference',
        entry: 'A',
        nodes: {
          A: contractNode('A', {
            inputs: [{ key: 'x', required: true }],
            outputs: [{ key: 'x', guaranteed: true }],
          }),
        },
        edges: [],
      };

      registry.register(wf);
      const result = registry.verify('self-reference');

      // Node can't satisfy its own required input — inputs checked before outputs added
      expect(result.valid).toBe(false);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0].nodeId).toBe('A');
      expect(result.warnings[0].key).toBe('x');
    });

    it('child workflow with no declared outputs: returnMap not verified', () => {
      // Child terminals have no outputs → returnMap check is skipped gracefully
      const child: Workflow = {
        id: 'child-no-outputs',
        entry: 'C',
        nodes: { C: bareNode('C') },
        edges: [],
      };

      const parent: Workflow = {
        id: 'parent-skip-check',
        entry: 'P',
        nodes: {
          P: contractNode('P', {
            invokes: {
              workflowId: 'child-no-outputs',
              returnMap: [{ parentKey: 'result', childKey: 'anything' }],
            },
          }),
          DONE: contractNode('DONE'),
        },
        edges: [{ id: 'e1', from: 'P', to: 'DONE', event: 'NEXT' }],
      };

      registry.register(child);
      registry.register(parent);

      const result = registry.verify('parent-skip-check');
      // No warnings — child has no declared outputs so check is skipped
      expect(result.valid).toBe(true);
      expect(result.warnings).toHaveLength(0);
    });

    it('VerificationResult contains correct workflowId', () => {
      const wf: Workflow = {
        id: 'id-check',
        entry: 'A',
        nodes: { A: bareNode('A') },
        edges: [],
      };

      registry.register(wf);
      const result = registry.verify('id-check');

      expect(result.workflowId).toBe('id-check');
    });

    it('throws WORKFLOW_NOT_FOUND for unregistered workflow', () => {
      expect(() => registry.verify('ghost')).toThrow(WorkflowValidationError);

      try {
        registry.verify('ghost');
      } catch (e) {
        const err = e as WorkflowValidationError;
        expect(err.code).toBe('WORKFLOW_NOT_FOUND');
        expect(err.workflowId).toBe('ghost');
      }
    });
  });
});
