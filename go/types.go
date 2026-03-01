// Package reflex provides a Go implementation of the Reflex DAG workflow engine.
//
// Reflex is a DAG-based workflow orchestration framework with call stack
// composition and append-only blackboard semantics. It provides a formally
// characterized execution model (Type 1, context-sensitive) for building
// systems where structured multi-step processes are guided by decision agents.
//
// See DESIGN.md in the repository root for the formal specification.
package reflex

import "context"

// ---------------------------------------------------------------------------
// 2.3 NodeSpec — Opaque to Reflex
// ---------------------------------------------------------------------------

// NodeSpec is a bag of domain-specific data that Reflex carries but never
// inspects. The decision agent receives it and knows how to interpret it.
type NodeSpec = map[string]any

// ---------------------------------------------------------------------------
// 2.5 ReturnMapping
// ---------------------------------------------------------------------------

// ReturnMapping specifies how sub-workflow results flow back to the parent.
// When a sub-workflow completes, the engine copies the child's local blackboard
// value for ChildKey into the parent's local blackboard as ParentKey.
type ReturnMapping struct {
	ParentKey string `json:"parentKey"`
	ChildKey  string `json:"childKey"`
}

// ---------------------------------------------------------------------------
// 2.4 InvocationSpec
// ---------------------------------------------------------------------------

// InvocationSpec declares that a node is a composition point. When the engine
// enters a node with an InvocationSpec, it automatically starts the sub-workflow.
type InvocationSpec struct {
	WorkflowID string          `json:"workflowId"`
	ReturnMap  []ReturnMapping `json:"returnMap"`
}

// ---------------------------------------------------------------------------
// 2.13 Node Contracts (declarations only — not enforced at runtime)
// ---------------------------------------------------------------------------

// NodeInput declares a blackboard key that a node expects to read.
type NodeInput struct {
	Key         string `json:"key"`
	Required    bool   `json:"required"`
	Description string `json:"description,omitempty"`
}

// NodeOutput declares a blackboard key that a node may write.
type NodeOutput struct {
	Key         string `json:"key"`
	Guaranteed  bool   `json:"guaranteed"`
	Description string `json:"description,omitempty"`
}

// ---------------------------------------------------------------------------
// 2.2 Node
// ---------------------------------------------------------------------------

// Node is a single step in a workflow DAG.
type Node struct {
	ID          string          `json:"id"`
	Description string          `json:"description,omitempty"`
	Spec        NodeSpec        `json:"spec"`
	Invokes     *InvocationSpec `json:"invokes,omitempty"`
	Inputs      []NodeInput     `json:"inputs,omitempty"`
	Outputs     []NodeOutput    `json:"outputs,omitempty"`
}

// ---------------------------------------------------------------------------
// 2.8 Guards
// ---------------------------------------------------------------------------

// GuardType identifies the kind of built-in guard.
type GuardType string

const (
	GuardExists    GuardType = "exists"
	GuardNotExists GuardType = "not-exists"
	GuardEquals    GuardType = "equals"
	GuardNotEquals GuardType = "not-equals"
)

// Guard evaluates a condition against the scoped blackboard.
// Guards must be total, terminating, and side-effect free.
type Guard interface {
	Evaluate(bb BlackboardReader) (bool, error)
}

// BuiltinGuard implements Guard for the four built-in types:
// exists, not-exists, equals, not-equals.
type BuiltinGuard struct {
	Type  GuardType `json:"type"`
	Key   string    `json:"key"`
	Value any       `json:"value,omitempty"`
}

// CustomGuardFunc wraps an arbitrary function as a Guard.
// The function must be total, terminating, and side-effect free.
type CustomGuardFunc struct {
	Fn func(BlackboardReader) (bool, error)
}

// ---------------------------------------------------------------------------
// 2.6 Edge
// ---------------------------------------------------------------------------

// Edge connects two nodes in a workflow DAG. An optional guard controls
// whether the edge is valid given the current blackboard state.
type Edge struct {
	ID    string `json:"id"`
	From  string `json:"from"`
	To    string `json:"to"`
	Event string `json:"event"`
	Guard Guard  `json:"-"` // Guards are not JSON-serializable (custom funcs)
}

// ---------------------------------------------------------------------------
// 2.1 Workflow Definition
// ---------------------------------------------------------------------------

// Workflow is a directed acyclic graph of nodes and edges — the program.
type Workflow struct {
	ID       string           `json:"id"`
	Entry    string           `json:"entry"`
	Nodes    map[string]*Node `json:"nodes"`
	Edges    []Edge           `json:"edges"`
	Metadata map[string]any   `json:"metadata,omitempty"`
}

// ---------------------------------------------------------------------------
// 2.7 Blackboard
// ---------------------------------------------------------------------------

// BlackboardSource records the provenance of a blackboard entry.
type BlackboardSource struct {
	WorkflowID string `json:"workflowId"`
	NodeID     string `json:"nodeId"`
	StackDepth int    `json:"stackDepth"`
}

// BlackboardEntry is a single append-only record on the blackboard.
type BlackboardEntry struct {
	Key       string           `json:"key"`
	Value     any              `json:"value"`
	Source    BlackboardSource `json:"source"`
	Timestamp int64            `json:"timestamp"`
}

// InitOptions configures optional parameters for Engine.Init().
type InitOptions struct {
	// Blackboard entries to seed the root workflow's blackboard before the
	// first step executes. Analogous to passing arguments to main().
	// Seed entries are sourced from nodeId "__init__" for traceability.
	Blackboard []BlackboardWrite
}

// BlackboardWrite is a key-value pair to append to the blackboard.
type BlackboardWrite struct {
	Key   string `json:"key"`
	Value any    `json:"value"`
}

// BlackboardReader provides read-only access to the scoped blackboard.
// Reads walk the scope chain: local → parent → grandparent.
type BlackboardReader interface {
	// Get returns the latest value for key in the first scope that contains it.
	Get(key string) (any, bool)
	// Has returns true if key exists in any scope.
	Has(key string) bool
	// GetAll returns all entries for key across all scopes, local-first.
	GetAll(key string) []BlackboardEntry
	// Entries returns all entries across all scopes, local scope first.
	Entries() []BlackboardEntry
	// Keys returns all unique keys across all scopes.
	Keys() []string
	// Local returns only the innermost scope's entries.
	Local() []BlackboardEntry
}

// ---------------------------------------------------------------------------
// 2.9 Call Stack
// ---------------------------------------------------------------------------

// StackFrame captures a suspended workflow context on the call stack.
type StackFrame struct {
	WorkflowID    string           `json:"workflowId"`
	CurrentNodeID string           `json:"currentNodeId"`
	ReturnMap     []ReturnMapping  `json:"returnMap"`
	Blackboard    []BlackboardEntry `json:"blackboard"`
}

// ---------------------------------------------------------------------------
// 2.10 Decision Agent
// ---------------------------------------------------------------------------

// DecisionType identifies the kind of decision returned by an agent.
type DecisionType string

const (
	DecisionAdvance  DecisionType = "advance"
	DecisionSuspend  DecisionType = "suspend"
	DecisionComplete DecisionType = "complete"
)

// Decision is the result of a DecisionAgent.Resolve call.
type Decision struct {
	Type   DecisionType     `json:"type"`
	Edge   string           `json:"edge,omitempty"`
	Writes []BlackboardWrite `json:"writes,omitempty"`
	Reason string           `json:"reason,omitempty"`
}

// DecisionContext provides the agent with everything it needs to make a decision.
type DecisionContext struct {
	Workflow   *Workflow
	Node       *Node
	Blackboard BlackboardReader
	ValidEdges []Edge
	Stack      []StackFrame
}

// DecisionAgent determines what happens at each non-invocation node.
type DecisionAgent interface {
	Resolve(ctx context.Context, dc DecisionContext) (Decision, error)
}

// ---------------------------------------------------------------------------
// 3.2 Step Results and Events
// ---------------------------------------------------------------------------

// StepStatus identifies the outcome of a single engine step.
type StepStatus string

const (
	StepAdvanced  StepStatus = "advanced"
	StepInvoked   StepStatus = "invoked"
	StepPopped    StepStatus = "popped"
	StepCompleted StepStatus = "completed"
	StepSuspended StepStatus = "suspended"
)

// StepResult is returned by Engine.Step().
type StepResult struct {
	Status   StepStatus `json:"status"`
	Node     *Node      `json:"node,omitempty"`
	Workflow *Workflow  `json:"workflow,omitempty"`
	Reason   string     `json:"reason,omitempty"`
}

// EngineStatus represents the lifecycle state of the engine.
type EngineStatus string

const (
	StatusIdle      EngineStatus = "idle"
	StatusRunning   EngineStatus = "running"
	StatusSuspended EngineStatus = "suspended"
	StatusCompleted EngineStatus = "completed"
	StatusError     EngineStatus = "error"
)

// EventType identifies the kind of engine event.
type EventType string

const (
	EventNodeEnter      EventType = "node:enter"
	EventNodeExit       EventType = "node:exit"
	EventEdgeTraverse   EventType = "edge:traverse"
	EventWorkflowPush   EventType = "workflow:push"
	EventWorkflowPop    EventType = "workflow:pop"
	EventBlackboardWrite EventType = "blackboard:write"
	EventEngineComplete EventType = "engine:complete"
	EventEngineSuspend  EventType = "engine:suspend"
	EventEngineError    EventType = "engine:error"
)

// Event carries data about an engine lifecycle event.
type Event struct {
	Type       EventType        `json:"type"`
	SessionID  string           `json:"sessionId,omitempty"`
	WorkflowID string           `json:"workflowId,omitempty"`
	NodeID     string           `json:"nodeId,omitempty"`
	EdgeID     string           `json:"edgeId,omitempty"`
	Entries    []BlackboardEntry `json:"entries,omitempty"`
	Reason     string           `json:"reason,omitempty"`
	Error      error            `json:"-"`
}

// EventHandler is a callback invoked synchronously when an engine event occurs.
type EventHandler func(Event)
