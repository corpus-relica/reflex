package examples

import (
	"context"
	"testing"

	reflex "github.com/corpus-relica/reflex/go"
)

// suspendAgent wraps a function as a DecisionAgent.
type suspendAgent func(ctx context.Context, dc reflex.DecisionContext) (reflex.Decision, error)

func (f suspendAgent) Resolve(ctx context.Context, dc reflex.DecisionContext) (reflex.Decision, error) {
	return f(ctx, dc)
}

// TestSuspendWithWrites demonstrates that an agent can persist partial
// progress on the blackboard when suspending.
//
// Use case: a batch analysis workflow processes 50 items. After item 25,
// it needs to wait for an external API rate limit. The agent suspends
// with writes recording the progress — so after resume, it knows where
// to pick up.
func TestSuspendWithWrites(t *testing.T) {
	r := reflex.NewRegistry()
	_ = r.Register(&reflex.Workflow{
		ID:    "batch",
		Entry: "PROCESS",
		Nodes: map[string]*reflex.Node{
			"PROCESS": {ID: "PROCESS", Spec: reflex.NodeSpec{}},
			"DONE":    {ID: "DONE", Spec: reflex.NodeSpec{"complete": true}},
		},
		Edges: []reflex.Edge{
			{ID: "e1", From: "PROCESS", To: "DONE", Event: "NEXT"},
		},
	})

	callCount := 0
	agent := suspendAgent(func(_ context.Context, dc reflex.DecisionContext) (reflex.Decision, error) {
		callCount++
		if callCount == 1 {
			// First call: suspend with partial progress
			return reflex.Decision{
				Type:   reflex.DecisionSuspend,
				Reason: "rate limit",
				Writes: []reflex.BlackboardWrite{
					{Key: "items_processed", Value: 25},
					{Key: "last_item_id", Value: "item-025"},
				},
			}, nil
		}
		// Resume: finish and advance
		if len(dc.ValidEdges) > 0 {
			return reflex.Decision{Type: reflex.DecisionAdvance, Edge: dc.ValidEdges[0].ID}, nil
		}
		return reflex.Decision{Type: reflex.DecisionComplete}, nil
	})

	e := reflex.NewEngine(r, agent)
	_, _ = e.Init("batch")

	// Step 1: suspend with writes
	res, _ := e.Step(context.Background())
	if res.Status != reflex.StepSuspended {
		t.Fatalf("expected suspended, got %s", res.Status)
	}

	// Partial progress is visible on the blackboard
	bb := e.Blackboard()
	processed, ok := bb.Get("items_processed")
	if !ok || processed != 25 {
		t.Errorf("expected items_processed=25, got %v (ok=%v)", processed, ok)
	}
	lastID, ok := bb.Get("last_item_id")
	if !ok || lastID != "item-025" {
		t.Errorf("expected last_item_id='item-025', got %v", lastID)
	}

	// Step 2: resume and complete
	res, _ = e.Step(context.Background())
	if res.Status != reflex.StepAdvanced {
		t.Fatalf("expected advanced after resume, got %s", res.Status)
	}

	// Progress still visible after advancing
	if v, ok := bb.Get("items_processed"); !ok || v != 25 {
		t.Errorf("progress lost after resume: %v (ok=%v)", v, ok)
	}
}
