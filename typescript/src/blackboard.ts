// Reflex — Scoped Blackboard
// Implements DESIGN.md Sections 2.7 and 2.11

import {
  BlackboardEntry,
  BlackboardReader,
  BlackboardSource,
  BlackboardWrite,
  Cursor,
  CursorReader,
} from './types.js';

// ---------------------------------------------------------------------------
// Scoped Blackboard Reader
// ---------------------------------------------------------------------------

/**
 * Read-only view over a chain of blackboard scopes with lexical precedence.
 *
 * Scopes are ordered local → parent → grandparent (index 0 = innermost).
 * Within each scope, entries are in chronological order (oldest first,
 * newest last) — append-only semantics mean the last entry for a key wins.
 */
export class ScopedBlackboardReader implements BlackboardReader {
  private readonly scopes: ReadonlyArray<readonly BlackboardEntry[]>;

  constructor(scopes: BlackboardEntry[][] = []) {
    this.scopes = scopes;
  }

  /**
   * Walk scopes local → parent → grandparent.
   * Return the value of the latest entry for `key` in the first scope that
   * contains it, or undefined if not found in any scope.
   */
  get(key: string): unknown | undefined {
    for (const scope of this.scopes) {
      // Walk backwards to find the latest entry for this key in the scope
      for (let i = scope.length - 1; i >= 0; i--) {
        if (scope[i].key === key) {
          return scope[i].value;
        }
      }
    }
    return undefined;
  }

  /**
   * Return true if `key` exists in any scope.
   */
  has(key: string): boolean {
    for (const scope of this.scopes) {
      for (const entry of scope) {
        if (entry.key === key) return true;
      }
    }
    return false;
  }

  /**
   * Collect all entries for `key` across all scopes, ordered most-local first.
   * Includes shadowed entries — entries from parent/grandparent scopes that
   * would be hidden by local entries in a `get()` call.
   *
   * Within each scope, entries preserve their chronological order.
   */
  getAll(key: string): BlackboardEntry[] {
    const result: BlackboardEntry[] = [];
    for (const scope of this.scopes) {
      for (const entry of scope) {
        if (entry.key === key) {
          result.push(entry);
        }
      }
    }
    return result;
  }

  /**
   * All entries across all scopes, local scope first.
   */
  entries(): BlackboardEntry[] {
    const result: BlackboardEntry[] = [];
    for (const scope of this.scopes) {
      for (const entry of scope) {
        result.push(entry);
      }
    }
    return result;
  }

  /**
   * All unique keys across all scopes.
   */
  keys(): string[] {
    const seen = new Set<string>();
    for (const scope of this.scopes) {
      for (const entry of scope) {
        seen.add(entry.key);
      }
    }
    return Array.from(seen);
  }

  /**
   * Only the innermost scope's entries.
   */
  local(): BlackboardEntry[] {
    if (this.scopes.length === 0) return [];
    return [...this.scopes[0]];
  }
}

// ---------------------------------------------------------------------------
// Scoped Blackboard (write side)
// ---------------------------------------------------------------------------

/**
 * Append-only blackboard for a single scope (one workflow on the stack).
 *
 * Owns a mutable `BlackboardEntry[]` that grows via `append()`. No entries
 * are ever deleted or mutated — the only mutation path is appending new ones.
 *
 * Use `reader()` to construct a `ScopedBlackboardReader` that includes this
 * scope's entries plus any ancestor scopes from the call stack.
 */
export class ScopedBlackboard implements CursorReader {
  private readonly entries: BlackboardEntry[] = [];

  constructor(entries?: BlackboardEntry[]) {
    if (entries) {
      this.entries.push(...entries);
    }
  }

  /**
   * Convert writes to full entries and append them to this scope.
   *
   * All entries in a single call share the same source and timestamp
   * (they originate from one decision).
   *
   * Returns the newly created entries (useful for event emission).
   */
  append(writes: BlackboardWrite[], source: BlackboardSource): BlackboardEntry[] {
    const timestamp = Date.now();
    const newEntries: BlackboardEntry[] = writes.map((w) => ({
      key: w.key,
      value: w.value,
      source,
      timestamp,
    }));
    this.entries.push(...newEntries);
    return newEntries;
  }

  /**
   * Read-only snapshot of this scope's entries.
   */
  getEntries(): readonly BlackboardEntry[] {
    return [...this.entries];
  }

  /**
   * Returns the current end position of the entry log.
   * Pass the returned cursor to entriesFrom() after subsequent append() calls
   * to retrieve only the new entries.
   */
  cursor(): Cursor {
    return this.entries.length;
  }

  /**
   * Returns entries appended at or after position c, plus the cursor for the
   * new end position. Enables efficient incremental reads for streaming
   * persistence (e.g., NDJSON logging).
   *
   * If c is negative, treats it as 0 (returns all entries).
   * If c is at or past the end, returns [] and the current end position.
   */
  entriesFrom(c: Cursor): [BlackboardEntry[], Cursor] {
    const end = this.entries.length;
    const start = c < 0 ? 0 : c;
    if (start >= end) {
      return [[], end];
    }
    return [this.entries.slice(start, end), end];
  }

  /**
   * Construct a `ScopedBlackboardReader` with this scope as the local
   * (innermost) scope, plus any ancestor scopes from the call stack.
   */
  reader(parentScopes: BlackboardEntry[][] = []): ScopedBlackboardReader {
    return new ScopedBlackboardReader([this.entries, ...parentScopes]);
  }
}
