package reflex

import (
	"context"
	"crypto/rand"
	"fmt"
	"encoding/hex"
)

// EngineError represents an error from the execution engine.
type EngineError struct {
	Message string
}

func (e *EngineError) Error() string { return e.Message }

// Engine is the Reflex execution engine. It steps through workflow DAGs,
// manages the call stack for sub-workflow composition, and emits events.
//
// See DESIGN.md Section 3.2.
type Engine struct {
	registry *Registry
	agent    DecisionAgent

	sessionID        string
	status           EngineStatus
	currentWorkflowID string
	currentNodeID    string
	currentBlackboard *ScopedBlackboard
	stack            []StackFrame
	skipInvocation   bool

	handlers map[EventType][]EventHandler
}

// NewEngine creates an engine bound to a registry and decision agent.
func NewEngine(registry *Registry, agent DecisionAgent) *Engine {
	return &Engine{
		registry: registry,
		agent:    agent,
		status:   StatusIdle,
		handlers: make(map[EventType][]EventHandler),
	}
}

// On registers an event handler for the given event type.
func (e *Engine) On(event EventType, handler EventHandler) {
	e.handlers[event] = append(e.handlers[event], handler)
}

// Init initializes a new session for the given workflow.
// An optional InitOptions may be provided to seed the root blackboard
// before the first step executes.
// Returns the session ID.
func (e *Engine) Init(workflowID string, opts ...InitOptions) (string, error) {
	w, ok := e.registry.Get(workflowID)
	if !ok {
		return "", &EngineError{Message: fmt.Sprintf("cannot initialize: workflow '%s' is not registered", workflowID)}
	}

	e.sessionID = generateUUID()
	e.currentWorkflowID = workflowID
	e.currentNodeID = w.Entry
	e.currentBlackboard = NewBlackboard()
	e.stack = nil
	e.skipInvocation = false
	e.status = StatusRunning

	// Apply seed blackboard entries if provided
	if len(opts) > 0 && len(opts[0].Blackboard) > 0 {
		seedSource := BlackboardSource{
			WorkflowID: workflowID,
			NodeID:     "__init__",
			StackDepth: 0,
		}
		seedEntries := e.currentBlackboard.Append(opts[0].Blackboard, seedSource)
		e.emit(EventBlackboardWrite, Event{
			Type:       EventBlackboardWrite,
			Entries:    seedEntries,
			WorkflowID: workflowID,
		})
	}

	// Emit node:enter for the entry node so every node:exit in the first
	// step() has a matching node:enter.
	entryNode := w.Nodes[w.Entry]
	e.emit(EventNodeEnter, Event{
		Type:       EventNodeEnter,
		NodeID:     entryNode.ID,
		WorkflowID: workflowID,
	})

	return e.sessionID, nil
}

// Step executes one iteration of the execution loop.
func (e *Engine) Step(ctx context.Context) (StepResult, error) {
	// Precondition guards
	if e.status != StatusRunning && e.status != StatusSuspended {
		return StepResult{}, &EngineError{
			Message: fmt.Sprintf("step() called in invalid state: '%s'", e.status),
		}
	}
	if e.currentBlackboard == nil {
		return StepResult{}, &EngineError{Message: "step() called before init()"}
	}
	if e.status == StatusSuspended {
		e.status = StatusRunning
	}

	w, _ := e.registry.Get(e.currentWorkflowID)
	node := w.Nodes[e.currentNodeID]

	// -- Invocation node handling --
	if node.Invokes != nil && !e.skipInvocation {
		subW, ok := e.registry.Get(node.Invokes.WorkflowID)
		if !ok {
			e.status = StatusSuspended
			e.emit(EventEngineError, Event{
				Type:   EventEngineError,
				NodeID: e.currentNodeID,
				Reason: fmt.Sprintf("sub-workflow '%s' not found", node.Invokes.WorkflowID),
			})
			return StepResult{
				Status: StepSuspended,
				Reason: fmt.Sprintf("sub-workflow '%s' not found", node.Invokes.WorkflowID),
			}, nil
		}

		// Push current frame
		frame := StackFrame{
			WorkflowID:    e.currentWorkflowID,
			CurrentNodeID: e.currentNodeID,
			ReturnMap:     node.Invokes.ReturnMap,
			Blackboard:    e.currentBlackboard.Entries(),
		}
		e.stack = append([]StackFrame{frame}, e.stack...)

		// Start sub-workflow
		e.currentWorkflowID = subW.ID
		e.currentNodeID = subW.Entry
		e.currentBlackboard = NewBlackboard()

		e.emit(EventWorkflowPush, Event{Type: EventWorkflowPush, WorkflowID: subW.ID})
		entryNode := subW.Nodes[subW.Entry]
		e.emit(EventNodeEnter, Event{Type: EventNodeEnter, NodeID: entryNode.ID, WorkflowID: subW.ID})

		return StepResult{Status: StepInvoked, Workflow: subW, Node: entryNode}, nil
	}
	e.skipInvocation = false

	// -- Guard evaluation --
	reader := e.buildBlackboardReader()
	validEdges, err := FilterEdges(e.currentNodeID, w.Edges, reader)
	if err != nil {
		e.status = StatusSuspended
		e.emit(EventEngineError, Event{Type: EventEngineError, NodeID: e.currentNodeID, Reason: err.Error()})
		return StepResult{Status: StepSuspended, Reason: "guard evaluation error"}, nil
	}

	// -- Build DecisionContext and call agent --
	dc := DecisionContext{
		Workflow:   w,
		Node:       node,
		Blackboard: reader,
		ValidEdges: validEdges,
		Stack:      e.stackSnapshot(),
	}

	decision, err := e.agent.Resolve(ctx, dc)
	if err != nil {
		e.status = StatusSuspended
		e.emit(EventEngineError, Event{Type: EventEngineError, NodeID: e.currentNodeID, Reason: err.Error()})
		return StepResult{Status: StepSuspended, Reason: "decision agent error"}, nil
	}

	// -- Handle advance --
	if decision.Type == DecisionAdvance {
		var chosenEdge *Edge
		for i := range validEdges {
			if validEdges[i].ID == decision.Edge {
				chosenEdge = &validEdges[i]
				break
			}
		}
		if chosenEdge == nil {
			e.status = StatusSuspended
			e.emit(EventEngineError, Event{
				Type:   EventEngineError,
				NodeID: e.currentNodeID,
				Reason: fmt.Sprintf("invalid edge '%s'", decision.Edge),
			})
			return StepResult{Status: StepSuspended, Reason: "invalid edge selection"}, nil
		}

		e.emit(EventNodeExit, Event{Type: EventNodeExit, NodeID: e.currentNodeID, WorkflowID: e.currentWorkflowID})
		e.emit(EventEdgeTraverse, Event{Type: EventEdgeTraverse, EdgeID: chosenEdge.ID, WorkflowID: e.currentWorkflowID})

		if len(decision.Writes) > 0 {
			source := BlackboardSource{WorkflowID: e.currentWorkflowID, NodeID: e.currentNodeID, StackDepth: len(e.stack)}
			newEntries := e.currentBlackboard.Append(decision.Writes, source)
			e.emit(EventBlackboardWrite, Event{Type: EventBlackboardWrite, Entries: newEntries, WorkflowID: e.currentWorkflowID})
		}

		e.currentNodeID = chosenEdge.To
		nextNode := w.Nodes[chosenEdge.To]
		e.emit(EventNodeEnter, Event{Type: EventNodeEnter, NodeID: nextNode.ID, WorkflowID: e.currentWorkflowID})

		return StepResult{Status: StepAdvanced, Node: nextNode}, nil
	}

	// -- Handle suspend --
	if decision.Type == DecisionSuspend {
		e.status = StatusSuspended
		e.emit(EventEngineSuspend, Event{Type: EventEngineSuspend, Reason: decision.Reason, NodeID: e.currentNodeID})
		return StepResult{Status: StepSuspended, Reason: decision.Reason}, nil
	}

	// -- Handle complete --
	hasOutgoing := false
	for _, edge := range w.Edges {
		if edge.From == e.currentNodeID {
			hasOutgoing = true
			break
		}
	}
	if hasOutgoing {
		e.status = StatusSuspended
		e.emit(EventEngineError, Event{
			Type:   EventEngineError,
			NodeID: e.currentNodeID,
			Reason: "complete at non-terminal node",
		})
		return StepResult{Status: StepSuspended, Reason: "complete at non-terminal node"}, nil
	}

	if len(decision.Writes) > 0 {
		source := BlackboardSource{WorkflowID: e.currentWorkflowID, NodeID: e.currentNodeID, StackDepth: len(e.stack)}
		newEntries := e.currentBlackboard.Append(decision.Writes, source)
		e.emit(EventBlackboardWrite, Event{Type: EventBlackboardWrite, Entries: newEntries, WorkflowID: e.currentWorkflowID})
	}

	// Root workflow complete
	if len(e.stack) == 0 {
		e.status = StatusCompleted
		e.emit(EventEngineComplete, Event{Type: EventEngineComplete, WorkflowID: e.currentWorkflowID})
		return StepResult{Status: StepCompleted}, nil
	}

	// -- Stack pop: sub-workflow done, return to parent --
	childBB := e.currentBlackboard
	frame := e.stack[0]
	e.stack = e.stack[1:]

	parentBB := NewBlackboard(frame.Blackboard...)
	returnSource := BlackboardSource{
		WorkflowID: frame.WorkflowID,
		NodeID:     frame.CurrentNodeID,
		StackDepth: len(e.stack),
	}

	// Execute returnMap
	childReader := childBB.Reader()
	for _, mapping := range frame.ReturnMap {
		val, ok := childReader.Get(mapping.ChildKey)
		if ok {
			newEntries := parentBB.Append(
				[]BlackboardWrite{{Key: mapping.ParentKey, Value: val}},
				returnSource,
			)
			parentW, _ := e.registry.Get(frame.WorkflowID)
			e.emit(EventBlackboardWrite, Event{
				Type: EventBlackboardWrite, Entries: newEntries,
				WorkflowID: parentW.ID,
			})
		}
	}

	e.currentWorkflowID = frame.WorkflowID
	e.currentNodeID = frame.CurrentNodeID
	e.currentBlackboard = parentBB
	e.skipInvocation = true

	parentW, _ := e.registry.Get(frame.WorkflowID)
	invokingNode := parentW.Nodes[frame.CurrentNodeID]

	e.emit(EventWorkflowPop, Event{Type: EventWorkflowPop, WorkflowID: parentW.ID})
	e.emit(EventNodeEnter, Event{Type: EventNodeEnter, NodeID: invokingNode.ID, WorkflowID: parentW.ID})

	return StepResult{Status: StepPopped, Workflow: parentW, Node: invokingNode}, nil
}

// Run steps until completion, suspension, or context cancellation.
func (e *Engine) Run(ctx context.Context) (StepResult, error) {
	for {
		select {
		case <-ctx.Done():
			return StepResult{}, ctx.Err()
		default:
		}

		result, err := e.Step(ctx)
		if err != nil {
			return result, err
		}
		if result.Status == StepCompleted || result.Status == StepSuspended {
			return result, nil
		}
	}
}

// ---------------------------------------------------------------------------
// State Inspection
// ---------------------------------------------------------------------------

// SessionID returns the current session ID.
func (e *Engine) SessionID() string { return e.sessionID }

// Status returns the engine's current lifecycle state.
func (e *Engine) Status() EngineStatus { return e.status }

// CurrentNode returns the current node, or nil if not initialized.
func (e *Engine) CurrentNode() *Node {
	if e.currentWorkflowID == "" || e.currentNodeID == "" {
		return nil
	}
	w, ok := e.registry.Get(e.currentWorkflowID)
	if !ok {
		return nil
	}
	return w.Nodes[e.currentNodeID]
}

// CurrentWorkflow returns the current workflow, or nil if not initialized.
func (e *Engine) CurrentWorkflow() *Workflow {
	if e.currentWorkflowID == "" {
		return nil
	}
	w, _ := e.registry.Get(e.currentWorkflowID)
	return w
}

// Blackboard returns a BlackboardReader over the current scope chain.
func (e *Engine) Blackboard() BlackboardReader {
	return e.buildBlackboardReader()
}

// CurrentBlackboard returns a read-only cursor interface for the active
// workflow's blackboard. During sub-workflow execution, this returns the
// child workflow's blackboard (not the parent's).
//
// Use this for cursor-based incremental reads (e.g., streaming
// persistence). For scoped reads across the full call stack, use
// Blackboard() instead. Returns nil if no session is active.
func (e *Engine) CurrentBlackboard() CursorReader {
	if e.currentBlackboard == nil {
		return nil
	}
	return e.currentBlackboard
}

// Stack returns a snapshot of the call stack.
func (e *Engine) Stack() []StackFrame {
	return e.stackSnapshot()
}

// ValidEdges returns the currently valid outgoing edges.
func (e *Engine) ValidEdges() []Edge {
	w := e.CurrentWorkflow()
	if w == nil || e.currentNodeID == "" {
		return nil
	}
	edges, _ := FilterEdges(e.currentNodeID, w.Edges, e.buildBlackboardReader())
	return edges
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

func (e *Engine) emit(eventType EventType, event Event) {
	event.SessionID = e.sessionID
	for _, h := range e.handlers[eventType] {
		h(event)
	}
}

func (e *Engine) buildBlackboardReader() BlackboardReader {
	if e.currentBlackboard == nil {
		return NewBlackboardReader(nil)
	}
	parentScopes := make([][]BlackboardEntry, len(e.stack))
	for i, frame := range e.stack {
		cp := make([]BlackboardEntry, len(frame.Blackboard))
		copy(cp, frame.Blackboard)
		parentScopes[i] = cp
	}
	return e.currentBlackboard.Reader(parentScopes...)
}

func (e *Engine) stackSnapshot() []StackFrame {
	cp := make([]StackFrame, len(e.stack))
	copy(cp, e.stack)
	return cp
}

func generateUUID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	b[6] = (b[6] & 0x0f) | 0x40 // version 4
	b[8] = (b[8] & 0x3f) | 0x80 // variant 2
	return fmt.Sprintf("%s-%s-%s-%s-%s",
		hex.EncodeToString(b[0:4]),
		hex.EncodeToString(b[4:6]),
		hex.EncodeToString(b[6:8]),
		hex.EncodeToString(b[8:10]),
		hex.EncodeToString(b[10:16]),
	)
}
