package examples

import reflex "github.com/corpus-relica/reflex/go"

// LinearWorkflow creates a simple A→B→C linear workflow for testing.
func LinearWorkflow(id string) *reflex.Workflow {
	return &reflex.Workflow{
		ID:    id,
		Entry: "A",
		Nodes: map[string]*reflex.Node{
			"A": {ID: "A", Spec: reflex.NodeSpec{"autoAdvance": true}},
			"B": {ID: "B", Spec: reflex.NodeSpec{"autoAdvance": true}},
			"C": {ID: "C", Spec: reflex.NodeSpec{"complete": true}},
		},
		Edges: []reflex.Edge{
			{ID: "e1", From: "A", To: "B", Event: "NEXT"},
			{ID: "e2", From: "B", To: "C", Event: "NEXT"},
		},
	}
}

// BranchingWorkflow creates a workflow with guard-based branching.
// INIT → DECIDE → (LEFT or RIGHT, guarded on "choice" key) → END
func BranchingWorkflow() *reflex.Workflow {
	return &reflex.Workflow{
		ID:    "branching",
		Entry: "INIT",
		Nodes: map[string]*reflex.Node{
			"INIT":  {ID: "INIT", Spec: reflex.NodeSpec{"writes": []reflex.BlackboardWrite{{Key: "choice", Value: "right"}}}},
			"DECIDE": {ID: "DECIDE", Spec: reflex.NodeSpec{}},
			"LEFT":  {ID: "LEFT", Spec: reflex.NodeSpec{"complete": true}},
			"RIGHT": {ID: "RIGHT", Spec: reflex.NodeSpec{"complete": true}},
		},
		Edges: []reflex.Edge{
			{ID: "e-init", From: "INIT", To: "DECIDE", Event: "NEXT"},
			{ID: "e-left", From: "DECIDE", To: "LEFT", Event: "GO",
				Guard: &reflex.BuiltinGuard{Type: reflex.GuardEquals, Key: "choice", Value: "left"}},
			{ID: "e-right", From: "DECIDE", To: "RIGHT", Event: "GO",
				Guard: &reflex.BuiltinGuard{Type: reflex.GuardEquals, Key: "choice", Value: "right"}},
		},
	}
}

// ParentChildWorkflows returns a parent and child workflow for sub-workflow tests.
// Parent: START → INVOKE(child) → END
// Child: CHILD_START → CHILD_END
func ParentChildWorkflows() (*reflex.Workflow, *reflex.Workflow) {
	child := &reflex.Workflow{
		ID:    "child",
		Entry: "CHILD_START",
		Nodes: map[string]*reflex.Node{
			"CHILD_START": {ID: "CHILD_START", Spec: reflex.NodeSpec{
				"writes": []reflex.BlackboardWrite{{Key: "output", Value: "from_child"}},
			}},
			"CHILD_END": {ID: "CHILD_END", Spec: reflex.NodeSpec{"complete": true}},
		},
		Edges: []reflex.Edge{
			{ID: "ec1", From: "CHILD_START", To: "CHILD_END", Event: "NEXT"},
		},
	}

	parent := &reflex.Workflow{
		ID:    "parent",
		Entry: "START",
		Nodes: map[string]*reflex.Node{
			"START": {ID: "START", Spec: reflex.NodeSpec{}},
			"INVOKE": {ID: "INVOKE", Spec: reflex.NodeSpec{}, Invokes: &reflex.InvocationSpec{
				WorkflowID: "child",
				ReturnMap:  []reflex.ReturnMapping{{ParentKey: "result", ChildKey: "output"}},
			}},
			"END": {ID: "END", Spec: reflex.NodeSpec{"complete": true}},
		},
		Edges: []reflex.Edge{
			{ID: "ep1", From: "START", To: "INVOKE", Event: "NEXT"},
			{ID: "ep2", From: "INVOKE", To: "END", Event: "NEXT"},
		},
	}

	return parent, child
}

// GreetingWorkflow creates a simple greeting workflow matching docs/fixtures/greeting.json.
// ASK_NAME → GREET → FAREWELL
func GreetingWorkflow() *reflex.Workflow {
	return &reflex.Workflow{
		ID:    "greeting",
		Entry: "ASK_NAME",
		Nodes: map[string]*reflex.Node{
			"ASK_NAME": {ID: "ASK_NAME", Spec: reflex.NodeSpec{
				"prompt":    "Ask the user for their name",
				"outputKey": "userName",
			}},
			"GREET": {ID: "GREET", Description: "Generate a personalized greeting", Spec: reflex.NodeSpec{
				"prompt":    "Greet the user by name",
				"inputKey":  "userName",
				"outputKey": "greeting",
			}},
			"FAREWELL": {ID: "FAREWELL", Spec: reflex.NodeSpec{
				"prompt":    "Say goodbye",
				"outputKey": "farewell",
			}},
		},
		Edges: []reflex.Edge{
			{ID: "e-ask-greet", From: "ASK_NAME", To: "GREET", Event: "NEXT"},
			{ID: "e-greet-farewell", From: "GREET", To: "FAREWELL", Event: "NEXT"},
		},
	}
}

// DefinePartObjectWorkflow creates the sub-workflow matching docs/fixtures/define-part-object.json.
func DefinePartObjectWorkflow() *reflex.Workflow {
	return &reflex.Workflow{
		ID:    "define-part-object",
		Entry: "PART_CLASSIFY",
		Nodes: map[string]*reflex.Node{
			"PART_CLASSIFY": {ID: "PART_CLASSIFY", Spec: reflex.NodeSpec{
				"writes": []any{map[string]any{"key": "partContext", "value": "Physical Object — Part"}},
			}},
			"PART_BASIC_DATA": {ID: "PART_BASIC_DATA", Spec: reflex.NodeSpec{
				"writes": []any{map[string]any{"key": "partConcept", "value": "Aluminum Housing"}},
			}},
			"PART_DONE": {ID: "PART_DONE", Spec: reflex.NodeSpec{
				"complete": true,
				"writes":   []any{map[string]any{"key": "partStatus", "value": "complete"}},
			}},
		},
		Edges: []reflex.Edge{
			{ID: "e-part-classify-basic", From: "PART_CLASSIFY", To: "PART_BASIC_DATA", Event: "NEXT"},
			{ID: "e-part-basic-done", From: "PART_BASIC_DATA", To: "PART_DONE", Event: "NEXT"},
		},
	}
}

// DefinePhysicalObjectWorkflow creates the root workflow matching docs/fixtures/define-physical-object.json.
func DefinePhysicalObjectWorkflow() *reflex.Workflow {
	return &reflex.Workflow{
		ID:    "define-physical-object",
		Entry: "CLASSIFY",
		Nodes: map[string]*reflex.Node{
			"CLASSIFY": {ID: "CLASSIFY", Spec: reflex.NodeSpec{
				"writes": []any{map[string]any{"key": "workflowType", "value": "define-physical-object"}},
				"edge":   "e-classify-basic",
			}},
			"BASIC_DATA": {ID: "BASIC_DATA", Spec: reflex.NodeSpec{
				"writes": []any{
					map[string]any{"key": "conceptName", "value": "Steel Pipe"},
					map[string]any{"key": "needsPart", "value": true},
				},
				"edge": "e-basic-branch",
			}},
			"BRANCH": {ID: "BRANCH", Spec: reflex.NodeSpec{
				"edge": []any{"e-branch-to-part", "e-branch-to-spec"},
			}},
			"DEFINE_PART": {ID: "DEFINE_PART", Spec: reflex.NodeSpec{}, Invokes: &reflex.InvocationSpec{
				WorkflowID: "define-part-object",
				ReturnMap:  []reflex.ReturnMapping{{ParentKey: "Part Concept", ChildKey: "partConcept"}},
			}},
			"SPEC_COMPOSE": {ID: "SPEC_COMPOSE", Spec: reflex.NodeSpec{
				"writes": []any{map[string]any{"key": "specRelation", "value": "Steel Pipe specializes Physical Object"}},
			}},
			"DONE": {ID: "DONE", Spec: reflex.NodeSpec{
				"complete": true,
				"writes":   []any{map[string]any{"key": "status", "value": "physical-object-defined"}},
			}},
		},
		Edges: []reflex.Edge{
			{ID: "e-classify-basic", From: "CLASSIFY", To: "BASIC_DATA", Event: "NEXT"},
			{ID: "e-basic-branch", From: "BASIC_DATA", To: "BRANCH", Event: "NEXT"},
			{ID: "e-branch-to-part", From: "BRANCH", To: "DEFINE_PART", Event: "DEFINE_PART",
				Guard: &reflex.BuiltinGuard{Type: reflex.GuardExists, Key: "needsPart"}},
			{ID: "e-branch-to-spec", From: "BRANCH", To: "SPEC_COMPOSE", Event: "SPEC_COMPOSE",
				Guard: &reflex.BuiltinGuard{Type: reflex.GuardNotExists, Key: "needsPart"}},
			{ID: "e-part-to-spec", From: "DEFINE_PART", To: "SPEC_COMPOSE", Event: "NEXT"},
			{ID: "e-spec-done", From: "SPEC_COMPOSE", To: "DONE", Event: "NEXT"},
		},
	}
}

// SuspensionWorkflow creates a workflow where the first node suspends.
// WAIT(suspend) → DONE(complete)
func SuspensionWorkflow() *reflex.Workflow {
	return &reflex.Workflow{
		ID:    "suspension",
		Entry: "WAIT",
		Nodes: map[string]*reflex.Node{
			"WAIT": {ID: "WAIT", Spec: reflex.NodeSpec{"suspend": "awaiting input"}},
			"DONE": {ID: "DONE", Spec: reflex.NodeSpec{"complete": true}},
		},
		Edges: []reflex.Edge{
			{ID: "e1", From: "WAIT", To: "DONE", Event: "NEXT"},
		},
	}
}
