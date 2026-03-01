package reflex

import (
	"errors"
	"testing"
)

func linearWorkflow(id string) *Workflow {
	return &Workflow{
		ID:    id,
		Entry: "A",
		Nodes: map[string]*Node{
			"A": {ID: "A", Spec: NodeSpec{}},
			"B": {ID: "B", Spec: NodeSpec{}},
			"C": {ID: "C", Spec: NodeSpec{}},
		},
		Edges: []Edge{
			{ID: "e1", From: "A", To: "B", Event: "NEXT"},
			{ID: "e2", From: "B", To: "C", Event: "NEXT"},
		},
	}
}

func TestRegistryRegisterValidDAG(t *testing.T) {
	r := NewRegistry()
	if err := r.Register(linearWorkflow("wf1")); err != nil {
		t.Fatalf("expected valid DAG to register: %v", err)
	}
}

func TestRegistryRegisterBranchingDAG(t *testing.T) {
	r := NewRegistry()
	w := &Workflow{
		ID:    "branching",
		Entry: "A",
		Nodes: map[string]*Node{
			"A": {ID: "A", Spec: NodeSpec{}},
			"B": {ID: "B", Spec: NodeSpec{}},
			"C": {ID: "C", Spec: NodeSpec{}},
		},
		Edges: []Edge{
			{ID: "e1", From: "A", To: "B", Event: "LEFT"},
			{ID: "e2", From: "A", To: "C", Event: "RIGHT"},
		},
	}
	if err := r.Register(w); err != nil {
		t.Fatalf("expected branching DAG to register: %v", err)
	}
}

func TestRegistryRegisterConvergingDAG(t *testing.T) {
	r := NewRegistry()
	w := &Workflow{
		ID:    "converging",
		Entry: "A",
		Nodes: map[string]*Node{
			"A": {ID: "A", Spec: NodeSpec{}},
			"B": {ID: "B", Spec: NodeSpec{}},
			"C": {ID: "C", Spec: NodeSpec{}},
		},
		Edges: []Edge{
			{ID: "e1", From: "A", To: "C", Event: "NEXT"},
			{ID: "e2", From: "B", To: "C", Event: "NEXT"},
		},
	}
	if err := r.Register(w); err != nil {
		t.Fatalf("expected converging DAG to register: %v", err)
	}
}

func TestRegistryEmptyWorkflow(t *testing.T) {
	r := NewRegistry()
	w := &Workflow{ID: "empty", Entry: "A", Nodes: map[string]*Node{}, Edges: nil}
	err := r.Register(w)
	assertValidationError(t, err, ErrEmptyWorkflow)
}

func TestRegistryMissingEntryNode(t *testing.T) {
	r := NewRegistry()
	w := &Workflow{
		ID:    "bad-entry",
		Entry: "MISSING",
		Nodes: map[string]*Node{"A": {ID: "A", Spec: NodeSpec{}}},
	}
	err := r.Register(w)
	assertValidationError(t, err, ErrInvalidEntryNode)
}

func TestRegistryNodeIDMismatch(t *testing.T) {
	r := NewRegistry()
	w := &Workflow{
		ID:    "mismatch",
		Entry: "X",
		Nodes: map[string]*Node{"X": {ID: "Y", Spec: NodeSpec{}}},
	}
	err := r.Register(w)
	assertValidationError(t, err, ErrNodeIDMismatch)
}

func TestRegistryInvalidEdgeFrom(t *testing.T) {
	r := NewRegistry()
	w := &Workflow{
		ID:    "bad-edge",
		Entry: "A",
		Nodes: map[string]*Node{"A": {ID: "A", Spec: NodeSpec{}}, "B": {ID: "B", Spec: NodeSpec{}}},
		Edges: []Edge{{ID: "e1", From: "MISSING", To: "B", Event: "NEXT"}},
	}
	err := r.Register(w)
	assertValidationError(t, err, ErrInvalidEdge)
}

func TestRegistryInvalidEdgeTo(t *testing.T) {
	r := NewRegistry()
	w := &Workflow{
		ID:    "bad-edge2",
		Entry: "A",
		Nodes: map[string]*Node{"A": {ID: "A", Spec: NodeSpec{}}},
		Edges: []Edge{{ID: "e1", From: "A", To: "MISSING", Event: "NEXT"}},
	}
	err := r.Register(w)
	assertValidationError(t, err, ErrInvalidEdge)
}

func TestRegistryNoTerminalNodes(t *testing.T) {
	r := NewRegistry()
	w := &Workflow{
		ID:    "no-terminal",
		Entry: "A",
		Nodes: map[string]*Node{
			"A": {ID: "A", Spec: NodeSpec{}},
			"B": {ID: "B", Spec: NodeSpec{}},
		},
		Edges: []Edge{
			{ID: "e1", From: "A", To: "B", Event: "NEXT"},
			{ID: "e2", From: "B", To: "A", Event: "BACK"},
		},
	}
	err := r.Register(w)
	// This might be caught as either CycleDetected or NoTerminalNodes
	if err == nil {
		t.Fatal("expected error for no terminal nodes / cycle")
	}
}

func TestRegistryCycleDetected(t *testing.T) {
	r := NewRegistry()
	// Cycle: A→B→C→A. All nodes have outgoing edges AND form a cycle.
	// C→A closes the cycle; A is terminal-free, so NO_TERMINAL catches first.
	// Use a DAG with a terminal node + a separate cycle to isolate cycle detection.
	w := &Workflow{
		ID:    "cycle",
		Entry: "A",
		Nodes: map[string]*Node{
			"A": {ID: "A", Spec: NodeSpec{}},
			"B": {ID: "B", Spec: NodeSpec{}},
			"C": {ID: "C", Spec: NodeSpec{}},
			"D": {ID: "D", Spec: NodeSpec{}}, // terminal
		},
		Edges: []Edge{
			{ID: "e1", From: "A", To: "B", Event: "NEXT"},
			{ID: "e2", From: "B", To: "C", Event: "NEXT"},
			{ID: "e3", From: "C", To: "B", Event: "BACK"}, // cycle B↔C
			{ID: "e4", From: "A", To: "D", Event: "ALT"},
		},
	}
	err := r.Register(w)
	assertValidationError(t, err, ErrCycleDetected)
}

func TestRegistrySelfLoop(t *testing.T) {
	r := NewRegistry()
	w := &Workflow{
		ID:    "self-loop",
		Entry: "A",
		Nodes: map[string]*Node{"A": {ID: "A", Spec: NodeSpec{}}},
		Edges: []Edge{{ID: "e1", From: "A", To: "A", Event: "LOOP"}},
	}
	err := r.Register(w)
	if err == nil {
		t.Fatal("expected error for self-loop")
	}
}

func TestRegistryDuplicateID(t *testing.T) {
	r := NewRegistry()
	_ = r.Register(linearWorkflow("dup"))
	err := r.Register(linearWorkflow("dup"))
	assertValidationError(t, err, ErrDuplicateWorkflowID)
}

func TestRegistryGetHasList(t *testing.T) {
	r := NewRegistry()
	_ = r.Register(linearWorkflow("wf1"))
	_ = r.Register(linearWorkflow("wf2"))

	t.Run("Get returns registered workflow", func(t *testing.T) {
		w, ok := r.Get("wf1")
		if !ok || w.ID != "wf1" {
			t.Error("expected to get wf1")
		}
	})
	t.Run("Get returns false for missing", func(t *testing.T) {
		_, ok := r.Get("nope")
		if ok {
			t.Error("expected false for missing")
		}
	})
	t.Run("Has returns true", func(t *testing.T) {
		if !r.Has("wf1") {
			t.Error("expected Has=true")
		}
	})
	t.Run("Has returns false", func(t *testing.T) {
		if r.Has("nope") {
			t.Error("expected Has=false")
		}
	})
	t.Run("List returns all IDs", func(t *testing.T) {
		list := r.List()
		if len(list) != 2 {
			t.Errorf("expected 2, got %d", len(list))
		}
	})
}

func TestRegistryInvocationRefWarning(t *testing.T) {
	// Should register without error even if invocation target doesn't exist yet
	r := NewRegistry()
	w := &Workflow{
		ID:    "parent",
		Entry: "A",
		Nodes: map[string]*Node{
			"A": {ID: "A", Spec: NodeSpec{}, Invokes: &InvocationSpec{WorkflowID: "nonexistent", ReturnMap: nil}},
			"B": {ID: "B", Spec: NodeSpec{}},
		},
		Edges: []Edge{{ID: "e1", From: "A", To: "B", Event: "NEXT"}},
	}
	if err := r.Register(w); err != nil {
		t.Fatalf("invocation ref to unregistered workflow should warn, not error: %v", err)
	}
}

func assertValidationError(t *testing.T, err error, code ValidationErrorCode) {
	t.Helper()
	if err == nil {
		t.Fatalf("expected ValidationError with code %s, got nil", code)
	}
	var ve *ValidationError
	if !errors.As(err, &ve) {
		t.Fatalf("expected *ValidationError, got %T: %v", err, err)
	}
	if ve.Code != code {
		t.Errorf("expected code %s, got %s: %s", code, ve.Code, ve.Message)
	}
}

// ---------------------------------------------------------------------------
// Verification (M8-2: Static Verification)
// ---------------------------------------------------------------------------

func TestVerify_CleanResultNoContracts(t *testing.T) {
	r := NewRegistry()
	_ = r.Register(linearWorkflow("wf"))
	result, err := r.Verify("wf")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !result.Valid {
		t.Error("expected valid=true for workflow with no contracts")
	}
	if len(result.Warnings) != 0 {
		t.Errorf("expected 0 warnings, got %d", len(result.Warnings))
	}
	if result.WorkflowID != "wf" {
		t.Errorf("workflowId = %q, want wf", result.WorkflowID)
	}
}

func TestVerify_RequiredInputSatisfied(t *testing.T) {
	r := NewRegistry()
	wf := &Workflow{
		ID:    "satisfied",
		Entry: "A",
		Nodes: map[string]*Node{
			"A": {ID: "A", Spec: NodeSpec{}, Outputs: []NodeOutput{{Key: "x", Guaranteed: true}}},
			"B": {ID: "B", Spec: NodeSpec{}, Inputs: []NodeInput{{Key: "x", Required: true}}},
		},
		Edges: []Edge{{ID: "e1", From: "A", To: "B", Event: "NEXT"}},
	}
	_ = r.Register(wf)
	result, err := r.Verify("satisfied")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !result.Valid {
		t.Error("expected valid=true")
	}
	if len(result.Warnings) != 0 {
		t.Errorf("expected 0 warnings, got %d", len(result.Warnings))
	}
}

func TestVerify_RequiredInputMissing(t *testing.T) {
	r := NewRegistry()
	wf := &Workflow{
		ID:    "missing-input",
		Entry: "A",
		Nodes: map[string]*Node{
			"A": {ID: "A", Spec: NodeSpec{}},
			"B": {ID: "B", Spec: NodeSpec{}, Inputs: []NodeInput{{Key: "x", Required: true}}},
		},
		Edges: []Edge{{ID: "e1", From: "A", To: "B", Event: "NEXT"}},
	}
	_ = r.Register(wf)
	result, err := r.Verify("missing-input")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Valid {
		t.Error("expected valid=false")
	}
	if len(result.Warnings) != 1 {
		t.Fatalf("expected 1 warning, got %d", len(result.Warnings))
	}
	w := result.Warnings[0]
	if w.Code != WarnMissingRequiredInput {
		t.Errorf("code = %q, want MISSING_REQUIRED_INPUT", w.Code)
	}
	if w.NodeID != "B" {
		t.Errorf("nodeId = %q, want B", w.NodeID)
	}
	if w.Key != "x" {
		t.Errorf("key = %q, want x", w.Key)
	}
}

func TestVerify_OptionalInputNoProducer(t *testing.T) {
	r := NewRegistry()
	wf := &Workflow{
		ID:    "optional-input",
		Entry: "A",
		Nodes: map[string]*Node{
			"A": {ID: "A", Spec: NodeSpec{}},
			"B": {ID: "B", Spec: NodeSpec{}, Inputs: []NodeInput{{Key: "x", Required: false}}},
		},
		Edges: []Edge{{ID: "e1", From: "A", To: "B", Event: "NEXT"}},
	}
	_ = r.Register(wf)
	result, err := r.Verify("optional-input")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !result.Valid {
		t.Error("expected valid=true for optional input")
	}
	if len(result.Warnings) != 0 {
		t.Errorf("expected 0 warnings, got %d", len(result.Warnings))
	}
}

func TestVerify_ReturnMapKeyNotInChildOutputs(t *testing.T) {
	r := NewRegistry()
	child := &Workflow{
		ID:    "child-wf",
		Entry: "C",
		Nodes: map[string]*Node{
			"C": {ID: "C", Spec: NodeSpec{}, Outputs: []NodeOutput{{Key: "actualOutput", Guaranteed: true}}},
		},
		Edges: []Edge{},
	}
	parent := &Workflow{
		ID:    "parent-wf",
		Entry: "P",
		Nodes: map[string]*Node{
			"P": {ID: "P", Spec: NodeSpec{}, Invokes: &InvocationSpec{
				WorkflowID: "child-wf",
				ReturnMap:  []ReturnMapping{{ParentKey: "result", ChildKey: "wrongKey"}},
			}},
			"DONE": {ID: "DONE", Spec: NodeSpec{}},
		},
		Edges: []Edge{{ID: "e1", From: "P", To: "DONE", Event: "NEXT"}},
	}
	_ = r.Register(child)
	_ = r.Register(parent)
	result, err := r.Verify("parent-wf")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Valid {
		t.Error("expected valid=false")
	}
	if len(result.Warnings) != 1 {
		t.Fatalf("expected 1 warning, got %d", len(result.Warnings))
	}
	w := result.Warnings[0]
	if w.Code != WarnReturnMapKeyNotInChildOutputs {
		t.Errorf("code = %q, want RETURNMAP_KEY_NOT_IN_CHILD_OUTPUTS", w.Code)
	}
	if w.Key != "wrongKey" {
		t.Errorf("key = %q, want wrongKey", w.Key)
	}
}

func TestVerify_ReturnMapKeyInChildOutputs(t *testing.T) {
	r := NewRegistry()
	child := &Workflow{
		ID:    "child-ok",
		Entry: "C",
		Nodes: map[string]*Node{
			"C": {ID: "C", Spec: NodeSpec{}, Outputs: []NodeOutput{{Key: "output", Guaranteed: true}}},
		},
		Edges: []Edge{},
	}
	parent := &Workflow{
		ID:    "parent-ok",
		Entry: "P",
		Nodes: map[string]*Node{
			"P": {ID: "P", Spec: NodeSpec{}, Invokes: &InvocationSpec{
				WorkflowID: "child-ok",
				ReturnMap:  []ReturnMapping{{ParentKey: "result", ChildKey: "output"}},
			}},
			"DONE": {ID: "DONE", Spec: NodeSpec{}},
		},
		Edges: []Edge{{ID: "e1", From: "P", To: "DONE", Event: "NEXT"}},
	}
	_ = r.Register(child)
	_ = r.Register(parent)
	result, err := r.Verify("parent-ok")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !result.Valid {
		t.Error("expected valid=true")
	}
	if len(result.Warnings) != 0 {
		t.Errorf("expected 0 warnings, got %d", len(result.Warnings))
	}
}

func TestVerify_ReturnMapChildHasNoContracts(t *testing.T) {
	r := NewRegistry()
	child := &Workflow{
		ID:    "child-no-contracts",
		Entry: "C",
		Nodes: map[string]*Node{
			"C": {ID: "C", Spec: NodeSpec{}},
		},
		Edges: []Edge{},
	}
	parent := &Workflow{
		ID:    "parent-unchecked",
		Entry: "P",
		Nodes: map[string]*Node{
			"P": {ID: "P", Spec: NodeSpec{}, Invokes: &InvocationSpec{
				WorkflowID: "child-no-contracts",
				ReturnMap:  []ReturnMapping{{ParentKey: "result", ChildKey: "anyKey"}},
			}},
			"DONE": {ID: "DONE", Spec: NodeSpec{}},
		},
		Edges: []Edge{{ID: "e1", From: "P", To: "DONE", Event: "NEXT"}},
	}
	_ = r.Register(child)
	_ = r.Register(parent)
	result, err := r.Verify("parent-unchecked")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !result.Valid {
		t.Error("expected valid=true when child has no contracts")
	}
}

func TestVerify_ReturnMapChildNotRegistered(t *testing.T) {
	r := NewRegistry()
	wf := &Workflow{
		ID:    "parent-unregistered",
		Entry: "A",
		Nodes: map[string]*Node{
			"A": {ID: "A", Spec: NodeSpec{}, Invokes: &InvocationSpec{
				WorkflowID: "not-registered",
				ReturnMap:  []ReturnMapping{{ParentKey: "x", ChildKey: "y"}},
			}},
			"B": {ID: "B", Spec: NodeSpec{}},
		},
		Edges: []Edge{{ID: "e1", From: "A", To: "B", Event: "NEXT"}},
	}
	_ = r.Register(wf)
	result, err := r.Verify("parent-unregistered")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !result.Valid {
		t.Error("expected valid=true when child not registered")
	}
}

func TestVerify_UnregisteredWorkflow(t *testing.T) {
	r := NewRegistry()
	_, err := r.Verify("does-not-exist")
	if err == nil {
		t.Fatal("expected error for unregistered workflow")
	}
}

func TestVerify_MultipleMissingInputs(t *testing.T) {
	r := NewRegistry()
	wf := &Workflow{
		ID:    "multi-missing",
		Entry: "A",
		Nodes: map[string]*Node{
			"A": {ID: "A", Spec: NodeSpec{}},
			"B": {ID: "B", Spec: NodeSpec{}, Inputs: []NodeInput{
				{Key: "x", Required: true},
				{Key: "y", Required: true},
			}},
		},
		Edges: []Edge{{ID: "e1", From: "A", To: "B", Event: "NEXT"}},
	}
	_ = r.Register(wf)
	result, err := r.Verify("multi-missing")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Valid {
		t.Error("expected valid=false")
	}
	if len(result.Warnings) != 2 {
		t.Fatalf("expected 2 warnings, got %d", len(result.Warnings))
	}
}
