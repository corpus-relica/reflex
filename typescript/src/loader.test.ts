import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadWorkflow } from './loader';
import { WorkflowValidationError } from './registry';
import type { BuiltinGuard, CustomGuard, BlackboardReader } from './types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtureDir = resolve(__dirname, '../../docs/fixtures');

function readFixture(name: string): string {
  return readFileSync(resolve(fixtureDir, name), 'utf-8');
}

function parseFixture(name: string): unknown {
  return JSON.parse(readFixture(name));
}

const stubGuard = (_bb: BlackboardReader) => true;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('loadWorkflow', () => {
  // -----------------------------------------------------------------------
  // Valid inputs
  // -----------------------------------------------------------------------

  describe('valid inputs', () => {
    it('loads greeting.json from parsed object', () => {
      const wf = loadWorkflow(parseFixture('greeting.json'));
      expect(wf.id).toBe('greeting');
      expect(wf.entry).toBe('ASK_NAME');
      expect(Object.keys(wf.nodes)).toHaveLength(3);
      expect(wf.edges).toHaveLength(2);
    });

    it('loads greeting.json from raw JSON string', () => {
      const wf = loadWorkflow(readFixture('greeting.json'));
      expect(wf.id).toBe('greeting');
      expect(Object.keys(wf.nodes)).toHaveLength(3);
    });

    it('loads define-part-object.json with invocation spec', () => {
      const wf = loadWorkflow(parseFixture('define-part-object.json'));
      expect(wf.id).toBe('define-part-object');
      expect(wf.entry).toBe('PART_CLASSIFY');
      expect(Object.keys(wf.nodes)).toHaveLength(3);
      expect(wf.edges).toHaveLength(2);
    });

    it('loads define-physical-object.json with builtin guards', () => {
      const wf = loadWorkflow(
        parseFixture('define-physical-object.json'),
      );
      expect(wf.id).toBe('define-physical-object');
      expect(Object.keys(wf.nodes)).toHaveLength(6);
      expect(wf.edges).toHaveLength(6);

      // Check exists guard
      const branchToPart = wf.edges.find(
        (e) => e.id === 'e-branch-to-part',
      )!;
      expect(branchToPart.guard).toBeDefined();
      const existsGuard = branchToPart.guard as BuiltinGuard;
      expect(existsGuard.type).toBe('exists');
      expect(existsGuard.key).toBe('needsPart');

      // Check not-exists guard
      const branchToSpec = wf.edges.find(
        (e) => e.id === 'e-branch-to-spec',
      )!;
      expect(branchToSpec.guard).toBeDefined();
      const notExistsGuard = branchToSpec.guard as BuiltinGuard;
      expect(notExistsGuard.type).toBe('not-exists');
      expect(notExistsGuard.key).toBe('needsPart');
    });

    it('preserves invocation spec on nodes', () => {
      const wf = loadWorkflow(
        parseFixture('define-physical-object.json'),
      );
      const definePart = wf.nodes['DEFINE_PART'];
      expect(definePart.invokes).toBeDefined();
      expect(definePart.invokes!.workflowId).toBe('define-part-object');
      expect(definePart.invokes!.returnMap).toEqual([
        { parentKey: 'Part Concept', childKey: 'partConcept' },
      ]);
    });

    it('preserves node spec as freeform object', () => {
      const wf = loadWorkflow(parseFixture('greeting.json'));
      const askName = wf.nodes['ASK_NAME'];
      expect(askName.spec).toEqual({
        prompt: 'Ask the user for their name',
        outputKey: 'userName',
      });
    });

    it('preserves node description when present', () => {
      const wf = loadWorkflow(parseFixture('greeting.json'));
      expect(wf.nodes['GREET'].description).toBe(
        'Generate a personalized greeting',
      );
    });

    it('allows $schema field in input', () => {
      // Fixtures include $schema — should not throw
      const wf = loadWorkflow(parseFixture('greeting.json'));
      expect(wf.id).toBe('greeting');
    });

    it('edges without guards have guard undefined', () => {
      const wf = loadWorkflow(parseFixture('greeting.json'));
      for (const edge of wf.edges) {
        expect(edge.guard).toBeUndefined();
      }
    });
  });

  // -----------------------------------------------------------------------
  // Custom guard resolution
  // -----------------------------------------------------------------------

  describe('custom guard resolution', () => {
    it('resolves custom guard from registry', () => {
      const input = {
        id: 'test',
        entry: 'A',
        nodes: {
          A: { id: 'A', spec: {} },
          B: { id: 'B', spec: {} },
        },
        edges: [
          {
            id: 'e1',
            from: 'A',
            to: 'B',
            event: 'NEXT',
            guard: { type: 'custom', name: 'myGuard' },
          },
        ],
      };

      const wf = loadWorkflow(input, { guards: { myGuard: stubGuard } });
      const guard = wf.edges[0].guard as CustomGuard;
      expect(guard.type).toBe('custom');
      expect(guard.evaluate).toBe(stubGuard);
    });

    it('throws UNKNOWN_GUARD_REFERENCE for missing guard', () => {
      const input = {
        id: 'test',
        entry: 'A',
        nodes: {
          A: { id: 'A', spec: {} },
          B: { id: 'B', spec: {} },
        },
        edges: [
          {
            id: 'e1',
            from: 'A',
            to: 'B',
            event: 'NEXT',
            guard: { type: 'custom', name: 'nonExistent' },
          },
        ],
      };

      expect(() => loadWorkflow(input)).toThrow(WorkflowValidationError);
      try {
        loadWorkflow(input);
      } catch (e) {
        const err = e as WorkflowValidationError;
        expect(err.code).toBe('UNKNOWN_GUARD_REFERENCE');
        expect(err.workflowId).toBe('test');
      }
    });

    it('throws UNKNOWN_GUARD_REFERENCE when registry provided but name missing', () => {
      const input = {
        id: 'test',
        entry: 'A',
        nodes: {
          A: { id: 'A', spec: {} },
          B: { id: 'B', spec: {} },
        },
        edges: [
          {
            id: 'e1',
            from: 'A',
            to: 'B',
            event: 'NEXT',
            guard: { type: 'custom', name: 'missing' },
          },
        ],
      };

      expect(() =>
        loadWorkflow(input, { guards: { otherGuard: stubGuard } }),
      ).toThrow(WorkflowValidationError);
    });
  });

  // -----------------------------------------------------------------------
  // Schema violations
  // -----------------------------------------------------------------------

  describe('schema violations', () => {
    it('throws on invalid JSON string', () => {
      expect(() => loadWorkflow('not valid json{')).toThrow(
        WorkflowValidationError,
      );
      try {
        loadWorkflow('not valid json{');
      } catch (e) {
        expect((e as WorkflowValidationError).code).toBe('SCHEMA_VIOLATION');
      }
    });

    it('throws on missing id', () => {
      const input = { entry: 'A', nodes: { A: { id: 'A', spec: {} } }, edges: [] };
      expect(() => loadWorkflow(input)).toThrow(WorkflowValidationError);
    });

    it('throws on missing entry', () => {
      const input = { id: 'x', nodes: { A: { id: 'A', spec: {} } }, edges: [] };
      expect(() => loadWorkflow(input)).toThrow(WorkflowValidationError);
    });

    it('throws on missing nodes', () => {
      const input = { id: 'x', entry: 'A', edges: [] };
      expect(() => loadWorkflow(input)).toThrow(WorkflowValidationError);
    });

    it('throws on missing edges', () => {
      const input = { id: 'x', entry: 'A', nodes: { A: { id: 'A', spec: {} } } };
      expect(() => loadWorkflow(input)).toThrow(WorkflowValidationError);
    });

    it('throws when nodes is an array instead of object', () => {
      const input = {
        id: 'x',
        entry: 'A',
        nodes: [{ id: 'A', spec: {} }],
        edges: [],
      };
      expect(() => loadWorkflow(input)).toThrow(WorkflowValidationError);
    });

    it('throws on unknown guard type', () => {
      const input = {
        id: 'x',
        entry: 'A',
        nodes: {
          A: { id: 'A', spec: {} },
          B: { id: 'B', spec: {} },
        },
        edges: [
          {
            id: 'e1',
            from: 'A',
            to: 'B',
            event: 'NEXT',
            guard: { type: 'bogus', key: 'x' },
          },
        ],
      };
      expect(() => loadWorkflow(input)).toThrow(WorkflowValidationError);
    });

    it('throws on non-object input', () => {
      expect(() => loadWorkflow(42)).toThrow(WorkflowValidationError);
    });

    it('loads node with inputs and outputs contracts', () => {
      const wf = loadWorkflow({
        id: 'contracts',
        entry: 'A',
        nodes: {
          A: {
            id: 'A',
            spec: {},
            inputs: [
              { key: 'userName', required: true, description: 'The user name' },
              { key: 'optional', required: false },
            ],
            outputs: [
              { key: 'greeting', guaranteed: true, description: 'The greeting message' },
            ],
          },
        },
        edges: [],
      });
      expect(wf.nodes['A'].inputs).toHaveLength(2);
      expect(wf.nodes['A'].inputs![0]).toEqual({
        key: 'userName',
        required: true,
        description: 'The user name',
      });
      expect(wf.nodes['A'].inputs![1]).toEqual({
        key: 'optional',
        required: false,
      });
      expect(wf.nodes['A'].outputs).toHaveLength(1);
      expect(wf.nodes['A'].outputs![0]).toEqual({
        key: 'greeting',
        guaranteed: true,
        description: 'The greeting message',
      });
    });

    it('nodes without contracts load with undefined inputs/outputs', () => {
      const wf = loadWorkflow({
        id: 'no-contracts',
        entry: 'A',
        nodes: { A: { id: 'A', spec: {} } },
        edges: [],
      });
      expect(wf.nodes['A'].inputs).toBeUndefined();
      expect(wf.nodes['A'].outputs).toBeUndefined();
    });

    it('all schema violations use SCHEMA_VIOLATION code', () => {
      const cases = [
        { entry: 'A', nodes: {}, edges: [] }, // missing id
        'not json{', // invalid JSON string
        42, // non-object
      ];

      for (const input of cases) {
        try {
          loadWorkflow(input);
        } catch (e) {
          expect((e as WorkflowValidationError).code).toBe('SCHEMA_VIOLATION');
        }
      }
    });
  });
});
