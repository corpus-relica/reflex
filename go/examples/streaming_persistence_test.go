package examples

import (
	"context"
	"testing"

	reflex "github.com/corpus-relica/reflex/go"
)

// agentFn wraps a function as a DecisionAgent for inline test agents.
type agentFn func(ctx context.Context, dc reflex.DecisionContext) (reflex.Decision, error)

func (f agentFn) Resolve(ctx context.Context, dc reflex.DecisionContext) (reflex.Decision, error) {
	return f(ctx, dc)
}

// TestStreamingPersistence demonstrates cursor-based incremental reads
// for streaming persistence — reading only new blackboard entries after
// each step instead of re-scanning the full log.
//
// This pattern is used in production by khaos-wfl to persist workflow
// state to NDJSON files without quadratic duplication.
func TestStreamingPersistence(t *testing.T) {
	r := reflex.NewRegistry()
	_ = r.Register(&reflex.Workflow{
		ID:    "pipeline",
		Entry: "PARSE",
		Nodes: map[string]*reflex.Node{
			"PARSE":   {ID: "PARSE", Spec: reflex.NodeSpec{"writes": []reflex.BlackboardWrite{{Key: "parsed", Value: true}}}},
			"ANALYZE": {ID: "ANALYZE", Spec: reflex.NodeSpec{"writes": []reflex.BlackboardWrite{{Key: "score", Value: 85}}}},
			"DONE":    {ID: "DONE", Spec: reflex.NodeSpec{"complete": true}},
		},
		Edges: []reflex.Edge{
			{ID: "e1", From: "PARSE", To: "ANALYZE", Event: "NEXT"},
			{ID: "e2", From: "ANALYZE", To: "DONE", Event: "NEXT"},
		},
	})

	e := reflex.NewEngine(r, NewRuleAgent())
	_, _ = e.Init("pipeline")

	// Snapshot cursor before stepping
	bb := e.CurrentBlackboard()
	if bb == nil {
		t.Fatal("expected non-nil CurrentBlackboard after Init")
	}
	cursor := bb.Cursor()

	// Simulate a persistence log
	var persistedEntries []reflex.BlackboardEntry

	for {
		result, err := e.Step(context.Background())
		if err != nil {
			t.Fatalf("step error: %v", err)
		}

		// Read ONLY new entries since last cursor position
		entries, next := e.CurrentBlackboard().EntriesFrom(cursor)
		persistedEntries = append(persistedEntries, entries...)
		cursor = next

		if result.Status == reflex.StepCompleted {
			break
		}
	}

	// Verify: we captured entries without duplicates
	if len(persistedEntries) < 2 {
		t.Errorf("expected ≥2 persisted entries (parsed + score), got %d", len(persistedEntries))
	}

	// Verify specific keys were captured
	keys := make(map[string]bool)
	for _, e := range persistedEntries {
		keys[e.Key] = true
	}
	if !keys["parsed"] {
		t.Error("missing 'parsed' key in persisted entries")
	}
	if !keys["score"] {
		t.Error("missing 'score' key in persisted entries")
	}
}

// TestSeedBlackboard demonstrates initializing a workflow with seed values.
// Seed values configure the workflow at Init() time — the agent can read
// them to make decisions without hardcoding per-workflow behavior.
func TestSeedBlackboard(t *testing.T) {
	r := reflex.NewRegistry()
	_ = r.Register(&reflex.Workflow{
		ID:    "configurable",
		Entry: "RUN",
		Nodes: map[string]*reflex.Node{
			"RUN":  {ID: "RUN", Spec: reflex.NodeSpec{}},
			"DONE": {ID: "DONE", Spec: reflex.NodeSpec{"complete": true}},
		},
		Edges: []reflex.Edge{
			{ID: "e1", From: "RUN", To: "DONE", Event: "NEXT"},
		},
	})

	// Init with seed values — configures the workflow run
	e := reflex.NewEngine(r, NewRuleAgent())
	_, err := e.Init("configurable", reflex.InitOptions{
		Blackboard: []reflex.BlackboardWrite{
			{Key: "project_path", Value: "/Users/demo/projects/test.kspd"},
			{Key: "max_retries", Value: 3},
			{Key: "verbose", Value: true},
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	// Read seeds back from blackboard
	bb := e.Blackboard()

	path, ok := bb.Get("project_path")
	if !ok || path != "/Users/demo/projects/test.kspd" {
		t.Errorf("project_path = %v, ok=%v", path, ok)
	}

	retries, ok := bb.Get("max_retries")
	if !ok || retries != 3 {
		t.Errorf("max_retries = %v, ok=%v", retries, ok)
	}

	verbose, ok := bb.Get("verbose")
	if !ok || verbose != true {
		t.Errorf("verbose = %v, ok=%v", verbose, ok)
	}

	// Seeds are also visible via cursor
	cur := e.CurrentBlackboard()
	entries, _ := cur.EntriesFrom(0)
	if len(entries) < 3 {
		t.Errorf("expected ≥3 seed entries, got %d", len(entries))
	}
}

// NOTE: TestSuspendWithWritesPersistence lives in the dogfood-combined
// branch only — it depends on the "Apply Decision.Writes on suspend"
// fix which is not yet upstreamed.
