// Reflex — Execution Tree
// Tracks child workflow invocations, their lifecycle, and pruning on rewind.

import type {
  InvocationId,
  ExecutionRecord,
  ExecutionTreeState,
  ReturnMapping,
} from './types.js';

export interface RecordOptions {
  parentInvocationId?: InvocationId;
  returnMap?: ReturnMapping[];
}

/**
 * Flat map of execution records with parent/child linkage.
 * Tracks invocation lifecycle: active → completed | invalidated.
 */
export class ExecutionTree {
  private _records = new Map<InvocationId, ExecutionRecord>();

  /**
   * Create an active execution record. Returns the new invocation ID.
   */
  record(
    parentWorkflowId: string,
    parentNodeId: string,
    childWorkflowId: string,
    opts?: RecordOptions,
  ): InvocationId {
    const invocationId = crypto.randomUUID();
    const record: ExecutionRecord = {
      invocationId,
      parentInvocationId: opts?.parentInvocationId,
      parentWorkflowId,
      parentNodeId,
      childWorkflowId,
      returnMap: opts?.returnMap,
      status: 'active',
      childInvocationIds: [],
    };
    this._records.set(invocationId, record);
    return invocationId;
  }

  /**
   * Transition an active record to completed. No-op if not found or not active.
   */
  complete(invocationId: InvocationId): void {
    const record = this._records.get(invocationId);
    if (record && record.status === 'active') {
      record.status = 'completed';
    }
  }

  /**
   * Mark records and all their descendants as invalidated.
   * Returns the full set of IDs that actually changed status (empty if none).
   */
  invalidate(invocationIds: InvocationId[]): InvocationId[] {
    const changed: InvocationId[] = [];
    const queue = [...invocationIds];

    while (queue.length > 0) {
      const id = queue.pop()!;
      const record = this._records.get(id);
      if (!record || record.status === 'invalidated') continue;

      record.status = 'invalidated';
      changed.push(id);
      // Cascade to children
      queue.push(...record.childInvocationIds);
    }

    return changed;
  }

  /**
   * Find all active/completed records for a (parentWorkflowId, parentNodeId)
   * pair, invalidate them and their descendants. Returns invalidated IDs.
   */
  pruneForReinvoke(
    parentWorkflowId: string,
    parentNodeId: string,
  ): InvocationId[] {
    const toInvalidate: InvocationId[] = [];
    for (const record of this._records.values()) {
      if (
        record.parentWorkflowId === parentWorkflowId &&
        record.parentNodeId === parentNodeId &&
        record.status !== 'invalidated'
      ) {
        toInvalidate.push(record.invocationId);
      }
    }
    if (toInvalidate.length === 0) return [];
    return this.invalidate(toInvalidate);
  }

  /**
   * Link a child invocation to its parent record's childInvocationIds.
   */
  addChildInvocation(
    parentInvocationId: InvocationId,
    childInvocationId: InvocationId,
  ): void {
    const parent = this._records.get(parentInvocationId);
    if (parent) {
      parent.childInvocationIds.push(childInvocationId);
    }
  }

  /** Get a record by ID. */
  get(invocationId: InvocationId): ExecutionRecord | undefined {
    return this._records.get(invocationId);
  }

  /** All records with status 'active'. */
  activeRecords(): ExecutionRecord[] {
    return [...this._records.values()].filter((r) => r.status === 'active');
  }

  /** Completed records at a specific (parentWorkflowId, parentNodeId). */
  completedAt(
    parentWorkflowId: string,
    parentNodeId: string,
  ): ExecutionRecord[] {
    return [...this._records.values()].filter(
      (r) =>
        r.parentWorkflowId === parentWorkflowId &&
        r.parentNodeId === parentNodeId &&
        r.status === 'completed',
    );
  }

  /** All records with status 'invalidated'. */
  invalidatedRecords(): ExecutionRecord[] {
    return [...this._records.values()].filter(
      (r) => r.status === 'invalidated',
    );
  }

  /** Read-only view of all records. */
  allRecords(): ReadonlyMap<InvocationId, ExecutionRecord> {
    return this._records;
  }

  /** Serialize for snapshot. */
  toState(): ExecutionTreeState {
    return { records: [...this._records.values()] };
  }

  /** Restore from snapshot. */
  static fromState(state: ExecutionTreeState): ExecutionTree {
    const tree = new ExecutionTree();
    for (const record of state.records) {
      tree._records.set(record.invocationId, { ...record });
    }
    return tree;
  }
}
