import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serializeWorkflow } from './serializer';
import { loadWorkflow } from './loader';
import { WorkflowRegistry, WorkflowValidationError } from './registry';
import { greetingWorkflow } from './examples/greeting-workflow';
import {
  definePartObjectWorkflow,
  definePhysicalObjectWorkflow,
} from './examples/phys-obj-workflows';
import type {
  BlackboardReader,
  BuiltinGuard,
  CustomGuard,
  Workflow,
} from './types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtureDir = resolve(__dirname, '../../docs/fixtures');

function readFixture(name: string): string {
  return readFileSync(resolve(fixtureDir, name), 'utf-8');
}

const stubGuard = (_bb: BlackboardReader) => true;

/** Compare two workflows structurally (ignoring custom guard function identity). */
function assertWorkflowEqual(
  actual: Workflow,
  expected: Workflow,
  compareGuardFns = false,
): void {
  expect(actual.id).toBe(expected.id);
  expect(actual.entry).toBe(expected.entry);
  expect(Object.keys(actual.nodes).sort()).toEqual(
    Object.keys(expected.nodes).sort(),
  );

  // Compare nodes
  for (const [key, aNode] of Object.entries(actual.nodes)) {
    const eNode = expected.nodes[key];
    expect(aNode.id).toBe(eNode.id);
    expect(aNode.description).toBe(eNode.description);
    expect(aNode.spec).toEqual(eNode.spec);
    if (eNode.invokes) {
      expect(aNode.invokes).toBeDefined();
      expect(aNode.invokes!.workflowId).toBe(eNode.invokes.workflowId);
      expect(aNode.invokes!.returnMap).toEqual(eNode.invokes.returnMap);
    } else {
      expect(aNode.invokes).toBeUndefined();
    }
  }

  // Compare edges
  expect(actual.edges).toHaveLength(expected.edges.length);
  for (let i = 0; i < expected.edges.length; i++) {
    const aEdge = actual.edges[i];
    const eEdge = expected.edges[i];
    expect(aEdge.id).toBe(eEdge.id);
    expect(aEdge.from).toBe(eEdge.from);
    expect(aEdge.to).toBe(eEdge.to);
    expect(aEdge.event).toBe(eEdge.event);

    if (eEdge.guard === undefined) {
      expect(aEdge.guard).toBeUndefined();
    } else if (eEdge.guard.type === 'custom') {
      expect(aEdge.guard).toBeDefined();
      expect(aEdge.guard!.type).toBe('custom');
      if (compareGuardFns) {
        expect((aEdge.guard as CustomGuard).evaluate).toBe(
          (eEdge.guard as CustomGuard).evaluate,
        );
      }
    } else {
      expect(aEdge.guard).toEqual(eEdge.guard);
    }
  }

  // Compare metadata
  expect(actual.metadata).toEqual(expected.metadata);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('serializeWorkflow', () => {
  // -----------------------------------------------------------------------
  // Basic serialization
  // -----------------------------------------------------------------------

  describe('basic serialization', () => {
    it('serializes greeting workflow to valid JSON string', () => {
      const json = serializeWorkflow(greetingWorkflow);
      const parsed = JSON.parse(json);
      expect(parsed.id).toBe('greeting');
      expect(parsed.entry).toBe('ASK_NAME');
      expect(Object.keys(parsed.nodes)).toHaveLength(3);
      expect(parsed.edges).toHaveLength(2);
    });

    it('serializes builtin guards (exists, not-exists) correctly', () => {
      const json = serializeWorkflow(definePhysicalObjectWorkflow);
      const parsed = JSON.parse(json);

      const branchToPart = parsed.edges.find(
        (e: any) => e.id === 'e-branch-to-part',
      );
      expect(branchToPart.guard).toEqual({ type: 'exists', key: 'needsPart' });

      const branchToSpec = parsed.edges.find(
        (e: any) => e.id === 'e-branch-to-spec',
      );
      expect(branchToSpec.guard).toEqual({
        type: 'not-exists',
        key: 'needsPart',
      });
    });

    it('serializes equals guard with value', () => {
      const wf: Workflow = {
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
            guard: { type: 'equals', key: 'mode', value: 'fast' },
          },
        ],
      };
      const parsed = JSON.parse(serializeWorkflow(wf));
      expect(parsed.edges[0].guard).toEqual({
        type: 'equals',
        key: 'mode',
        value: 'fast',
      });
    });

    it('omits guard field on edges without guards', () => {
      const json = serializeWorkflow(greetingWorkflow);
      const parsed = JSON.parse(json);
      for (const edge of parsed.edges) {
        expect(edge.guard).toBeUndefined();
      }
    });

    it('serializes invocation spec with returnMap', () => {
      const json = serializeWorkflow(definePhysicalObjectWorkflow);
      const parsed = JSON.parse(json);
      const definePart = parsed.nodes['DEFINE_PART'];
      expect(definePart.invokes).toEqual({
        workflowId: 'define-part-object',
        returnMap: [{ parentKey: 'Part Concept', childKey: 'partConcept' }],
      });
    });

    it('serializes node description when present', () => {
      const json = serializeWorkflow(greetingWorkflow);
      const parsed = JSON.parse(json);
      expect(parsed.nodes['GREET'].description).toBe(
        'Generate a personalized greeting',
      );
      expect(parsed.nodes['ASK_NAME'].description).toBeUndefined();
    });

    it('serializes metadata when present', () => {
      const wf: Workflow = {
        id: 'test',
        entry: 'A',
        nodes: { A: { id: 'A', spec: {} } },
        edges: [],
        metadata: { version: '1.0', author: 'test' },
      };
      const parsed = JSON.parse(serializeWorkflow(wf));
      expect(parsed.metadata).toEqual({ version: '1.0', author: 'test' });
    });

    it('omits metadata when not present', () => {
      const json = serializeWorkflow(greetingWorkflow);
      const parsed = JSON.parse(json);
      expect(parsed.metadata).toBeUndefined();
    });

    it('serializes inputs and outputs when present', () => {
      const wf: Workflow = {
        id: 'test',
        entry: 'A',
        nodes: {
          A: {
            id: 'A',
            spec: {},
            inputs: [
              { key: 'userName', required: true, description: 'The user name' },
            ],
            outputs: [
              { key: 'greeting', guaranteed: true },
            ],
          },
        },
        edges: [],
      };
      const parsed = JSON.parse(serializeWorkflow(wf));
      expect(parsed.nodes['A'].inputs).toEqual([
        { key: 'userName', required: true, description: 'The user name' },
      ]);
      expect(parsed.nodes['A'].outputs).toEqual([
        { key: 'greeting', guaranteed: true },
      ]);
    });

    it('omits inputs and outputs when not present', () => {
      const wf: Workflow = {
        id: 'test',
        entry: 'A',
        nodes: { A: { id: 'A', spec: {} } },
        edges: [],
      };
      const parsed = JSON.parse(serializeWorkflow(wf));
      expect(parsed.nodes['A'].inputs).toBeUndefined();
      expect(parsed.nodes['A'].outputs).toBeUndefined();
    });

    it('round-trips inputs and outputs through serialize → load', () => {
      const wf: Workflow = {
        id: 'contracts-rt',
        entry: 'A',
        nodes: {
          A: {
            id: 'A',
            spec: {},
            inputs: [
              { key: 'x', required: true },
              { key: 'y', required: false, description: 'optional input' },
            ],
            outputs: [
              { key: 'result', guaranteed: true, description: 'the result' },
              { key: 'debug', guaranteed: false },
            ],
          },
        },
        edges: [],
      };
      const json = serializeWorkflow(wf);
      const loaded = loadWorkflow(json);
      expect(loaded.nodes['A'].inputs).toEqual(wf.nodes['A'].inputs);
      expect(loaded.nodes['A'].outputs).toEqual(wf.nodes['A'].outputs);
    });
  });

  // -----------------------------------------------------------------------
  // Custom guard serialization
  // -----------------------------------------------------------------------

  describe('custom guard serialization', () => {
    it('serializes custom guard with guardNames map', () => {
      const wf: Workflow = {
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
            guard: { type: 'custom', evaluate: stubGuard },
          },
        ],
      };

      const guardNames = new Map();
      guardNames.set(stubGuard, 'myGuard');

      const parsed = JSON.parse(serializeWorkflow(wf, { guardNames }));
      expect(parsed.edges[0].guard).toEqual({
        type: 'custom',
        name: 'myGuard',
      });
    });

    it('throws if custom guard has no name in guardNames map', () => {
      const wf: Workflow = {
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
            guard: { type: 'custom', evaluate: stubGuard },
          },
        ],
      };

      expect(() => serializeWorkflow(wf)).toThrow(WorkflowValidationError);
    });

    it('throws SCHEMA_VIOLATION for missing guard name', () => {
      const wf: Workflow = {
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
            guard: { type: 'custom', evaluate: stubGuard },
          },
        ],
      };

      try {
        serializeWorkflow(wf);
      } catch (e) {
        expect((e as WorkflowValidationError).code).toBe('SCHEMA_VIOLATION');
      }
    });
  });

  // -----------------------------------------------------------------------
  // Round-trip: programmatic → serialize → load → deep equal
  // -----------------------------------------------------------------------

  describe('round-trip', () => {
    it('greeting workflow round-trips', () => {
      const json = serializeWorkflow(greetingWorkflow);
      const loaded = loadWorkflow(json);
      assertWorkflowEqual(loaded, greetingWorkflow);
    });

    it('define-part-object round-trips', () => {
      const json = serializeWorkflow(definePartObjectWorkflow);
      const loaded = loadWorkflow(json);
      assertWorkflowEqual(loaded, definePartObjectWorkflow);
    });

    it('define-physical-object with builtin guards round-trips', () => {
      const json = serializeWorkflow(definePhysicalObjectWorkflow);
      const loaded = loadWorkflow(json);
      assertWorkflowEqual(loaded, definePhysicalObjectWorkflow);
    });

    it('workflow with custom guard round-trips via guardNames + guardRegistry', () => {
      const wf: Workflow = {
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
            guard: { type: 'custom', evaluate: stubGuard },
          },
        ],
      };

      // Serialize with guard name map
      const guardNames = new Map();
      guardNames.set(stubGuard, 'myGuard');
      const json = serializeWorkflow(wf, { guardNames });

      // Load with guard registry
      const loaded = loadWorkflow(json, {
        guards: { myGuard: stubGuard },
      });

      // Custom guard should resolve to the same function
      const loadedGuard = loaded.edges[0].guard as CustomGuard;
      expect(loadedGuard.type).toBe('custom');
      expect(loadedGuard.evaluate).toBe(stubGuard);
    });

    it('round-tripped workflow passes registry validation', () => {
      const json = serializeWorkflow(greetingWorkflow);
      const loaded = loadWorkflow(json);
      const registry = new WorkflowRegistry();
      expect(() => registry.register(loaded)).not.toThrow();
    });

    it('serialized output is valid JSON loadable by loadWorkflow', () => {
      // Serialize all programmatic workflows and verify each is loadable
      const workflows = [
        greetingWorkflow,
        definePartObjectWorkflow,
        definePhysicalObjectWorkflow,
      ];
      for (const wf of workflows) {
        const json = serializeWorkflow(wf);
        expect(() => loadWorkflow(json)).not.toThrow();
      }
    });
  });

  // -----------------------------------------------------------------------
  // Fixture parity: programmatic workflows match fixtures
  // -----------------------------------------------------------------------

  describe('fixture parity', () => {
    it('greeting: programmatic matches fixture-loaded', () => {
      const fromFixture = loadWorkflow(readFixture('greeting.json'));
      assertWorkflowEqual(greetingWorkflow, fromFixture);
    });

    it('define-part-object: programmatic matches fixture-loaded', () => {
      const fromFixture = loadWorkflow(readFixture('define-part-object.json'));
      assertWorkflowEqual(definePartObjectWorkflow, fromFixture);
    });

    it('define-physical-object: programmatic matches fixture-loaded', () => {
      const fromFixture = loadWorkflow(
        readFixture('define-physical-object.json'),
      );
      assertWorkflowEqual(definePhysicalObjectWorkflow, fromFixture);
    });

    it('round-tripped programmatic equals fixture-loaded (greeting)', () => {
      const roundTripped = loadWorkflow(serializeWorkflow(greetingWorkflow));
      const fromFixture = loadWorkflow(readFixture('greeting.json'));
      assertWorkflowEqual(roundTripped, fromFixture);
    });

    it('round-tripped programmatic equals fixture-loaded (define-physical-object)', () => {
      const roundTripped = loadWorkflow(
        serializeWorkflow(definePhysicalObjectWorkflow),
      );
      const fromFixture = loadWorkflow(
        readFixture('define-physical-object.json'),
      );
      assertWorkflowEqual(roundTripped, fromFixture);
    });

    it('round-tripped programmatic equals fixture-loaded (define-part-object)', () => {
      const roundTripped = loadWorkflow(
        serializeWorkflow(definePartObjectWorkflow),
      );
      const fromFixture = loadWorkflow(
        readFixture('define-part-object.json'),
      );
      assertWorkflowEqual(roundTripped, fromFixture);
    });
  });
});
