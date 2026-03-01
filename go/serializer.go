package reflex

import (
	"encoding/json"
	"fmt"
)

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

// GuardNameMap maps Guard implementations back to their JSON names for
// serialization. This is the inverse of GuardRegistry used by LoadWorkflow.
type GuardNameMap map[Guard]string

// SerializeWorkflowOptions configures optional parameters for SerializeWorkflow.
type SerializeWorkflowOptions struct {
	GuardNames GuardNameMap
}

// ---------------------------------------------------------------------------
// Intermediate JSON types (for edges with guards)
// ---------------------------------------------------------------------------

type jsonGuardOut struct {
	Type  string `json:"type"`
	Key   string `json:"key,omitempty"`
	Value any    `json:"value,omitempty"`
	Name  string `json:"name,omitempty"`
}

type jsonEdgeOut struct {
	ID    string        `json:"id"`
	From  string        `json:"from"`
	To    string        `json:"to"`
	Event string        `json:"event"`
	Guard *jsonGuardOut `json:"guard,omitempty"`
}

// ---------------------------------------------------------------------------
// SerializeWorkflow
// ---------------------------------------------------------------------------

// SerializeWorkflow produces a JSON representation of a Workflow.
// BuiltinGuards serialize directly. CustomGuardFuncs require a GuardNameMap
// in opts to recover the JSON { type: "custom", name: "..." } representation.
func SerializeWorkflow(wf *Workflow, opts *SerializeWorkflowOptions) ([]byte, error) {
	edges := make([]jsonEdgeOut, len(wf.Edges))
	for i, e := range wf.Edges {
		je := jsonEdgeOut{
			ID:    e.ID,
			From:  e.From,
			To:    e.To,
			Event: e.Event,
		}
		if e.Guard != nil {
			g, err := serializeGuard(e.Guard, wf.ID, e.ID, opts)
			if err != nil {
				return nil, err
			}
			je.Guard = g
		}
		edges[i] = je
	}

	out := struct {
		ID       string           `json:"id"`
		Entry    string           `json:"entry"`
		Nodes    map[string]*Node `json:"nodes"`
		Edges    []jsonEdgeOut    `json:"edges"`
		Metadata map[string]any   `json:"metadata,omitempty"`
	}{
		ID:       wf.ID,
		Entry:    wf.Entry,
		Nodes:    wf.Nodes,
		Edges:    edges,
		Metadata: wf.Metadata,
	}

	return json.MarshalIndent(out, "", "  ")
}

// ---------------------------------------------------------------------------
// Guard serialization
// ---------------------------------------------------------------------------

func serializeGuard(g Guard, wfID, edgeID string, opts *SerializeWorkflowOptions) (*jsonGuardOut, error) {
	switch guard := g.(type) {
	case *BuiltinGuard:
		out := &jsonGuardOut{
			Type: string(guard.Type),
			Key:  guard.Key,
		}
		if guard.Type == GuardEquals || guard.Type == GuardNotEquals {
			out.Value = guard.Value
		}
		return out, nil

	case *CustomGuardFunc:
		if opts == nil || opts.GuardNames == nil {
			return nil, newValidationError(ErrSchemaViolation, wfID,
				fmt.Sprintf("edge '%s': custom guard has no name in GuardNames map (cannot serialize)", edgeID))
		}
		name, ok := opts.GuardNames[g]
		if !ok {
			return nil, newValidationError(ErrSchemaViolation, wfID,
				fmt.Sprintf("edge '%s': custom guard has no name in GuardNames map (cannot serialize)", edgeID))
		}
		return &jsonGuardOut{Type: "custom", Name: name}, nil

	default:
		return nil, newValidationError(ErrSchemaViolation, wfID,
			fmt.Sprintf("edge '%s': unknown guard type %T (cannot serialize)", edgeID, g))
	}
}
