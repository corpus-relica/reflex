package reflex

import (
	"fmt"
	"log"
	"sort"
	"sync"
)

// ---------------------------------------------------------------------------
// Validation Error
// ---------------------------------------------------------------------------

// ValidationErrorCode identifies the kind of workflow validation failure.
type ValidationErrorCode string

const (
	ErrCycleDetected      ValidationErrorCode = "CYCLE_DETECTED"
	ErrInvalidEdge        ValidationErrorCode = "INVALID_EDGE"
	ErrInvalidEntryNode   ValidationErrorCode = "INVALID_ENTRY_NODE"
	ErrNoTerminalNodes    ValidationErrorCode = "NO_TERMINAL_NODES"
	ErrDuplicateWorkflowID ValidationErrorCode = "DUPLICATE_WORKFLOW_ID"
	ErrNodeIDMismatch     ValidationErrorCode = "NODE_ID_MISMATCH"
	ErrEmptyWorkflow          ValidationErrorCode = "EMPTY_WORKFLOW"
	ErrSchemaViolation        ValidationErrorCode = "SCHEMA_VIOLATION"
	ErrUnknownGuardReference  ValidationErrorCode = "UNKNOWN_GUARD_REFERENCE"
	ErrWorkflowNotFound       ValidationErrorCode = "WORKFLOW_NOT_FOUND"
)

// ---------------------------------------------------------------------------
// Verification Types (M8-2: Static Verification)
// ---------------------------------------------------------------------------

// VerificationWarningCode identifies the kind of contract verification warning.
type VerificationWarningCode string

const (
	WarnMissingRequiredInput          VerificationWarningCode = "MISSING_REQUIRED_INPUT"
	WarnReturnMapKeyNotInChildOutputs VerificationWarningCode = "RETURNMAP_KEY_NOT_IN_CHILD_OUTPUTS"
)

// VerificationWarning describes a single contract verification issue.
type VerificationWarning struct {
	Code       VerificationWarningCode
	WorkflowID string
	NodeID     string
	Key        string
	Message    string
}

// VerificationResult is the outcome of verify() — warnings and a valid flag.
type VerificationResult struct {
	WorkflowID string
	Valid       bool
	Warnings   []VerificationWarning
}

// ValidationError is returned when a workflow fails structural validation.
type ValidationError struct {
	Code       ValidationErrorCode
	WorkflowID string
	Message    string
	Details    map[string]any
}

func (e *ValidationError) Error() string {
	return e.Message
}

func newValidationError(code ValidationErrorCode, wfID, msg string) *ValidationError {
	return &ValidationError{Code: code, WorkflowID: wfID, Message: msg}
}

// ---------------------------------------------------------------------------
// Workflow Registry (DESIGN.md Section 3.3)
// ---------------------------------------------------------------------------

// Registry stores validated workflows and provides lookup by ID.
type Registry struct {
	mu        sync.RWMutex
	workflows map[string]*Workflow
}

// NewRegistry creates an empty workflow registry.
func NewRegistry() *Registry {
	return &Registry{workflows: make(map[string]*Workflow)}
}

// Register validates and stores a workflow. Returns a ValidationError on
// structural problems.
func (r *Registry) Register(w *Workflow) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	if err := r.validateNoDuplicate(w); err != nil {
		return err
	}
	if err := validateNotEmpty(w); err != nil {
		return err
	}
	if err := validateEntryNode(w); err != nil {
		return err
	}
	if err := validateNodeIDConsistency(w); err != nil {
		return err
	}
	if err := validateEdgeIntegrity(w); err != nil {
		return err
	}
	if err := validateTerminalNodes(w); err != nil {
		return err
	}
	if err := validateAcyclic(w); err != nil {
		return err
	}
	r.warnInvocationRefs(w)

	r.workflows[w.ID] = w
	return nil
}

// Get returns the workflow with the given ID, or false if not found.
func (r *Registry) Get(id string) (*Workflow, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	w, ok := r.workflows[id]
	return w, ok
}

// Has returns true if a workflow with the given ID is registered.
func (r *Registry) Has(id string) bool {
	r.mu.RLock()
	defer r.mu.RUnlock()
	_, ok := r.workflows[id]
	return ok
}

// List returns all registered workflow IDs in sorted order.
func (r *Registry) List() []string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	ids := make([]string, 0, len(r.workflows))
	for id := range r.workflows {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

// Verify checks node contracts against DAG structure. Opt-in static analysis.
func (r *Registry) Verify(workflowID string) (VerificationResult, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()

	w, ok := r.workflows[workflowID]
	if !ok {
		return VerificationResult{}, newValidationError(ErrWorkflowNotFound, workflowID,
			fmt.Sprintf("cannot verify: workflow '%s' is not registered", workflowID))
	}

	var warnings []VerificationWarning
	warnings = append(warnings, verifyInputContracts(w)...)
	warnings = append(warnings, verifyReturnMaps(w, r)...)

	return VerificationResult{
		WorkflowID: workflowID,
		Valid:      len(warnings) == 0,
		Warnings:   warnings,
	}, nil
}

// ---------------------------------------------------------------------------
// Verification helpers
// ---------------------------------------------------------------------------

func topologicalOrderOf(w *Workflow) []string {
	inDegree := make(map[string]int)
	adjList := make(map[string][]string)
	for id := range w.Nodes {
		inDegree[id] = 0
		adjList[id] = nil
	}
	for _, edge := range w.Edges {
		adjList[edge.From] = append(adjList[edge.From], edge.To)
		inDegree[edge.To]++
	}

	queue := make([]string, 0)
	for id, deg := range inDegree {
		if deg == 0 {
			queue = append(queue, id)
		}
	}

	var order []string
	for len(queue) > 0 {
		node := queue[0]
		queue = queue[1:]
		order = append(order, node)
		for _, neighbor := range adjList[node] {
			inDegree[neighbor]--
			if inDegree[neighbor] == 0 {
				queue = append(queue, neighbor)
			}
		}
	}
	return order
}

func terminalNodeIDsOf(w *Workflow) map[string]bool {
	withOutgoing := make(map[string]bool)
	for _, edge := range w.Edges {
		withOutgoing[edge.From] = true
	}
	terminals := make(map[string]bool)
	for id := range w.Nodes {
		if !withOutgoing[id] {
			terminals[id] = true
		}
	}
	return terminals
}

func verifyInputContracts(w *Workflow) []VerificationWarning {
	var warnings []VerificationWarning
	order := topologicalOrderOf(w)
	producedKeys := make(map[string]bool)

	for _, nodeID := range order {
		node := w.Nodes[nodeID]

		for _, input := range node.Inputs {
			if input.Required && !producedKeys[input.Key] {
				warnings = append(warnings, VerificationWarning{
					Code:       WarnMissingRequiredInput,
					WorkflowID: w.ID,
					NodeID:     nodeID,
					Key:        input.Key,
					Message:    fmt.Sprintf("node '%s' requires input '%s' but no upstream node declares it as an output", nodeID, input.Key),
				})
			}
		}

		for _, output := range node.Outputs {
			producedKeys[output.Key] = true
		}
	}
	return warnings
}

func verifyReturnMaps(w *Workflow, r *Registry) []VerificationWarning {
	var warnings []VerificationWarning

	for nodeID, node := range w.Nodes {
		if node.Invokes == nil {
			continue
		}
		subWf, ok := r.workflows[node.Invokes.WorkflowID]
		if !ok {
			continue
		}

		terminals := terminalNodeIDsOf(subWf)
		childOutputKeys := make(map[string]bool)
		anyTerminalHasOutputs := false

		for termID := range terminals {
			terminal := subWf.Nodes[termID]
			if len(terminal.Outputs) > 0 {
				anyTerminalHasOutputs = true
				for _, output := range terminal.Outputs {
					childOutputKeys[output.Key] = true
				}
			}
		}

		if !anyTerminalHasOutputs {
			continue
		}

		for _, mapping := range node.Invokes.ReturnMap {
			if !childOutputKeys[mapping.ChildKey] {
				warnings = append(warnings, VerificationWarning{
					Code:       WarnReturnMapKeyNotInChildOutputs,
					WorkflowID: w.ID,
					NodeID:     nodeID,
					Key:        mapping.ChildKey,
					Message:    fmt.Sprintf("node '%s' returnMap references child key '%s' not declared in sub-workflow '%s' terminal outputs", nodeID, mapping.ChildKey, node.Invokes.WorkflowID),
				})
			}
		}
	}
	return warnings
}

// ---------------------------------------------------------------------------
// Validation — private methods
// ---------------------------------------------------------------------------

func (r *Registry) validateNoDuplicate(w *Workflow) error {
	if _, exists := r.workflows[w.ID]; exists {
		return newValidationError(ErrDuplicateWorkflowID, w.ID,
			fmt.Sprintf("workflow '%s' is already registered", w.ID))
	}
	return nil
}

func validateNotEmpty(w *Workflow) error {
	if len(w.Nodes) == 0 {
		return newValidationError(ErrEmptyWorkflow, w.ID,
			fmt.Sprintf("workflow '%s' has no nodes", w.ID))
	}
	return nil
}

func validateEntryNode(w *Workflow) error {
	if _, exists := w.Nodes[w.Entry]; !exists {
		return newValidationError(ErrInvalidEntryNode, w.ID,
			fmt.Sprintf("workflow '%s' declares entry node '%s' which does not exist", w.ID, w.Entry))
	}
	return nil
}

func validateNodeIDConsistency(w *Workflow) error {
	for key, node := range w.Nodes {
		if key != node.ID {
			return newValidationError(ErrNodeIDMismatch, w.ID,
				fmt.Sprintf("workflow '%s': node dict key '%s' != node.ID '%s'", w.ID, key, node.ID))
		}
	}
	return nil
}

func validateEdgeIntegrity(w *Workflow) error {
	for _, edge := range w.Edges {
		if _, exists := w.Nodes[edge.From]; !exists {
			return newValidationError(ErrInvalidEdge, w.ID,
				fmt.Sprintf("workflow '%s': edge '%s' references non-existent source '%s'", w.ID, edge.ID, edge.From))
		}
		if _, exists := w.Nodes[edge.To]; !exists {
			return newValidationError(ErrInvalidEdge, w.ID,
				fmt.Sprintf("workflow '%s': edge '%s' references non-existent target '%s'", w.ID, edge.ID, edge.To))
		}
	}
	return nil
}

func validateTerminalNodes(w *Workflow) error {
	nodesWithOutgoing := make(map[string]bool)
	for _, edge := range w.Edges {
		nodesWithOutgoing[edge.From] = true
	}
	hasTerminal := false
	for id := range w.Nodes {
		if !nodesWithOutgoing[id] {
			hasTerminal = true
			break
		}
	}
	if !hasTerminal {
		return newValidationError(ErrNoTerminalNodes, w.ID,
			fmt.Sprintf("workflow '%s' has no terminal nodes", w.ID))
	}
	return nil
}

// validateAcyclic uses Kahn's algorithm for topological sort. O(V+E).
func validateAcyclic(w *Workflow) error {
	inDegree := make(map[string]int)
	adjList := make(map[string][]string)
	for id := range w.Nodes {
		inDegree[id] = 0
		adjList[id] = nil
	}
	for _, edge := range w.Edges {
		adjList[edge.From] = append(adjList[edge.From], edge.To)
		inDegree[edge.To]++
	}

	queue := make([]string, 0)
	for id, deg := range inDegree {
		if deg == 0 {
			queue = append(queue, id)
		}
	}

	sorted := 0
	for len(queue) > 0 {
		node := queue[0]
		queue = queue[1:]
		sorted++
		for _, neighbor := range adjList[node] {
			inDegree[neighbor]--
			if inDegree[neighbor] == 0 {
				queue = append(queue, neighbor)
			}
		}
	}

	if sorted != len(w.Nodes) {
		var cycleNodes []string
		for id, deg := range inDegree {
			if deg > 0 {
				cycleNodes = append(cycleNodes, id)
			}
		}
		return newValidationError(ErrCycleDetected, w.ID,
			fmt.Sprintf("workflow '%s' contains a cycle involving nodes: %v", w.ID, cycleNodes))
	}
	return nil
}

func (r *Registry) warnInvocationRefs(w *Workflow) {
	for nodeID, node := range w.Nodes {
		if node.Invokes != nil {
			if _, exists := r.workflows[node.Invokes.WorkflowID]; !exists {
				log.Printf("workflow '%s', node '%s': invokes '%s' which is not yet registered",
					w.ID, nodeID, node.Invokes.WorkflowID)
			}
		}
	}
}
