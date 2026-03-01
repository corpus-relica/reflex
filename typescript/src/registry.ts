// Reflex — Workflow Registry with DAG Validation
// Implements DESIGN.md Section 3.3

import { Workflow } from './types.js';

// ---------------------------------------------------------------------------
// Validation Error
// ---------------------------------------------------------------------------

export type ValidationErrorCode =
  | 'CYCLE_DETECTED'
  | 'INVALID_EDGE'
  | 'INVALID_ENTRY_NODE'
  | 'NO_TERMINAL_NODES'
  | 'DUPLICATE_WORKFLOW_ID'
  | 'NODE_ID_MISMATCH'
  | 'EMPTY_WORKFLOW'
  | 'SCHEMA_VIOLATION'
  | 'UNKNOWN_GUARD_REFERENCE';

export class WorkflowValidationError extends Error {
  public readonly code: ValidationErrorCode;
  public readonly workflowId: string;
  public readonly details: Record<string, unknown>;

  constructor(
    code: ValidationErrorCode,
    workflowId: string,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'WorkflowValidationError';
    this.code = code;
    this.workflowId = workflowId;
    this.details = details;
  }
}

// ---------------------------------------------------------------------------
// Workflow Registry
// ---------------------------------------------------------------------------

export class WorkflowRegistry {
  private readonly workflows = new Map<string, Workflow>();

  /**
   * Validate and register a workflow.
   * Throws WorkflowValidationError on structural problems.
   * Logs a warning (but does not reject) for unregistered invocation refs.
   */
  register(workflow: Workflow): void {
    this.validateNoDuplicate(workflow);
    this.validateNotEmpty(workflow);
    this.validateEntryNode(workflow);
    this.validateNodeIdConsistency(workflow);
    this.validateEdgeIntegrity(workflow);
    this.validateTerminalNodes(workflow);
    this.validateAcyclic(workflow);
    this.warnInvocationRefs(workflow);

    this.workflows.set(workflow.id, workflow);
  }

  get(id: string): Workflow | undefined {
    return this.workflows.get(id);
  }

  has(id: string): boolean {
    return this.workflows.has(id);
  }

  list(): string[] {
    return Array.from(this.workflows.keys());
  }

  // -------------------------------------------------------------------------
  // Validation — private methods
  // -------------------------------------------------------------------------

  private validateNoDuplicate(workflow: Workflow): void {
    if (this.workflows.has(workflow.id)) {
      throw new WorkflowValidationError(
        'DUPLICATE_WORKFLOW_ID',
        workflow.id,
        `Workflow '${workflow.id}' is already registered`,
      );
    }
  }

  private validateNotEmpty(workflow: Workflow): void {
    if (Object.keys(workflow.nodes).length === 0) {
      throw new WorkflowValidationError(
        'EMPTY_WORKFLOW',
        workflow.id,
        `Workflow '${workflow.id}' has no nodes`,
      );
    }
  }

  private validateEntryNode(workflow: Workflow): void {
    if (!(workflow.entry in workflow.nodes)) {
      throw new WorkflowValidationError(
        'INVALID_ENTRY_NODE',
        workflow.id,
        `Workflow '${workflow.id}' declares entry node '${workflow.entry}' which does not exist in nodes`,
        { entry: workflow.entry },
      );
    }
  }

  private validateNodeIdConsistency(workflow: Workflow): void {
    for (const [key, node] of Object.entries(workflow.nodes)) {
      if (key !== node.id) {
        throw new WorkflowValidationError(
          'NODE_ID_MISMATCH',
          workflow.id,
          `Workflow '${workflow.id}': node dict key '${key}' does not match node.id '${node.id}'`,
          { key, nodeId: node.id },
        );
      }
    }
  }

  private validateEdgeIntegrity(workflow: Workflow): void {
    const nodeIds = new Set(Object.keys(workflow.nodes));

    for (const edge of workflow.edges) {
      if (!nodeIds.has(edge.from)) {
        throw new WorkflowValidationError(
          'INVALID_EDGE',
          workflow.id,
          `Workflow '${workflow.id}': edge '${edge.id}' references non-existent source node '${edge.from}'`,
          { edgeId: edge.id, field: 'from', nodeId: edge.from },
        );
      }
      if (!nodeIds.has(edge.to)) {
        throw new WorkflowValidationError(
          'INVALID_EDGE',
          workflow.id,
          `Workflow '${workflow.id}': edge '${edge.id}' references non-existent target node '${edge.to}'`,
          { edgeId: edge.id, field: 'to', nodeId: edge.to },
        );
      }
    }
  }

  private validateTerminalNodes(workflow: Workflow): void {
    const nodesWithOutgoing = new Set<string>();
    for (const edge of workflow.edges) {
      nodesWithOutgoing.add(edge.from);
    }

    const terminalNodes = Object.keys(workflow.nodes).filter(
      (id) => !nodesWithOutgoing.has(id),
    );

    if (terminalNodes.length === 0) {
      throw new WorkflowValidationError(
        'NO_TERMINAL_NODES',
        workflow.id,
        `Workflow '${workflow.id}' has no terminal nodes (every node has outgoing edges)`,
      );
    }
  }

  /**
   * Validate acyclicity using Kahn's algorithm (topological sort).
   * O(V + E) — standard approach for DAG validation.
   */
  private validateAcyclic(workflow: Workflow): void {
    const nodeIds = Object.keys(workflow.nodes);
    const inDegree = new Map<string, number>();
    const adjList = new Map<string, string[]>();

    // Initialize
    for (const id of nodeIds) {
      inDegree.set(id, 0);
      adjList.set(id, []);
    }

    // Build graph from edges
    for (const edge of workflow.edges) {
      adjList.get(edge.from)!.push(edge.to);
      inDegree.set(edge.to, inDegree.get(edge.to)! + 1);
    }

    // Kahn's algorithm: process nodes with zero in-degree
    const queue: string[] = [];
    for (const [id, degree] of inDegree) {
      if (degree === 0) queue.push(id);
    }

    const sorted: string[] = [];
    while (queue.length > 0) {
      const node = queue.shift()!;
      sorted.push(node);

      for (const neighbor of adjList.get(node)!) {
        const newDegree = inDegree.get(neighbor)! - 1;
        inDegree.set(neighbor, newDegree);
        if (newDegree === 0) queue.push(neighbor);
      }
    }

    // If not all nodes were processed, a cycle exists
    if (sorted.length !== nodeIds.length) {
      const nodesInCycle = nodeIds.filter((id) => !sorted.includes(id));
      throw new WorkflowValidationError(
        'CYCLE_DETECTED',
        workflow.id,
        `Workflow '${workflow.id}' contains a cycle involving nodes: ${nodesInCycle.join(', ')}`,
        { nodesInCycle },
      );
    }
  }

  /**
   * Warn (but don't reject) if invocation refs point to unregistered workflows.
   * The target workflow may be registered later.
   */
  private warnInvocationRefs(workflow: Workflow): void {
    for (const [nodeId, node] of Object.entries(workflow.nodes)) {
      if (node.invokes && !this.workflows.has(node.invokes.workflowId)) {
        console.warn(
          `Workflow '${workflow.id}', node '${nodeId}': invokes workflow '${node.invokes.workflowId}' which is not yet registered`,
        );
      }
    }
  }
}
