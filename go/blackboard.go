package reflex

import (
	"sync"
	"time"
)

// ---------------------------------------------------------------------------
// ScopedBlackboardReader — read side (DESIGN.md Section 2.11)
// ---------------------------------------------------------------------------

// scopedBlackboardReader provides read-only access over a chain of blackboard
// scopes with lexical precedence. Scopes are ordered local → parent →
// grandparent (index 0 = innermost). Within each scope, entries are in
// chronological order (oldest first, newest last).
type scopedBlackboardReader struct {
	scopes [][]BlackboardEntry
}

// NewBlackboardReader creates a BlackboardReader over the given scope chain.
// scopes[0] is the local (innermost) scope.
func NewBlackboardReader(scopes [][]BlackboardEntry) BlackboardReader {
	if scopes == nil {
		scopes = [][]BlackboardEntry{}
	}
	return &scopedBlackboardReader{scopes: scopes}
}

// Get walks scopes local → parent → grandparent. Returns the value of the
// latest entry for key in the first scope that contains it.
func (r *scopedBlackboardReader) Get(key string) (any, bool) {
	for _, scope := range r.scopes {
		for i := len(scope) - 1; i >= 0; i-- {
			if scope[i].Key == key {
				return scope[i].Value, true
			}
		}
	}
	return nil, false
}

// Has returns true if key exists in any scope.
func (r *scopedBlackboardReader) Has(key string) bool {
	for _, scope := range r.scopes {
		for _, e := range scope {
			if e.Key == key {
				return true
			}
		}
	}
	return false
}

// GetAll returns all entries for key across all scopes, local-first.
// Includes shadowed entries from parent/grandparent scopes.
func (r *scopedBlackboardReader) GetAll(key string) []BlackboardEntry {
	var result []BlackboardEntry
	for _, scope := range r.scopes {
		for _, e := range scope {
			if e.Key == key {
				result = append(result, e)
			}
		}
	}
	return result
}

// Entries returns all entries across all scopes, local scope first.
func (r *scopedBlackboardReader) Entries() []BlackboardEntry {
	var result []BlackboardEntry
	for _, scope := range r.scopes {
		result = append(result, scope...)
	}
	return result
}

// Keys returns all unique keys across all scopes.
func (r *scopedBlackboardReader) Keys() []string {
	seen := make(map[string]struct{})
	var keys []string
	for _, scope := range r.scopes {
		for _, e := range scope {
			if _, exists := seen[e.Key]; !exists {
				seen[e.Key] = struct{}{}
				keys = append(keys, e.Key)
			}
		}
	}
	return keys
}

// Local returns only the innermost scope's entries.
func (r *scopedBlackboardReader) Local() []BlackboardEntry {
	if len(r.scopes) == 0 {
		return nil
	}
	result := make([]BlackboardEntry, len(r.scopes[0]))
	copy(result, r.scopes[0])
	return result
}

// ---------------------------------------------------------------------------
// ScopedBlackboard — write side (DESIGN.md Section 2.7)
// ---------------------------------------------------------------------------

// ScopedBlackboard is the append-only blackboard for a single workflow scope.
// It owns a mutable slice of entries that grows via Append(). No entries are
// ever deleted or mutated.
type ScopedBlackboard struct {
	mu      sync.RWMutex
	entries []BlackboardEntry
}

// NewBlackboard creates a new ScopedBlackboard, optionally seeded with entries.
func NewBlackboard(entries ...BlackboardEntry) *ScopedBlackboard {
	bb := &ScopedBlackboard{}
	if len(entries) > 0 {
		bb.entries = make([]BlackboardEntry, len(entries))
		copy(bb.entries, entries)
	}
	return bb
}

// Append converts writes to full entries and appends them to this scope.
// All entries in a single call share the same source and timestamp.
// Returns the newly created entries.
func (bb *ScopedBlackboard) Append(writes []BlackboardWrite, source BlackboardSource) []BlackboardEntry {
	now := time.Now().UnixMilli()
	newEntries := make([]BlackboardEntry, len(writes))
	for i, w := range writes {
		newEntries[i] = BlackboardEntry{
			Key:       w.Key,
			Value:     w.Value,
			Source:    source,
			Timestamp: now,
		}
	}
	bb.mu.Lock()
	bb.entries = append(bb.entries, newEntries...)
	bb.mu.Unlock()
	return newEntries
}

// CursorReader provides read-only access to a blackboard's incremental
// entry log. Use Cursor() to snapshot the current position, then
// EntriesFrom() after subsequent steps to retrieve only new entries.
// This is the public interface returned by Engine.CurrentBlackboard().
type CursorReader interface {
	// Cursor returns the current end position of the entry log.
	Cursor() Cursor
	// EntriesFrom returns entries appended at or after position c,
	// plus the cursor for the new end position.
	EntriesFrom(c Cursor) ([]BlackboardEntry, Cursor)
}

// Cursor represents a position in the blackboard entry log.
// Use with EntriesFrom to read only entries appended after this position.
// Cursor values are only valid for the ScopedBlackboard that produced them.
type Cursor int

// Cursor returns the current end position of this blackboard.
// Pass the returned cursor to EntriesFrom after subsequent Append calls
// to retrieve only the new entries.
func (bb *ScopedBlackboard) Cursor() Cursor {
	bb.mu.RLock()
	defer bb.mu.RUnlock()
	return Cursor(len(bb.entries))
}

// EntriesFrom returns entries appended at or after position c,
// plus the cursor for the new end position. This enables efficient
// incremental reads for streaming persistence (e.g., NDJSON logging).
//
// If c is negative, it is treated as 0 (returns all entries).
// If c is at or past the end, returns nil and the current end position.
func (bb *ScopedBlackboard) EntriesFrom(c Cursor) ([]BlackboardEntry, Cursor) {
	bb.mu.RLock()
	defer bb.mu.RUnlock()

	end := Cursor(len(bb.entries))
	if c < 0 {
		c = 0
	}
	if c >= end {
		return nil, end
	}

	out := make([]BlackboardEntry, end-c)
	copy(out, bb.entries[c:end])
	return out, end
}

// Entries returns a copy of this scope's entries.
func (bb *ScopedBlackboard) Entries() []BlackboardEntry {
	bb.mu.RLock()
	defer bb.mu.RUnlock()
	result := make([]BlackboardEntry, len(bb.entries))
	copy(result, bb.entries)
	return result
}

// Reader constructs a BlackboardReader with this scope as the local (innermost)
// scope, plus any ancestor scopes from the call stack.
func (bb *ScopedBlackboard) Reader(parentScopes ...[]BlackboardEntry) BlackboardReader {
	bb.mu.RLock()
	local := make([]BlackboardEntry, len(bb.entries))
	copy(local, bb.entries)
	bb.mu.RUnlock()
	scopes := make([][]BlackboardEntry, 0, 1+len(parentScopes))
	scopes = append(scopes, local)
	scopes = append(scopes, parentScopes...)
	return NewBlackboardReader(scopes)
}
