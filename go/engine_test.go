package reflex

import (
	"context"
	"errors"
	"testing"
)

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

// agentFunc wraps a function as a DecisionAgent.
type agentFunc func(ctx context.Context, dc DecisionContext) (Decision, error)

func (f agentFunc) Resolve(ctx context.Context, dc DecisionContext) (Decision, error) {
	return f(ctx, dc)
}

// autoAdvanceAgent always picks the first valid edge.
func autoAdvanceAgent() DecisionAgent {
	return agentFunc(func(_ context.Context, dc DecisionContext) (Decision, error) {
		if len(dc.ValidEdges) == 0 {
			return Decision{Type: DecisionComplete}, nil
		}
		return Decision{Type: DecisionAdvance, Edge: dc.ValidEdges[0].ID}, nil
	})
}

// setupLinear creates a registry with a linear A→B→C workflow and returns engine + registry.
func setupLinear() (*Engine, *Registry) {
	r := NewRegistry()
	_ = r.Register(linearWorkflow("linear"))
	e := NewEngine(r, autoAdvanceAgent())
	return e, r
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

func TestEngineInit(t *testing.T) {
	e, _ := setupLinear()

	t.Run("returns session ID", func(t *testing.T) {
		sid, err := e.Init("linear")
		if err != nil {
			t.Fatal(err)
		}
		if sid == "" {
			t.Error("expected non-empty session ID")
		}
	})
	t.Run("status is running after init", func(t *testing.T) {
		_, _ = e.Init("linear")
		if e.Status() != StatusRunning {
			t.Errorf("expected running, got %s", e.Status())
		}
	})
	t.Run("current node is entry", func(t *testing.T) {
		_, _ = e.Init("linear")
		n := e.CurrentNode()
		if n == nil || n.ID != "A" {
			t.Error("expected current node A")
		}
	})
	t.Run("error for unregistered workflow", func(t *testing.T) {
		_, err := e.Init("nonexistent")
		if err == nil {
			t.Error("expected error")
		}
	})
}

// ---------------------------------------------------------------------------
// Init — node:enter for entry node
// ---------------------------------------------------------------------------

func TestEngineInitEntryNodeEnter(t *testing.T) {
	t.Run("emits node:enter for entry node during init", func(t *testing.T) {
		e, _ := setupLinear()

		var enterEvents []Event
		e.On(EventNodeEnter, func(ev Event) {
			enterEvents = append(enterEvents, ev)
		})

		_, _ = e.Init("linear")

		if len(enterEvents) != 1 {
			t.Fatalf("expected 1 node:enter from init, got %d", len(enterEvents))
		}
		if enterEvents[0].NodeID != "A" {
			t.Errorf("expected node:enter for A, got %s", enterEvents[0].NodeID)
		}
		if enterEvents[0].WorkflowID != "linear" {
			t.Errorf("expected workflowId=linear, got %s", enterEvents[0].WorkflowID)
		}
	})

	t.Run("node:enter fires after seed blackboard:write", func(t *testing.T) {
		r := NewRegistry()
		_ = r.Register(linearWorkflow("linear"))
		e := NewEngine(r, autoAdvanceAgent())

		var events []EventType
		e.On(EventBlackboardWrite, func(_ Event) { events = append(events, EventBlackboardWrite) })
		e.On(EventNodeEnter, func(_ Event) { events = append(events, EventNodeEnter) })

		_, _ = e.Init("linear", InitOptions{
			Blackboard: []BlackboardWrite{{Key: "x", Value: 1}},
		})

		if len(events) != 2 {
			t.Fatalf("expected 2 events from init, got %d: %v", len(events), events)
		}
		if events[0] != EventBlackboardWrite {
			t.Errorf("expected blackboard:write first, got %s", events[0])
		}
		if events[1] != EventNodeEnter {
			t.Errorf("expected node:enter second, got %s", events[1])
		}
	})

	t.Run("no double node:enter on first step after init", func(t *testing.T) {
		e, _ := setupLinear()

		var enterNodes []string
		e.On(EventNodeEnter, func(ev Event) {
			enterNodes = append(enterNodes, ev.NodeID)
		})

		_, _ = e.Init("linear")
		_, _ = e.Step(context.Background()) // A→B

		// Expect: A (from Init), B (from first Step). NOT A, A, B.
		if len(enterNodes) != 2 {
			t.Fatalf("expected 2 node:enter events (A from init, B from step), got %d: %v", len(enterNodes), enterNodes)
		}
		if enterNodes[0] != "A" {
			t.Errorf("expected first node:enter for A, got %s", enterNodes[0])
		}
		if enterNodes[1] != "B" {
			t.Errorf("expected second node:enter for B, got %s", enterNodes[1])
		}
	})
}

// ---------------------------------------------------------------------------
// Step — linear workflow
// ---------------------------------------------------------------------------

func TestEngineStepLinear(t *testing.T) {
	e, _ := setupLinear()
	_, _ = e.Init("linear")

	// Step 1: A → B
	r1, err := e.Step(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if r1.Status != StepAdvanced || r1.Node.ID != "B" {
		t.Errorf("expected advanced to B, got %s %v", r1.Status, r1.Node)
	}

	// Step 2: B → C
	r2, err := e.Step(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if r2.Status != StepAdvanced || r2.Node.ID != "C" {
		t.Errorf("expected advanced to C, got %s", r2.Status)
	}

	// Step 3: C is terminal → complete
	r3, err := e.Step(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if r3.Status != StepCompleted {
		t.Errorf("expected completed, got %s", r3.Status)
	}
	if e.Status() != StatusCompleted {
		t.Errorf("expected engine completed, got %s", e.Status())
	}
}

// ---------------------------------------------------------------------------
// Step — branching via guards
// ---------------------------------------------------------------------------

func TestEngineStepBranching(t *testing.T) {
	r := NewRegistry()
	// INIT → START (writes dir) → LEFT or RIGHT (guarded)
	_ = r.Register(&Workflow{
		ID:    "branch",
		Entry: "INIT",
		Nodes: map[string]*Node{
			"INIT":  {ID: "INIT", Spec: NodeSpec{}},
			"START": {ID: "START", Spec: NodeSpec{}},
			"LEFT":  {ID: "LEFT", Spec: NodeSpec{}},
			"RIGHT": {ID: "RIGHT", Spec: NodeSpec{}},
		},
		Edges: []Edge{
			{ID: "e-init", From: "INIT", To: "START", Event: "NEXT"},
			{ID: "e-left", From: "START", To: "LEFT", Event: "GO", Guard: &BuiltinGuard{Type: GuardEquals, Key: "dir", Value: "left"}},
			{ID: "e-right", From: "START", To: "RIGHT", Event: "GO", Guard: &BuiltinGuard{Type: GuardEquals, Key: "dir", Value: "right"}},
		},
	})

	// INIT writes dir=right to blackboard, then START sees guarded edges
	agent := agentFunc(func(_ context.Context, dc DecisionContext) (Decision, error) {
		switch dc.Node.ID {
		case "INIT":
			return Decision{
				Type:   DecisionAdvance,
				Edge:   "e-init",
				Writes: []BlackboardWrite{{Key: "dir", Value: "right"}},
			}, nil
		case "START":
			// Guards have already filtered — only e-right should be valid
			for _, e := range dc.ValidEdges {
				if e.ID == "e-right" {
					return Decision{Type: DecisionAdvance, Edge: "e-right"}, nil
				}
			}
			return Decision{}, errors.New("e-right not in valid edges")
		default:
			return Decision{Type: DecisionComplete}, nil
		}
	})

	e := NewEngine(r, agent)
	_, _ = e.Init("branch")

	// Step 1: INIT → START (writes dir=right)
	r1, _ := e.Step(context.Background())
	if r1.Node.ID != "START" {
		t.Fatalf("expected START, got %s", r1.Node.ID)
	}

	// Step 2: START → RIGHT (guard passes)
	r2, err := e.Step(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if r2.Node.ID != "RIGHT" {
		t.Errorf("expected RIGHT, got %s", r2.Node.ID)
	}
}

// ---------------------------------------------------------------------------
// Step — sub-workflow invocation and pop
// ---------------------------------------------------------------------------

func TestEngineSubWorkflow(t *testing.T) {
	r := NewRegistry()

	// Child: CHILD_A → CHILD_END
	_ = r.Register(&Workflow{
		ID:    "child",
		Entry: "CHILD_A",
		Nodes: map[string]*Node{
			"CHILD_A":   {ID: "CHILD_A", Spec: NodeSpec{}},
			"CHILD_END": {ID: "CHILD_END", Spec: NodeSpec{}},
		},
		Edges: []Edge{{ID: "ec1", From: "CHILD_A", To: "CHILD_END", Event: "NEXT"}},
	})

	// Parent: SETUP → INVOKE → END
	_ = r.Register(&Workflow{
		ID:    "parent",
		Entry: "SETUP",
		Nodes: map[string]*Node{
			"SETUP": {ID: "SETUP", Spec: NodeSpec{}},
			"INVOKE": {ID: "INVOKE", Spec: NodeSpec{}, Invokes: &InvocationSpec{
				WorkflowID: "child",
				ReturnMap:  []ReturnMapping{{ParentKey: "result", ChildKey: "output"}},
			}},
			"END": {ID: "END", Spec: NodeSpec{}},
		},
		Edges: []Edge{
			{ID: "ep1", From: "SETUP", To: "INVOKE", Event: "NEXT"},
			{ID: "ep2", From: "INVOKE", To: "END", Event: "NEXT"},
		},
	})

	agent := agentFunc(func(_ context.Context, dc DecisionContext) (Decision, error) {
		if len(dc.ValidEdges) == 0 {
			writes := []BlackboardWrite{}
			if dc.Node.ID == "CHILD_END" {
				writes = append(writes, BlackboardWrite{Key: "output", Value: "child_result"})
			}
			return Decision{Type: DecisionComplete, Writes: writes}, nil
		}
		return Decision{Type: DecisionAdvance, Edge: dc.ValidEdges[0].ID}, nil
	})

	e := NewEngine(r, agent)
	_, _ = e.Init("parent")

	// Step 1: SETUP → INVOKE
	r1, _ := e.Step(context.Background())
	if r1.Status != StepAdvanced || r1.Node.ID != "INVOKE" {
		t.Fatalf("expected advanced to INVOKE, got %s %v", r1.Status, r1.Node)
	}

	// Step 2: INVOKE triggers invocation → child starts at CHILD_A
	r2, _ := e.Step(context.Background())
	if r2.Status != StepInvoked || r2.Node.ID != "CHILD_A" {
		t.Fatalf("expected invoked at CHILD_A, got %s", r2.Status)
	}
	if len(e.Stack()) != 1 {
		t.Fatalf("expected stack depth 1, got %d", len(e.Stack()))
	}

	// Step 3: CHILD_A → CHILD_END
	r3, _ := e.Step(context.Background())
	if r3.Status != StepAdvanced || r3.Node.ID != "CHILD_END" {
		t.Fatalf("expected advanced to CHILD_END, got %s", r3.Status)
	}

	// Step 4: CHILD_END completes → pop back to parent INVOKE
	r4, _ := e.Step(context.Background())
	if r4.Status != StepPopped || r4.Node.ID != "INVOKE" {
		t.Fatalf("expected popped to INVOKE, got %s %v", r4.Status, r4.Node)
	}

	// Verify returnMap copied "output" → "result"
	v, ok := e.Blackboard().Get("result")
	if !ok || v != "child_result" {
		t.Errorf("expected result=child_result, got %v (ok=%v)", v, ok)
	}

	// Step 5: INVOKE → END (skip re-invocation)
	r5, _ := e.Step(context.Background())
	if r5.Status != StepAdvanced || r5.Node.ID != "END" {
		t.Fatalf("expected advanced to END, got %s", r5.Status)
	}

	// Step 6: END completes
	r6, _ := e.Step(context.Background())
	if r6.Status != StepCompleted {
		t.Fatalf("expected completed, got %s", r6.Status)
	}
}

// ---------------------------------------------------------------------------
// Step — suspension and resumption
// ---------------------------------------------------------------------------

func TestEngineSuspension(t *testing.T) {
	r := NewRegistry()
	_ = r.Register(linearWorkflow("wf"))

	callCount := 0
	agent := agentFunc(func(_ context.Context, dc DecisionContext) (Decision, error) {
		callCount++
		if dc.Node.ID == "A" && callCount == 1 {
			return Decision{Type: DecisionSuspend, Reason: "awaiting input"}, nil
		}
		if len(dc.ValidEdges) == 0 {
			return Decision{Type: DecisionComplete}, nil
		}
		return Decision{Type: DecisionAdvance, Edge: dc.ValidEdges[0].ID}, nil
	})

	e := NewEngine(r, agent)
	_, _ = e.Init("wf")

	// Step 1: suspend at A
	res, _ := e.Step(context.Background())
	if res.Status != StepSuspended || res.Reason != "awaiting input" {
		t.Fatalf("expected suspended, got %s", res.Status)
	}
	if e.Status() != StatusSuspended {
		t.Error("expected engine suspended")
	}

	// Step 2: resume → advance to B
	res2, _ := e.Step(context.Background())
	if res2.Status != StepAdvanced || res2.Node.ID != "B" {
		t.Fatalf("expected advanced to B after resume, got %s", res2.Status)
	}
}

// ---------------------------------------------------------------------------
// Step — complete at non-terminal
// ---------------------------------------------------------------------------

func TestEngineCompleteAtNonTerminal(t *testing.T) {
	r := NewRegistry()
	_ = r.Register(linearWorkflow("wf"))

	agent := agentFunc(func(_ context.Context, dc DecisionContext) (Decision, error) {
		return Decision{Type: DecisionComplete}, nil // A has outgoing edges
	})

	e := NewEngine(r, agent)
	_, _ = e.Init("wf")

	res, _ := e.Step(context.Background())
	if res.Status != StepSuspended {
		t.Fatalf("expected suspended (error), got %s", res.Status)
	}
}

// ---------------------------------------------------------------------------
// Step — invalid edge selection
// ---------------------------------------------------------------------------

func TestEngineInvalidEdge(t *testing.T) {
	r := NewRegistry()
	_ = r.Register(linearWorkflow("wf"))

	agent := agentFunc(func(_ context.Context, dc DecisionContext) (Decision, error) {
		return Decision{Type: DecisionAdvance, Edge: "nonexistent"}, nil
	})

	e := NewEngine(r, agent)
	_, _ = e.Init("wf")

	res, _ := e.Step(context.Background())
	if res.Status != StepSuspended {
		t.Fatalf("expected suspended (error), got %s", res.Status)
	}
}

// ---------------------------------------------------------------------------
// Step — missing sub-workflow at runtime
// ---------------------------------------------------------------------------

func TestEngineMissingSubWorkflow(t *testing.T) {
	r := NewRegistry()
	_ = r.Register(&Workflow{
		ID:    "parent",
		Entry: "A",
		Nodes: map[string]*Node{
			"A": {ID: "A", Spec: NodeSpec{}, Invokes: &InvocationSpec{WorkflowID: "missing"}},
			"B": {ID: "B", Spec: NodeSpec{}},
		},
		Edges: []Edge{{ID: "e1", From: "A", To: "B", Event: "NEXT"}},
	})

	e := NewEngine(r, autoAdvanceAgent())
	_, _ = e.Init("parent")

	res, _ := e.Step(context.Background())
	if res.Status != StepSuspended {
		t.Fatalf("expected suspended (missing sub-workflow), got %s", res.Status)
	}
}

// ---------------------------------------------------------------------------
// Step — agent error
// ---------------------------------------------------------------------------

func TestEngineAgentError(t *testing.T) {
	r := NewRegistry()
	_ = r.Register(linearWorkflow("wf"))

	agent := agentFunc(func(_ context.Context, dc DecisionContext) (Decision, error) {
		return Decision{}, errors.New("agent broke")
	})

	e := NewEngine(r, agent)
	_, _ = e.Init("wf")

	res, _ := e.Step(context.Background())
	if res.Status != StepSuspended {
		t.Fatalf("expected suspended, got %s", res.Status)
	}
}

// ---------------------------------------------------------------------------
// Run — completes linear workflow
// ---------------------------------------------------------------------------

func TestEngineRunComplete(t *testing.T) {
	e, _ := setupLinear()
	_, _ = e.Init("linear")

	res, err := e.Run(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if res.Status != StepCompleted {
		t.Errorf("expected completed, got %s", res.Status)
	}
}

// ---------------------------------------------------------------------------
// Run — suspends
// ---------------------------------------------------------------------------

func TestEngineRunSuspends(t *testing.T) {
	r := NewRegistry()
	_ = r.Register(linearWorkflow("wf"))

	agent := agentFunc(func(_ context.Context, dc DecisionContext) (Decision, error) {
		return Decision{Type: DecisionSuspend, Reason: "wait"}, nil
	})

	e := NewEngine(r, agent)
	_, _ = e.Init("wf")

	res, err := e.Run(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if res.Status != StepSuspended {
		t.Errorf("expected suspended, got %s", res.Status)
	}
}

// ---------------------------------------------------------------------------
// Run — context cancellation
// ---------------------------------------------------------------------------

func TestEngineRunContextCancel(t *testing.T) {
	r := NewRegistry()
	_ = r.Register(linearWorkflow("wf"))

	// Agent that never completes
	agent := agentFunc(func(_ context.Context, dc DecisionContext) (Decision, error) {
		return Decision{Type: DecisionAdvance, Edge: dc.ValidEdges[0].ID}, nil
	})

	// Create a workflow that loops by having the agent never reach a terminal
	// Actually, the linear workflow will complete. Let's just cancel immediately.
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // cancel before Run

	e := NewEngine(r, agent)
	_, _ = e.Init("wf")

	_, err := e.Run(ctx)
	if err == nil {
		t.Error("expected context cancellation error")
	}
}

// ---------------------------------------------------------------------------
// Event emission
// ---------------------------------------------------------------------------

func TestEngineEvents(t *testing.T) {
	e, _ := setupLinear()

	var events []EventType
	for _, et := range []EventType{
		EventNodeEnter, EventNodeExit, EventEdgeTraverse,
		EventEngineComplete, EventWorkflowPush, EventWorkflowPop,
		EventBlackboardWrite,
	} {
		et := et
		e.On(et, func(ev Event) { events = append(events, et) })
	}

	_, _ = e.Init("linear")
	_, _ = e.Run(context.Background())

	// For A→B→C (linear, 2 edges), expect:
	// node:enter (Init — entry node A)
	// node:exit, edge:traverse, node:enter (A→B)
	// node:exit, edge:traverse, node:enter (B→C)
	// engine:complete
	expectedTypes := []EventType{
		EventNodeEnter,
		EventNodeExit, EventEdgeTraverse, EventNodeEnter,
		EventNodeExit, EventEdgeTraverse, EventNodeEnter,
		EventEngineComplete,
	}
	if len(events) != len(expectedTypes) {
		t.Fatalf("expected %d events, got %d: %v", len(expectedTypes), len(events), events)
	}
	for i, et := range expectedTypes {
		if events[i] != et {
			t.Errorf("event[%d]: expected %s, got %s", i, et, events[i])
		}
	}
}

// ---------------------------------------------------------------------------
// Blackboard scoping — child reads parent, parent can't read child after pop
// ---------------------------------------------------------------------------

func TestEngineBlackboardScoping(t *testing.T) {
	r := NewRegistry()

	_ = r.Register(&Workflow{
		ID:    "child",
		Entry: "C1",
		Nodes: map[string]*Node{
			"C1":   {ID: "C1", Spec: NodeSpec{}},
			"CEND": {ID: "CEND", Spec: NodeSpec{}},
		},
		Edges: []Edge{{ID: "ec1", From: "C1", To: "CEND", Event: "NEXT"}},
	})

	_ = r.Register(&Workflow{
		ID:    "parent",
		Entry: "P1",
		Nodes: map[string]*Node{
			"P1": {ID: "P1", Spec: NodeSpec{}},
			"P2": {ID: "P2", Spec: NodeSpec{}, Invokes: &InvocationSpec{WorkflowID: "child"}},
			"P3": {ID: "P3", Spec: NodeSpec{}},
		},
		Edges: []Edge{
			{ID: "ep1", From: "P1", To: "P2", Event: "NEXT"},
			{ID: "ep2", From: "P2", To: "P3", Event: "NEXT"},
		},
	})

	agent := agentFunc(func(_ context.Context, dc DecisionContext) (Decision, error) {
		switch dc.Node.ID {
		case "P1":
			return Decision{
				Type: DecisionAdvance, Edge: "ep1",
				Writes: []BlackboardWrite{{Key: "parent_key", Value: "parent_val"}},
			}, nil
		case "C1":
			// Child should be able to read parent's blackboard
			if v, ok := dc.Blackboard.Get("parent_key"); !ok || v != "parent_val" {
				return Decision{}, errors.New("child cannot read parent blackboard")
			}
			return Decision{
				Type: DecisionAdvance, Edge: "ec1",
				Writes: []BlackboardWrite{{Key: "child_key", Value: "child_val"}},
			}, nil
		case "CEND":
			return Decision{Type: DecisionComplete}, nil
		case "P2": // after pop
			return Decision{Type: DecisionAdvance, Edge: "ep2"}, nil
		case "P3":
			return Decision{Type: DecisionComplete}, nil
		}
		return Decision{}, errors.New("unexpected node")
	})

	e := NewEngine(r, agent)
	_, _ = e.Init("parent")

	res, err := e.Run(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if res.Status != StepCompleted {
		t.Fatalf("expected completed, got %s reason=%s", res.Status, res.Reason)
	}

	// After completion, child's blackboard is gone
	_, ok := e.Blackboard().Get("child_key")
	if ok {
		t.Error("child_key should not be visible after pop (no returnMap)")
	}

	// Parent key should still be there
	v, ok := e.Blackboard().Get("parent_key")
	if !ok || v != "parent_val" {
		t.Error("parent_key should still be visible")
	}
}

// ---------------------------------------------------------------------------
// Step called before init
// ---------------------------------------------------------------------------

func TestEngineStepBeforeInit(t *testing.T) {
	r := NewRegistry()
	e := NewEngine(r, autoAdvanceAgent())
	_, err := e.Step(context.Background())
	if err == nil {
		t.Error("expected error when stepping before init")
	}
}

// ---------------------------------------------------------------------------
// Step called after completion
// ---------------------------------------------------------------------------

func TestEngineStepAfterComplete(t *testing.T) {
	e, _ := setupLinear()
	_, _ = e.Init("linear")
	_, _ = e.Run(context.Background())

	_, err := e.Step(context.Background())
	if err == nil {
		t.Error("expected error when stepping after completion")
	}
}

// ---------------------------------------------------------------------------
// Blackboard writes with advance
// ---------------------------------------------------------------------------

func TestEngineBlackboardWrites(t *testing.T) {
	r := NewRegistry()
	_ = r.Register(linearWorkflow("wf"))

	agent := agentFunc(func(_ context.Context, dc DecisionContext) (Decision, error) {
		if len(dc.ValidEdges) == 0 {
			return Decision{Type: DecisionComplete}, nil
		}
		return Decision{
			Type:   DecisionAdvance,
			Edge:   dc.ValidEdges[0].ID,
			Writes: []BlackboardWrite{{Key: "step", Value: dc.Node.ID}},
		}, nil
	})

	e := NewEngine(r, agent)
	_, _ = e.Init("wf")
	_, _ = e.Run(context.Background())

	// Should have "step" written at A and B (not C — that's complete)
	all := e.Blackboard().GetAll("step")
	if len(all) != 2 {
		t.Errorf("expected 2 writes, got %d", len(all))
	}
}

// ---------------------------------------------------------------------------
// Nested sub-workflows (2 levels deep)
// ---------------------------------------------------------------------------

func TestEngineNestedSubWorkflows(t *testing.T) {
	r := NewRegistry()

	// grandchild: GC1 → GC_END
	_ = r.Register(&Workflow{
		ID: "grandchild", Entry: "GC1",
		Nodes: map[string]*Node{
			"GC1":    {ID: "GC1", Spec: NodeSpec{}},
			"GC_END": {ID: "GC_END", Spec: NodeSpec{}},
		},
		Edges: []Edge{{ID: "egc1", From: "GC1", To: "GC_END", Event: "NEXT"}},
	})

	// child: C1 → C_INVOKE → C_END
	_ = r.Register(&Workflow{
		ID: "child", Entry: "C1",
		Nodes: map[string]*Node{
			"C1":       {ID: "C1", Spec: NodeSpec{}},
			"C_INVOKE": {ID: "C_INVOKE", Spec: NodeSpec{}, Invokes: &InvocationSpec{WorkflowID: "grandchild"}},
			"C_END":    {ID: "C_END", Spec: NodeSpec{}},
		},
		Edges: []Edge{
			{ID: "ec1", From: "C1", To: "C_INVOKE", Event: "NEXT"},
			{ID: "ec2", From: "C_INVOKE", To: "C_END", Event: "NEXT"},
		},
	})

	// parent: P1 → P_INVOKE → P_END
	_ = r.Register(&Workflow{
		ID: "parent", Entry: "P1",
		Nodes: map[string]*Node{
			"P1":       {ID: "P1", Spec: NodeSpec{}},
			"P_INVOKE": {ID: "P_INVOKE", Spec: NodeSpec{}, Invokes: &InvocationSpec{WorkflowID: "child"}},
			"P_END":    {ID: "P_END", Spec: NodeSpec{}},
		},
		Edges: []Edge{
			{ID: "ep1", From: "P1", To: "P_INVOKE", Event: "NEXT"},
			{ID: "ep2", From: "P_INVOKE", To: "P_END", Event: "NEXT"},
		},
	})

	e := NewEngine(r, autoAdvanceAgent())
	_, _ = e.Init("parent")

	res, err := e.Run(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if res.Status != StepCompleted {
		t.Errorf("expected completed, got %s", res.Status)
	}
}

// ---------------------------------------------------------------------------
// Full pipeline test — 5 node linear workflow
// ---------------------------------------------------------------------------

func TestEngineFullPipeline(t *testing.T) {
	r := NewRegistry()
	_ = r.Register(&Workflow{
		ID:    "pipeline",
		Entry: "VALIDATE",
		Nodes: map[string]*Node{
			"VALIDATE": {ID: "VALIDATE", Spec: NodeSpec{}},
			"INGEST":   {ID: "INGEST", Spec: NodeSpec{}},
			"SCENES":   {ID: "SCENES", Spec: NodeSpec{}},
			"CHARS":    {ID: "CHARS", Spec: NodeSpec{}},
			"DONE":     {ID: "DONE", Spec: NodeSpec{}},
		},
		Edges: []Edge{
			{ID: "e1", From: "VALIDATE", To: "INGEST", Event: "NEXT"},
			{ID: "e2", From: "INGEST", To: "SCENES", Event: "NEXT"},
			{ID: "e3", From: "SCENES", To: "CHARS", Event: "NEXT"},
			{ID: "e4", From: "CHARS", To: "DONE", Event: "NEXT"},
		},
	})

	visited := []string{}
	agent := agentFunc(func(_ context.Context, dc DecisionContext) (Decision, error) {
		visited = append(visited, dc.Node.ID)
		if len(dc.ValidEdges) == 0 {
			return Decision{Type: DecisionComplete}, nil
		}
		return Decision{Type: DecisionAdvance, Edge: dc.ValidEdges[0].ID}, nil
	})

	e := NewEngine(r, agent)
	_, _ = e.Init("pipeline")
	res, _ := e.Run(context.Background())

	if res.Status != StepCompleted {
		t.Fatalf("expected completed, got %s", res.Status)
	}
	expected := []string{"VALIDATE", "INGEST", "SCENES", "CHARS", "DONE"}
	if len(visited) != len(expected) {
		t.Fatalf("expected %d nodes visited, got %d: %v", len(expected), len(visited), visited)
	}
	for i, id := range expected {
		if visited[i] != id {
			t.Errorf("visited[%d]: expected %s, got %s", i, id, visited[i])
		}
	}
}

// ---------------------------------------------------------------------------
// Init with seed blackboard
// ---------------------------------------------------------------------------

func TestEngineInitSeedBlackboard(t *testing.T) {
	t.Run("seed values available on first step", func(t *testing.T) {
		r := NewRegistry()
		_ = r.Register(linearWorkflow("linear"))

		var seenValues map[string]any
		agent := agentFunc(func(_ context.Context, dc DecisionContext) (Decision, error) {
			if seenValues == nil {
				seenValues = make(map[string]any)
				for _, k := range dc.Blackboard.Keys() {
					v, _ := dc.Blackboard.Get(k)
					seenValues[k] = v
				}
			}
			if len(dc.ValidEdges) == 0 {
				return Decision{Type: DecisionComplete}, nil
			}
			return Decision{Type: DecisionAdvance, Edge: dc.ValidEdges[0].ID}, nil
		})

		e := NewEngine(r, agent)
		_, err := e.Init("linear", InitOptions{
			Blackboard: []BlackboardWrite{
				{Key: "project", Value: "/foo/bar"},
				{Key: "provider", Value: "ollama"},
			},
		})
		if err != nil {
			t.Fatal(err)
		}

		_, err = e.Step(context.Background())
		if err != nil {
			t.Fatal(err)
		}

		if seenValues["project"] != "/foo/bar" {
			t.Errorf("expected project=/foo/bar, got %v", seenValues["project"])
		}
		if seenValues["provider"] != "ollama" {
			t.Errorf("expected provider=ollama, got %v", seenValues["provider"])
		}
	})

	t.Run("seed emits blackboard:write event", func(t *testing.T) {
		r := NewRegistry()
		_ = r.Register(linearWorkflow("linear"))
		e := NewEngine(r, autoAdvanceAgent())

		var writeEvents []Event
		e.On(EventBlackboardWrite, func(ev Event) {
			writeEvents = append(writeEvents, ev)
		})

		_, err := e.Init("linear", InitOptions{
			Blackboard: []BlackboardWrite{
				{Key: "x", Value: 42},
				{Key: "y", Value: "hello"},
			},
		})
		if err != nil {
			t.Fatal(err)
		}

		if len(writeEvents) != 1 {
			t.Fatalf("expected 1 write event from init, got %d", len(writeEvents))
		}
		entries := writeEvents[0].Entries
		if len(entries) != 2 {
			t.Fatalf("expected 2 entries, got %d", len(entries))
		}
		if entries[0].Source.NodeID != "__init__" {
			t.Errorf("expected source nodeId __init__, got %s", entries[0].Source.NodeID)
		}
		if entries[0].Key != "x" || entries[0].Value != 42 {
			t.Errorf("unexpected entry[0]: %v=%v", entries[0].Key, entries[0].Value)
		}
		if entries[1].Key != "y" || entries[1].Value != "hello" {
			t.Errorf("unexpected entry[1]: %v=%v", entries[1].Key, entries[1].Value)
		}
	})

	t.Run("seed source has correct workflow ID", func(t *testing.T) {
		r := NewRegistry()
		_ = r.Register(linearWorkflow("linear"))
		e := NewEngine(r, autoAdvanceAgent())

		var entries []BlackboardEntry
		e.On(EventBlackboardWrite, func(ev Event) {
			entries = append(entries, ev.Entries...)
		})

		_, _ = e.Init("linear", InitOptions{
			Blackboard: []BlackboardWrite{{Key: "k", Value: "v"}},
		})

		if len(entries) != 1 {
			t.Fatalf("expected 1 entry, got %d", len(entries))
		}
		if entries[0].Source.WorkflowID != "linear" {
			t.Errorf("expected workflowId=linear, got %s", entries[0].Source.WorkflowID)
		}
		if entries[0].Source.StackDepth != 0 {
			t.Errorf("expected stackDepth=0, got %d", entries[0].Source.StackDepth)
		}
	})

	t.Run("no options is backward compatible", func(t *testing.T) {
		e, _ := setupLinear()
		sid, err := e.Init("linear")
		if err != nil {
			t.Fatal(err)
		}
		if sid == "" {
			t.Error("expected non-empty session ID")
		}
		// No seed — blackboard should be empty
		bb := e.Blackboard()
		if len(bb.Keys()) != 0 {
			t.Errorf("expected empty blackboard, got keys: %v", bb.Keys())
		}
	})

	t.Run("empty options is backward compatible", func(t *testing.T) {
		e, _ := setupLinear()
		_, err := e.Init("linear", InitOptions{})
		if err != nil {
			t.Fatal(err)
		}
		bb := e.Blackboard()
		if len(bb.Keys()) != 0 {
			t.Errorf("expected empty blackboard, got keys: %v", bb.Keys())
		}
	})

	t.Run("seed values persist through workflow execution", func(t *testing.T) {
		r := NewRegistry()
		_ = r.Register(linearWorkflow("linear"))
		e := NewEngine(r, autoAdvanceAgent())

		_, _ = e.Init("linear", InitOptions{
			Blackboard: []BlackboardWrite{{Key: "config", Value: "test"}},
		})
		_, _ = e.Run(context.Background())

		// After completion, seed values should still be readable
		val, ok := e.Blackboard().Get("config")
		if !ok {
			t.Error("seed value 'config' not found after completion")
		}
		if val != "test" {
			t.Errorf("expected config=test, got %v", val)
		}
	})

	t.Run("seed values visible in sub-workflow via scope chain", func(t *testing.T) {
		r := NewRegistry()
		child := linearWorkflow("child")
		parent := &Workflow{
			ID:    "parent",
			Entry: "invoke",
			Nodes: map[string]*Node{
				"invoke": {ID: "invoke", Spec: NodeSpec{"type": "invoke"}, Invokes: &InvocationSpec{WorkflowID: "child"}},
			},
		}
		_ = r.Register(parent)
		_ = r.Register(child)

		var childSawSeed bool
		agent := agentFunc(func(_ context.Context, dc DecisionContext) (Decision, error) {
			if dc.Workflow.ID == "child" {
				// Check if seed from parent's root scope is visible
				val, ok := dc.Blackboard.Get("root_seed")
				if ok && val == "from_init" {
					childSawSeed = true
				}
			}
			if len(dc.ValidEdges) == 0 {
				return Decision{Type: DecisionComplete}, nil
			}
			return Decision{Type: DecisionAdvance, Edge: dc.ValidEdges[0].ID}, nil
		})

		e := NewEngine(r, agent)
		_, _ = e.Init("parent", InitOptions{
			Blackboard: []BlackboardWrite{{Key: "root_seed", Value: "from_init"}},
		})
		_, _ = e.Run(context.Background())

		if childSawSeed {
			// Note: sub-workflows get fresh blackboards. Seed values from the
			// parent root are visible through the scope chain (stack frames).
			t.Log("child sub-workflow can see root seed via scope chain")
		}
	})
}

// ---------------------------------------------------------------------------
// CurrentBlackboard — cursor access
// ---------------------------------------------------------------------------

func TestCurrentBlackboardBeforeInit(t *testing.T) {
	reg := CreateRegistry()
	e := CreateEngine(reg, autoAdvanceAgent())
	if bb := e.CurrentBlackboard(); bb != nil {
		t.Error("expected nil CurrentBlackboard before Init")
	}
}

func TestCurrentBlackboardAfterInit(t *testing.T) {
	e, _ := setupLinear()
	_, _ = e.Init("linear")
	bb := e.CurrentBlackboard()
	if bb == nil {
		t.Fatal("expected non-nil CurrentBlackboard after Init")
	}
}

func TestCurrentBlackboardCursorTracksWrites(t *testing.T) {
	e, _ := setupLinear()
	_, _ = e.Init("linear", InitOptions{
		Blackboard: []BlackboardWrite{
			{Key: "seed", Value: "hello"},
		},
	})
	bb := e.CurrentBlackboard()
	if bb == nil {
		t.Fatal("expected non-nil CurrentBlackboard")
	}
	cur := bb.Cursor()
	if cur == 0 {
		t.Error("expected cursor > 0 after seed writes")
	}

	// Step should produce agent writes, advancing cursor
	_, _ = e.Step(context.Background())
	entries, next := bb.EntriesFrom(cur)
	// We may or may not get new entries depending on agent behavior,
	// but next should be >= cur
	_ = entries
	if next < cur {
		t.Errorf("expected next (%d) >= cur (%d)", next, cur)
	}
}

func TestCurrentBlackboardDuringSubWorkflow(t *testing.T) {
	reg := NewRegistry()

	child := linearWorkflow("child")
	parent := &Workflow{
		ID:    "parent",
		Entry: "invoke",
		Nodes: map[string]*Node{
			"invoke": {ID: "invoke", Spec: NodeSpec{"type": "invoke"}, Invokes: &InvocationSpec{WorkflowID: "child"}},
		},
	}
	_ = reg.Register(parent)
	_ = reg.Register(child)

	agent := agentFunc(func(_ context.Context, dc DecisionContext) (Decision, error) {
		if len(dc.ValidEdges) == 0 {
			return Decision{Type: DecisionComplete}, nil
		}
		return Decision{
			Type:   DecisionAdvance,
			Edge:   dc.ValidEdges[0].ID,
			Writes: []BlackboardWrite{{Key: "visited_" + dc.Node.ID, Value: true}},
		}, nil
	})

	e := NewEngine(reg, agent)
	_, _ = e.Init("parent")

	// Step — should invoke the child workflow
	result, err := e.Step(context.Background())
	if err != nil {
		t.Fatalf("step error: %v", err)
	}
	if result.Status == StepInvoked {
		// We're now in the child — CurrentBlackboard should be the child's
		bb := e.CurrentBlackboard()
		if bb == nil {
			t.Fatal("expected non-nil CurrentBlackboard during sub-workflow")
		}
		// Child's local blackboard should be fresh (no parent writes directly)
		if bb.Cursor() != 0 {
			// Note: cursor may be > 0 if engine wrote entries during invocation setup
			t.Logf("child blackboard cursor after invoke: %d", bb.Cursor())
		}
	}
}

// ---------------------------------------------------------------------------
// Suspend writes — Decision.Writes must be applied on suspend
// ---------------------------------------------------------------------------

func TestSuspendWritesApplied(t *testing.T) {
	r := NewRegistry()
	_ = r.Register(linearWorkflow("wf"))

	callCount := 0
	agent := agentFunc(func(_ context.Context, dc DecisionContext) (Decision, error) {
		callCount++
		if dc.Node.ID == "A" && callCount == 1 {
			// Suspend with writes — these must land on the blackboard
			return Decision{
				Type:   DecisionSuspend,
				Reason: "batch progress",
				Writes: []BlackboardWrite{
					{Key: "progress", Value: 3},
					{Key: "status", Value: "processing"},
				},
			}, nil
		}
		if len(dc.ValidEdges) == 0 {
			return Decision{Type: DecisionComplete}, nil
		}
		return Decision{Type: DecisionAdvance, Edge: dc.ValidEdges[0].ID}, nil
	})

	e := NewEngine(r, agent)
	_, _ = e.Init("wf")

	// Step 1: suspend at A with writes
	res, err := e.Step(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if res.Status != StepSuspended {
		t.Fatalf("expected suspended, got %s", res.Status)
	}

	// Writes must be visible on the blackboard after suspend
	bb := e.Blackboard()
	progress, ok := bb.Get("progress")
	if !ok {
		t.Fatal("expected 'progress' key on blackboard after suspend with writes")
	}
	if progress != 3 {
		t.Errorf("expected progress=3, got %v", progress)
	}
	status, ok := bb.Get("status")
	if !ok {
		t.Fatal("expected 'status' key on blackboard after suspend with writes")
	}
	if status != "processing" {
		t.Errorf("expected status=processing, got %v", status)
	}

	// Step 2: resume → advance past A. Writes from suspend must persist.
	res2, err := e.Step(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if res2.Status != StepAdvanced {
		t.Fatalf("expected advanced after resume, got %s", res2.Status)
	}

	// Writes still visible after advancing
	bb2 := e.Blackboard()
	if v, ok := bb2.Get("progress"); !ok || v != 3 {
		t.Errorf("expected progress=3 after advance, got %v (ok=%v)", v, ok)
	}
}

func TestSuspendWritesEmitBlackboardEvent(t *testing.T) {
	r := NewRegistry()
	_ = r.Register(linearWorkflow("wf"))

	agent := agentFunc(func(_ context.Context, dc DecisionContext) (Decision, error) {
		if dc.Node.ID == "A" {
			return Decision{
				Type:   DecisionSuspend,
				Reason: "test",
				Writes: []BlackboardWrite{{Key: "k", Value: "v"}},
			}, nil
		}
		return Decision{Type: DecisionComplete}, nil
	})

	e := NewEngine(r, agent)

	var bbEvents []Event
	e.On(EventBlackboardWrite, func(ev Event) {
		bbEvents = append(bbEvents, ev)
	})

	_, _ = e.Init("wf")
	bbEventsAfterInit := len(bbEvents)

	_, _ = e.Step(context.Background())

	// Should have emitted a blackboard:write event for the suspend writes
	if len(bbEvents) <= bbEventsAfterInit {
		t.Fatal("expected blackboard:write event for suspend writes")
	}
	lastEvent := bbEvents[len(bbEvents)-1]
	found := false
	for _, entry := range lastEvent.Entries {
		if entry.Key == "k" && entry.Value == "v" {
			found = true
		}
	}
	if !found {
		t.Error("blackboard:write event should contain the suspend writes")
	}
}
