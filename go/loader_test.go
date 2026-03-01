package reflex

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

func fixtureDir() string {
	_, file, _, _ := runtime.Caller(0)
	return filepath.Join(filepath.Dir(file), "..", "docs", "fixtures")
}

func readFixture(t *testing.T, name string) []byte {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(fixtureDir(), name))
	if err != nil {
		t.Fatalf("read fixture %s: %v", name, err)
	}
	return data
}

func stubGuardFn(_ BlackboardReader) (bool, error) {
	return true, nil
}

// assertValidationError is defined in registry_test.go — reused here

// ---------------------------------------------------------------------------
// Valid inputs — fixtures
// ---------------------------------------------------------------------------

func TestLoadWorkflow_Greeting(t *testing.T) {
	wf, err := LoadWorkflow(readFixture(t, "greeting.json"), nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if wf.ID != "greeting" {
		t.Errorf("id = %q, want greeting", wf.ID)
	}
	if wf.Entry != "ASK_NAME" {
		t.Errorf("entry = %q, want ASK_NAME", wf.Entry)
	}
	if len(wf.Nodes) != 3 {
		t.Errorf("nodes = %d, want 3", len(wf.Nodes))
	}
	if len(wf.Edges) != 2 {
		t.Errorf("edges = %d, want 2", len(wf.Edges))
	}
	// No guards on any edge
	for _, e := range wf.Edges {
		if e.Guard != nil {
			t.Errorf("edge %s: expected no guard", e.ID)
		}
	}
}

func TestLoadWorkflow_DefinePhysicalObject(t *testing.T) {
	wf, err := LoadWorkflow(readFixture(t, "define-physical-object.json"), nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if wf.ID != "define-physical-object" {
		t.Errorf("id = %q", wf.ID)
	}
	if len(wf.Nodes) != 6 {
		t.Errorf("nodes = %d, want 6", len(wf.Nodes))
	}
	if len(wf.Edges) != 6 {
		t.Errorf("edges = %d, want 6", len(wf.Edges))
	}

	// Check exists guard on e-branch-to-part
	var branchToPart *Edge
	for i := range wf.Edges {
		if wf.Edges[i].ID == "e-branch-to-part" {
			branchToPart = &wf.Edges[i]
			break
		}
	}
	if branchToPart == nil {
		t.Fatal("edge e-branch-to-part not found")
	}
	bg, ok := branchToPart.Guard.(*BuiltinGuard)
	if !ok {
		t.Fatalf("guard is %T, want *BuiltinGuard", branchToPart.Guard)
	}
	if bg.Type != GuardExists || bg.Key != "needsPart" {
		t.Errorf("guard = {%s, %s}, want {exists, needsPart}", bg.Type, bg.Key)
	}

	// Check not-exists guard on e-branch-to-spec
	var branchToSpec *Edge
	for i := range wf.Edges {
		if wf.Edges[i].ID == "e-branch-to-spec" {
			branchToSpec = &wf.Edges[i]
			break
		}
	}
	if branchToSpec == nil {
		t.Fatal("edge e-branch-to-spec not found")
	}
	bg2, ok := branchToSpec.Guard.(*BuiltinGuard)
	if !ok {
		t.Fatalf("guard is %T, want *BuiltinGuard", branchToSpec.Guard)
	}
	if bg2.Type != GuardNotExists || bg2.Key != "needsPart" {
		t.Errorf("guard = {%s, %s}, want {not-exists, needsPart}", bg2.Type, bg2.Key)
	}
}

func TestLoadWorkflow_DefinePartObject(t *testing.T) {
	wf, err := LoadWorkflow(readFixture(t, "define-part-object.json"), nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if wf.ID != "define-part-object" {
		t.Errorf("id = %q", wf.ID)
	}
	if len(wf.Nodes) != 3 {
		t.Errorf("nodes = %d, want 3", len(wf.Nodes))
	}
	if len(wf.Edges) != 2 {
		t.Errorf("edges = %d, want 2", len(wf.Edges))
	}
}

func TestLoadWorkflow_InvocationSpec(t *testing.T) {
	wf, err := LoadWorkflow(readFixture(t, "define-physical-object.json"), nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	definePart := wf.Nodes["DEFINE_PART"]
	if definePart == nil {
		t.Fatal("node DEFINE_PART not found")
	}
	if definePart.Invokes == nil {
		t.Fatal("DEFINE_PART.Invokes is nil")
	}
	if definePart.Invokes.WorkflowID != "define-part-object" {
		t.Errorf("workflowId = %q", definePart.Invokes.WorkflowID)
	}
	if len(definePart.Invokes.ReturnMap) != 1 {
		t.Fatalf("returnMap len = %d, want 1", len(definePart.Invokes.ReturnMap))
	}
	rm := definePart.Invokes.ReturnMap[0]
	if rm.ParentKey != "Part Concept" || rm.ChildKey != "partConcept" {
		t.Errorf("returnMap[0] = {%q, %q}", rm.ParentKey, rm.ChildKey)
	}
}

func TestLoadWorkflow_NodeSpec(t *testing.T) {
	wf, err := LoadWorkflow(readFixture(t, "greeting.json"), nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	askName := wf.Nodes["ASK_NAME"]
	if askName == nil {
		t.Fatal("node ASK_NAME not found")
	}
	if askName.Spec["prompt"] != "Ask the user for their name" {
		t.Errorf("spec.prompt = %v", askName.Spec["prompt"])
	}
	if askName.Spec["outputKey"] != "userName" {
		t.Errorf("spec.outputKey = %v", askName.Spec["outputKey"])
	}
}

// ---------------------------------------------------------------------------
// Custom guard resolution
// ---------------------------------------------------------------------------

func TestLoadWorkflow_CustomGuardResolved(t *testing.T) {
	data := []byte(`{
		"id": "test",
		"entry": "A",
		"nodes": {
			"A": {"id": "A", "spec": {}},
			"B": {"id": "B", "spec": {}}
		},
		"edges": [{
			"id": "e1", "from": "A", "to": "B", "event": "NEXT",
			"guard": {"type": "custom", "name": "myGuard"}
		}]
	}`)

	guard := &CustomGuardFunc{Fn: stubGuardFn}
	wf, err := LoadWorkflow(data, &LoadWorkflowOptions{
		Guards: GuardRegistry{"myGuard": guard},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if wf.Edges[0].Guard != guard {
		t.Error("guard not resolved from registry")
	}
}

func TestLoadWorkflow_CustomGuardMissing(t *testing.T) {
	data := []byte(`{
		"id": "test",
		"entry": "A",
		"nodes": {
			"A": {"id": "A", "spec": {}},
			"B": {"id": "B", "spec": {}}
		},
		"edges": [{
			"id": "e1", "from": "A", "to": "B", "event": "NEXT",
			"guard": {"type": "custom", "name": "nonExistent"}
		}]
	}`)
	_, err := LoadWorkflow(data, nil)
	assertValidationError(t, err, ErrUnknownGuardReference)
}

func TestLoadWorkflow_CustomGuardMissingFromRegistry(t *testing.T) {
	data := []byte(`{
		"id": "test",
		"entry": "A",
		"nodes": {
			"A": {"id": "A", "spec": {}},
			"B": {"id": "B", "spec": {}}
		},
		"edges": [{
			"id": "e1", "from": "A", "to": "B", "event": "NEXT",
			"guard": {"type": "custom", "name": "missing"}
		}]
	}`)
	guard := &CustomGuardFunc{Fn: stubGuardFn}
	_, err := LoadWorkflow(data, &LoadWorkflowOptions{
		Guards: GuardRegistry{"otherGuard": guard},
	})
	assertValidationError(t, err, ErrUnknownGuardReference)
}

// ---------------------------------------------------------------------------
// Schema violations
// ---------------------------------------------------------------------------

func TestLoadWorkflow_InvalidJSON(t *testing.T) {
	_, err := LoadWorkflow([]byte("not valid json{"), nil)
	assertValidationError(t, err, ErrSchemaViolation)
}

func TestLoadWorkflow_MissingID(t *testing.T) {
	data := []byte(`{"entry":"A","nodes":{"A":{"id":"A","spec":{}}},"edges":[]}`)
	_, err := LoadWorkflow(data, nil)
	assertValidationError(t, err, ErrSchemaViolation)
}

func TestLoadWorkflow_MissingEntry(t *testing.T) {
	data := []byte(`{"id":"x","nodes":{"A":{"id":"A","spec":{}}},"edges":[]}`)
	_, err := LoadWorkflow(data, nil)
	assertValidationError(t, err, ErrSchemaViolation)
}

func TestLoadWorkflow_MissingNodes(t *testing.T) {
	data := []byte(`{"id":"x","entry":"A","edges":[]}`)
	_, err := LoadWorkflow(data, nil)
	assertValidationError(t, err, ErrSchemaViolation)
}

func TestLoadWorkflow_MissingEdges(t *testing.T) {
	data := []byte(`{"id":"x","entry":"A","nodes":{"A":{"id":"A","spec":{}}}}`)
	_, err := LoadWorkflow(data, nil)
	assertValidationError(t, err, ErrSchemaViolation)
}

func TestLoadWorkflow_UnknownGuardType(t *testing.T) {
	data := []byte(`{
		"id": "x",
		"entry": "A",
		"nodes": {
			"A": {"id": "A", "spec": {}},
			"B": {"id": "B", "spec": {}}
		},
		"edges": [{
			"id": "e1", "from": "A", "to": "B", "event": "NEXT",
			"guard": {"type": "bogus", "key": "x"}
		}]
	}`)
	_, err := LoadWorkflow(data, nil)
	assertValidationError(t, err, ErrSchemaViolation)
}

func TestLoadWorkflow_SchemaFieldAllowed(t *testing.T) {
	// $schema field should be silently ignored
	wf, err := LoadWorkflow(readFixture(t, "greeting.json"), nil)
	if err != nil {
		t.Fatalf("$schema field should be allowed: %v", err)
	}
	if wf.ID != "greeting" {
		t.Errorf("id = %q", wf.ID)
	}
}
