package reflex

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

func serializerFixtureDir() string {
	_, file, _, _ := runtime.Caller(0)
	return filepath.Join(filepath.Dir(file), "..", "docs", "fixtures")
}

func readSerializerFixture(t *testing.T, name string) []byte {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(serializerFixtureDir(), name))
	if err != nil {
		t.Fatalf("read fixture %s: %v", name, err)
	}
	return data
}

func stubSerializerGuardFn(_ BlackboardReader) (bool, error) {
	return true, nil
}

// greetingWorkflow returns the programmatic equivalent of greeting.json.
func greetingWorkflow() *Workflow {
	return &Workflow{
		ID:    "greeting",
		Entry: "ASK_NAME",
		Nodes: map[string]*Node{
			"ASK_NAME": {ID: "ASK_NAME", Spec: NodeSpec{
				"prompt":    "Ask the user for their name",
				"outputKey": "userName",
			}},
			"GREET": {ID: "GREET", Description: "Generate a personalized greeting", Spec: NodeSpec{
				"prompt":    "Greet the user by name",
				"inputKey":  "userName",
				"outputKey": "greeting",
			}},
			"FAREWELL": {ID: "FAREWELL", Spec: NodeSpec{
				"prompt":    "Say goodbye",
				"outputKey": "farewell",
			}},
		},
		Edges: []Edge{
			{ID: "e-ask-greet", From: "ASK_NAME", To: "GREET", Event: "NEXT"},
			{ID: "e-greet-farewell", From: "GREET", To: "FAREWELL", Event: "NEXT"},
		},
	}
}

// definePartObjectWorkflow returns the programmatic equivalent of define-part-object.json.
func definePartObjectWorkflow() *Workflow {
	return &Workflow{
		ID:    "define-part-object",
		Entry: "PART_CLASSIFY",
		Nodes: map[string]*Node{
			"PART_CLASSIFY": {ID: "PART_CLASSIFY", Spec: NodeSpec{
				"writes": []any{map[string]any{"key": "partContext", "value": "Physical Object — Part"}},
			}},
			"PART_BASIC_DATA": {ID: "PART_BASIC_DATA", Spec: NodeSpec{
				"writes": []any{map[string]any{"key": "partConcept", "value": "Aluminum Housing"}},
			}},
			"PART_DONE": {ID: "PART_DONE", Spec: NodeSpec{
				"complete": true,
				"writes":   []any{map[string]any{"key": "partStatus", "value": "complete"}},
			}},
		},
		Edges: []Edge{
			{ID: "e-part-classify-basic", From: "PART_CLASSIFY", To: "PART_BASIC_DATA", Event: "NEXT"},
			{ID: "e-part-basic-done", From: "PART_BASIC_DATA", To: "PART_DONE", Event: "NEXT"},
		},
	}
}

// definePhysicalObjectWorkflow returns the programmatic equivalent of define-physical-object.json.
func definePhysicalObjectWorkflow() *Workflow {
	return &Workflow{
		ID:    "define-physical-object",
		Entry: "CLASSIFY",
		Nodes: map[string]*Node{
			"CLASSIFY": {ID: "CLASSIFY", Spec: NodeSpec{
				"writes": []any{map[string]any{"key": "workflowType", "value": "define-physical-object"}},
				"edge":   "e-classify-basic",
			}},
			"BASIC_DATA": {ID: "BASIC_DATA", Spec: NodeSpec{
				"writes": []any{
					map[string]any{"key": "conceptName", "value": "Steel Pipe"},
					map[string]any{"key": "needsPart", "value": true},
				},
				"edge": "e-basic-branch",
			}},
			"BRANCH": {ID: "BRANCH", Spec: NodeSpec{
				"edge": []any{"e-branch-to-part", "e-branch-to-spec"},
			}},
			"DEFINE_PART": {ID: "DEFINE_PART", Spec: NodeSpec{}, Invokes: &InvocationSpec{
				WorkflowID: "define-part-object",
				ReturnMap:  []ReturnMapping{{ParentKey: "Part Concept", ChildKey: "partConcept"}},
			}},
			"SPEC_COMPOSE": {ID: "SPEC_COMPOSE", Spec: NodeSpec{
				"writes": []any{map[string]any{"key": "specRelation", "value": "Steel Pipe specializes Physical Object"}},
			}},
			"DONE": {ID: "DONE", Spec: NodeSpec{
				"complete": true,
				"writes":   []any{map[string]any{"key": "status", "value": "physical-object-defined"}},
			}},
		},
		Edges: []Edge{
			{ID: "e-classify-basic", From: "CLASSIFY", To: "BASIC_DATA", Event: "NEXT"},
			{ID: "e-basic-branch", From: "BASIC_DATA", To: "BRANCH", Event: "NEXT"},
			{ID: "e-branch-to-part", From: "BRANCH", To: "DEFINE_PART", Event: "DEFINE_PART",
				Guard: &BuiltinGuard{Type: GuardExists, Key: "needsPart"}},
			{ID: "e-branch-to-spec", From: "BRANCH", To: "SPEC_COMPOSE", Event: "SPEC_COMPOSE",
				Guard: &BuiltinGuard{Type: GuardNotExists, Key: "needsPart"}},
			{ID: "e-part-to-spec", From: "DEFINE_PART", To: "SPEC_COMPOSE", Event: "NEXT"},
			{ID: "e-spec-done", From: "SPEC_COMPOSE", To: "DONE", Event: "NEXT"},
		},
	}
}

// ---------------------------------------------------------------------------
// Basic serialization
// ---------------------------------------------------------------------------

func TestSerializeWorkflow_Greeting(t *testing.T) {
	wf := greetingWorkflow()
	data, err := SerializeWorkflow(wf, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	var parsed map[string]any
	if err := json.Unmarshal(data, &parsed); err != nil {
		t.Fatalf("invalid JSON output: %v", err)
	}
	if parsed["id"] != "greeting" {
		t.Errorf("id = %v", parsed["id"])
	}
	if parsed["entry"] != "ASK_NAME" {
		t.Errorf("entry = %v", parsed["entry"])
	}
	nodes := parsed["nodes"].(map[string]any)
	if len(nodes) != 3 {
		t.Errorf("nodes = %d, want 3", len(nodes))
	}
	edges := parsed["edges"].([]any)
	if len(edges) != 2 {
		t.Errorf("edges = %d, want 2", len(edges))
	}
}

func TestSerializeWorkflow_BuiltinGuards(t *testing.T) {
	wf := definePhysicalObjectWorkflow()
	data, err := SerializeWorkflow(wf, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	var parsed map[string]any
	if err := json.Unmarshal(data, &parsed); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}

	edges := parsed["edges"].([]any)
	for _, e := range edges {
		edge := e.(map[string]any)
		switch edge["id"] {
		case "e-branch-to-part":
			g := edge["guard"].(map[string]any)
			if g["type"] != "exists" || g["key"] != "needsPart" {
				t.Errorf("e-branch-to-part guard = %v", g)
			}
		case "e-branch-to-spec":
			g := edge["guard"].(map[string]any)
			if g["type"] != "not-exists" || g["key"] != "needsPart" {
				t.Errorf("e-branch-to-spec guard = %v", g)
			}
		}
	}
}

func TestSerializeWorkflow_EqualsGuardWithValue(t *testing.T) {
	wf := &Workflow{
		ID:    "test",
		Entry: "A",
		Nodes: map[string]*Node{
			"A": {ID: "A", Spec: NodeSpec{}},
			"B": {ID: "B", Spec: NodeSpec{}},
		},
		Edges: []Edge{
			{ID: "e1", From: "A", To: "B", Event: "NEXT",
				Guard: &BuiltinGuard{Type: GuardEquals, Key: "mode", Value: "fast"}},
		},
	}
	data, err := SerializeWorkflow(wf, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	var parsed map[string]any
	if err := json.Unmarshal(data, &parsed); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	edges := parsed["edges"].([]any)
	g := edges[0].(map[string]any)["guard"].(map[string]any)
	if g["type"] != "equals" || g["key"] != "mode" || g["value"] != "fast" {
		t.Errorf("guard = %v", g)
	}
}

func TestSerializeWorkflow_OmitsNilGuard(t *testing.T) {
	wf := greetingWorkflow()
	data, err := SerializeWorkflow(wf, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	var parsed map[string]any
	if err := json.Unmarshal(data, &parsed); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	edges := parsed["edges"].([]any)
	for _, e := range edges {
		edge := e.(map[string]any)
		if _, has := edge["guard"]; has {
			t.Errorf("edge %s should not have guard field", edge["id"])
		}
	}
}

func TestSerializeWorkflow_InvocationSpec(t *testing.T) {
	wf := definePhysicalObjectWorkflow()
	data, err := SerializeWorkflow(wf, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	var parsed map[string]any
	if err := json.Unmarshal(data, &parsed); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	nodes := parsed["nodes"].(map[string]any)
	dp := nodes["DEFINE_PART"].(map[string]any)
	inv := dp["invokes"].(map[string]any)
	if inv["workflowId"] != "define-part-object" {
		t.Errorf("workflowId = %v", inv["workflowId"])
	}
	rm := inv["returnMap"].([]any)
	if len(rm) != 1 {
		t.Fatalf("returnMap len = %d", len(rm))
	}
	entry := rm[0].(map[string]any)
	if entry["parentKey"] != "Part Concept" || entry["childKey"] != "partConcept" {
		t.Errorf("returnMap[0] = %v", entry)
	}
}

func TestSerializeWorkflow_NodeDescription(t *testing.T) {
	wf := greetingWorkflow()
	data, err := SerializeWorkflow(wf, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	var parsed map[string]any
	if err := json.Unmarshal(data, &parsed); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	nodes := parsed["nodes"].(map[string]any)
	greet := nodes["GREET"].(map[string]any)
	if greet["description"] != "Generate a personalized greeting" {
		t.Errorf("description = %v", greet["description"])
	}
	askName := nodes["ASK_NAME"].(map[string]any)
	if _, has := askName["description"]; has {
		t.Error("ASK_NAME should not have description")
	}
}

// ---------------------------------------------------------------------------
// Custom guard serialization
// ---------------------------------------------------------------------------

func TestSerializeWorkflow_CustomGuard(t *testing.T) {
	guard := &CustomGuardFunc{Fn: stubSerializerGuardFn}
	wf := &Workflow{
		ID:    "test",
		Entry: "A",
		Nodes: map[string]*Node{
			"A": {ID: "A", Spec: NodeSpec{}},
			"B": {ID: "B", Spec: NodeSpec{}},
		},
		Edges: []Edge{
			{ID: "e1", From: "A", To: "B", Event: "NEXT", Guard: guard},
		},
	}
	data, err := SerializeWorkflow(wf, &SerializeWorkflowOptions{
		GuardNames: GuardNameMap{guard: "myGuard"},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	var parsed map[string]any
	if err := json.Unmarshal(data, &parsed); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	edges := parsed["edges"].([]any)
	g := edges[0].(map[string]any)["guard"].(map[string]any)
	if g["type"] != "custom" || g["name"] != "myGuard" {
		t.Errorf("guard = %v", g)
	}
}

func TestSerializeWorkflow_CustomGuardMissing_ReturnsError(t *testing.T) {
	guard := &CustomGuardFunc{Fn: stubSerializerGuardFn}
	wf := &Workflow{
		ID:    "test",
		Entry: "A",
		Nodes: map[string]*Node{
			"A": {ID: "A", Spec: NodeSpec{}},
			"B": {ID: "B", Spec: NodeSpec{}},
		},
		Edges: []Edge{
			{ID: "e1", From: "A", To: "B", Event: "NEXT", Guard: guard},
		},
	}
	_, err := SerializeWorkflow(wf, nil)
	assertValidationError(t, err, ErrSchemaViolation)
}

// ---------------------------------------------------------------------------
// Round-trip: programmatic → serialize → load → structural equality
// ---------------------------------------------------------------------------

func TestRoundTrip_Greeting(t *testing.T) {
	wf := greetingWorkflow()
	data, err := SerializeWorkflow(wf, nil)
	if err != nil {
		t.Fatalf("serialize: %v", err)
	}
	loaded, err := LoadWorkflow(data, nil)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	assertWorkflowStructEqual(t, loaded, wf)
}

func TestRoundTrip_DefinePartObject(t *testing.T) {
	wf := definePartObjectWorkflow()
	data, err := SerializeWorkflow(wf, nil)
	if err != nil {
		t.Fatalf("serialize: %v", err)
	}
	loaded, err := LoadWorkflow(data, nil)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	assertWorkflowStructEqual(t, loaded, wf)
}

func TestRoundTrip_DefinePhysicalObject(t *testing.T) {
	wf := definePhysicalObjectWorkflow()
	data, err := SerializeWorkflow(wf, nil)
	if err != nil {
		t.Fatalf("serialize: %v", err)
	}
	loaded, err := LoadWorkflow(data, nil)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	assertWorkflowStructEqual(t, loaded, wf)
}

func TestRoundTrip_CustomGuard_ViaGuardNameMap(t *testing.T) {
	guard := &CustomGuardFunc{Fn: stubSerializerGuardFn}
	wf := &Workflow{
		ID:    "test",
		Entry: "A",
		Nodes: map[string]*Node{
			"A": {ID: "A", Spec: NodeSpec{}},
			"B": {ID: "B", Spec: NodeSpec{}},
		},
		Edges: []Edge{
			{ID: "e1", From: "A", To: "B", Event: "NEXT", Guard: guard},
		},
	}

	data, err := SerializeWorkflow(wf, &SerializeWorkflowOptions{
		GuardNames: GuardNameMap{guard: "myGuard"},
	})
	if err != nil {
		t.Fatalf("serialize: %v", err)
	}

	loaded, err := LoadWorkflow(data, &LoadWorkflowOptions{
		Guards: GuardRegistry{"myGuard": guard},
	})
	if err != nil {
		t.Fatalf("load: %v", err)
	}

	if loaded.Edges[0].Guard != guard {
		t.Error("custom guard not resolved to same instance")
	}
}

func TestRoundTrip_PassesRegistryValidation(t *testing.T) {
	wf := greetingWorkflow()
	data, err := SerializeWorkflow(wf, nil)
	if err != nil {
		t.Fatalf("serialize: %v", err)
	}
	loaded, err := LoadWorkflow(data, nil)
	if err != nil {
		t.Fatalf("load: %v", err)
	}

	reg := NewRegistry()
	if err := reg.Register(loaded); err != nil {
		t.Fatalf("register: %v", err)
	}
}

func TestRoundTrip_AllProgrammaticWorkflows_Loadable(t *testing.T) {
	workflows := []*Workflow{
		greetingWorkflow(),
		definePartObjectWorkflow(),
		definePhysicalObjectWorkflow(),
	}
	for _, wf := range workflows {
		data, err := SerializeWorkflow(wf, nil)
		if err != nil {
			t.Fatalf("serialize %s: %v", wf.ID, err)
		}
		_, err = LoadWorkflow(data, nil)
		if err != nil {
			t.Fatalf("load %s: %v", wf.ID, err)
		}
	}
}

// ---------------------------------------------------------------------------
// Fixture parity: programmatic workflows match fixture-loaded
// ---------------------------------------------------------------------------

func TestFixtureParity_Greeting(t *testing.T) {
	fromFixture, err := LoadWorkflow(readSerializerFixture(t, "greeting.json"), nil)
	if err != nil {
		t.Fatalf("load fixture: %v", err)
	}
	assertWorkflowStructEqual(t, greetingWorkflow(), fromFixture)
}

func TestFixtureParity_DefinePartObject(t *testing.T) {
	fromFixture, err := LoadWorkflow(readSerializerFixture(t, "define-part-object.json"), nil)
	if err != nil {
		t.Fatalf("load fixture: %v", err)
	}
	assertWorkflowStructEqual(t, definePartObjectWorkflow(), fromFixture)
}

func TestFixtureParity_DefinePhysicalObject(t *testing.T) {
	fromFixture, err := LoadWorkflow(readSerializerFixture(t, "define-physical-object.json"), nil)
	if err != nil {
		t.Fatalf("load fixture: %v", err)
	}
	assertWorkflowStructEqual(t, definePhysicalObjectWorkflow(), fromFixture)
}

func TestFixtureParity_RoundTripped_Greeting(t *testing.T) {
	wf := greetingWorkflow()
	data, err := SerializeWorkflow(wf, nil)
	if err != nil {
		t.Fatalf("serialize: %v", err)
	}
	roundTripped, err := LoadWorkflow(data, nil)
	if err != nil {
		t.Fatalf("load round-tripped: %v", err)
	}
	fromFixture, err := LoadWorkflow(readSerializerFixture(t, "greeting.json"), nil)
	if err != nil {
		t.Fatalf("load fixture: %v", err)
	}
	assertWorkflowStructEqual(t, roundTripped, fromFixture)
}

func TestFixtureParity_RoundTripped_DefinePhysicalObject(t *testing.T) {
	wf := definePhysicalObjectWorkflow()
	data, err := SerializeWorkflow(wf, nil)
	if err != nil {
		t.Fatalf("serialize: %v", err)
	}
	roundTripped, err := LoadWorkflow(data, nil)
	if err != nil {
		t.Fatalf("load round-tripped: %v", err)
	}
	fromFixture, err := LoadWorkflow(readSerializerFixture(t, "define-physical-object.json"), nil)
	if err != nil {
		t.Fatalf("load fixture: %v", err)
	}
	assertWorkflowStructEqual(t, roundTripped, fromFixture)
}

// ---------------------------------------------------------------------------
// Structural equality helper
// ---------------------------------------------------------------------------

func assertWorkflowStructEqual(t *testing.T, actual, expected *Workflow) {
	t.Helper()
	if actual.ID != expected.ID {
		t.Errorf("id: %q != %q", actual.ID, expected.ID)
	}
	if actual.Entry != expected.Entry {
		t.Errorf("entry: %q != %q", actual.Entry, expected.Entry)
	}
	if len(actual.Nodes) != len(expected.Nodes) {
		t.Fatalf("nodes: %d != %d", len(actual.Nodes), len(expected.Nodes))
	}
	for key, aNode := range actual.Nodes {
		eNode, ok := expected.Nodes[key]
		if !ok {
			t.Errorf("node %s: not in expected", key)
			continue
		}
		if aNode.ID != eNode.ID {
			t.Errorf("node %s id: %q != %q", key, aNode.ID, eNode.ID)
		}
		if aNode.Description != eNode.Description {
			t.Errorf("node %s description: %q != %q", key, aNode.Description, eNode.Description)
		}
		// Compare invokes
		if eNode.Invokes != nil {
			if aNode.Invokes == nil {
				t.Errorf("node %s: expected invokes, got nil", key)
			} else {
				if aNode.Invokes.WorkflowID != eNode.Invokes.WorkflowID {
					t.Errorf("node %s invokes.workflowId: %q != %q", key, aNode.Invokes.WorkflowID, eNode.Invokes.WorkflowID)
				}
				if len(aNode.Invokes.ReturnMap) != len(eNode.Invokes.ReturnMap) {
					t.Errorf("node %s invokes.returnMap len: %d != %d", key, len(aNode.Invokes.ReturnMap), len(eNode.Invokes.ReturnMap))
				} else {
					for i, arm := range aNode.Invokes.ReturnMap {
						erm := eNode.Invokes.ReturnMap[i]
						if arm.ParentKey != erm.ParentKey || arm.ChildKey != erm.ChildKey {
							t.Errorf("node %s returnMap[%d]: {%q,%q} != {%q,%q}", key, i, arm.ParentKey, arm.ChildKey, erm.ParentKey, erm.ChildKey)
						}
					}
				}
			}
		} else if aNode.Invokes != nil {
			t.Errorf("node %s: unexpected invokes", key)
		}
	}
	if len(actual.Edges) != len(expected.Edges) {
		t.Fatalf("edges: %d != %d", len(actual.Edges), len(expected.Edges))
	}
	for i, aEdge := range actual.Edges {
		eEdge := expected.Edges[i]
		if aEdge.ID != eEdge.ID {
			t.Errorf("edge[%d] id: %q != %q", i, aEdge.ID, eEdge.ID)
		}
		if aEdge.From != eEdge.From {
			t.Errorf("edge %s from: %q != %q", aEdge.ID, aEdge.From, eEdge.From)
		}
		if aEdge.To != eEdge.To {
			t.Errorf("edge %s to: %q != %q", aEdge.ID, aEdge.To, eEdge.To)
		}
		if aEdge.Event != eEdge.Event {
			t.Errorf("edge %s event: %q != %q", aEdge.ID, aEdge.Event, eEdge.Event)
		}
		// Compare guards
		if eEdge.Guard == nil {
			if aEdge.Guard != nil {
				t.Errorf("edge %s: expected no guard", aEdge.ID)
			}
		} else if aEdge.Guard == nil {
			t.Errorf("edge %s: expected guard, got nil", aEdge.ID)
		} else {
			aBG, aOk := aEdge.Guard.(*BuiltinGuard)
			eBG, eOk := eEdge.Guard.(*BuiltinGuard)
			if aOk && eOk {
				if aBG.Type != eBG.Type || aBG.Key != eBG.Key {
					t.Errorf("edge %s guard: {%s,%s} != {%s,%s}", aEdge.ID, aBG.Type, aBG.Key, eBG.Type, eBG.Key)
				}
			}
		}
	}
}
