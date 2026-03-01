package reflex

import (
	"encoding/json"
	"fmt"
)

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

// GuardRegistry maps guard names (from JSON) to Guard implementations.
type GuardRegistry map[string]Guard

// LoadWorkflowOptions configures optional parameters for LoadWorkflow.
type LoadWorkflowOptions struct {
	Guards GuardRegistry
}

// ---------------------------------------------------------------------------
// Intermediate JSON types (for edges with guards)
// ---------------------------------------------------------------------------

type jsonWorkflow struct {
	Schema   string             `json:"$schema"`
	ID       string             `json:"id"`
	Entry    string             `json:"entry"`
	Nodes    map[string]*Node   `json:"nodes"`
	Edges    []jsonEdge         `json:"edges"`
	Metadata map[string]any     `json:"metadata"`
}

type jsonEdge struct {
	ID    string           `json:"id"`
	From  string           `json:"from"`
	To    string           `json:"to"`
	Event string           `json:"event"`
	Guard json.RawMessage  `json:"guard,omitempty"`
}

// ---------------------------------------------------------------------------
// LoadWorkflow
// ---------------------------------------------------------------------------

// LoadWorkflow parses and validates a JSON workflow definition, returning a
// typed Workflow with guards resolved. Custom guard names are resolved against
// the GuardRegistry in opts.
func LoadWorkflow(data []byte, opts *LoadWorkflowOptions) (*Workflow, error) {
	var jw jsonWorkflow
	if err := json.Unmarshal(data, &jw); err != nil {
		return nil, newValidationError(ErrSchemaViolation, "<unknown>",
			fmt.Sprintf("invalid JSON: %v", err))
	}

	// Validate required top-level fields
	if jw.ID == "" {
		return nil, newValidationError(ErrSchemaViolation, "<unknown>",
			"missing required field: id")
	}
	if jw.Entry == "" {
		return nil, newValidationError(ErrSchemaViolation, jw.ID,
			"missing required field: entry")
	}
	if jw.Nodes == nil {
		return nil, newValidationError(ErrSchemaViolation, jw.ID,
			"missing required field: nodes")
	}
	if jw.Edges == nil {
		return nil, newValidationError(ErrSchemaViolation, jw.ID,
			"missing required field: edges")
	}

	// Validate nodes
	for key, node := range jw.Nodes {
		if node.ID == "" {
			return nil, newValidationError(ErrSchemaViolation, jw.ID,
				fmt.Sprintf("node '%s': missing required field: id", key))
		}
		if node.Spec == nil {
			return nil, newValidationError(ErrSchemaViolation, jw.ID,
				fmt.Sprintf("node '%s': missing required field: spec", key))
		}
	}

	// Process edges and resolve guards
	edges := make([]Edge, len(jw.Edges))
	for i, je := range jw.Edges {
		if je.ID == "" {
			return nil, newValidationError(ErrSchemaViolation, jw.ID,
				fmt.Sprintf("edge at index %d: missing required field: id", i))
		}
		if je.From == "" {
			return nil, newValidationError(ErrSchemaViolation, jw.ID,
				fmt.Sprintf("edge '%s': missing required field: from", je.ID))
		}
		if je.To == "" {
			return nil, newValidationError(ErrSchemaViolation, jw.ID,
				fmt.Sprintf("edge '%s': missing required field: to", je.ID))
		}
		if je.Event == "" {
			return nil, newValidationError(ErrSchemaViolation, jw.ID,
				fmt.Sprintf("edge '%s': missing required field: event", je.ID))
		}

		edge := Edge{
			ID:    je.ID,
			From:  je.From,
			To:    je.To,
			Event: je.Event,
		}

		if len(je.Guard) > 0 {
			guard, err := resolveGuardJSON(je.Guard, jw.ID, je.ID, opts)
			if err != nil {
				return nil, err
			}
			edge.Guard = guard
		}

		edges[i] = edge
	}

	return &Workflow{
		ID:       jw.ID,
		Entry:    jw.Entry,
		Nodes:    jw.Nodes,
		Edges:    edges,
		Metadata: jw.Metadata,
	}, nil
}

// ---------------------------------------------------------------------------
// Guard resolution
// ---------------------------------------------------------------------------

func resolveGuardJSON(raw json.RawMessage, wfID, edgeID string, opts *LoadWorkflowOptions) (Guard, error) {
	var gm map[string]any
	if err := json.Unmarshal(raw, &gm); err != nil {
		return nil, newValidationError(ErrSchemaViolation, wfID,
			fmt.Sprintf("edge '%s': invalid guard JSON: %v", edgeID, err))
	}

	typ, ok := gm["type"].(string)
	if !ok {
		return nil, newValidationError(ErrSchemaViolation, wfID,
			fmt.Sprintf("edge '%s': guard missing or invalid 'type' field", edgeID))
	}

	switch typ {
	case "exists", "not-exists":
		key, ok := gm["key"].(string)
		if !ok {
			return nil, newValidationError(ErrSchemaViolation, wfID,
				fmt.Sprintf("edge '%s': guard type '%s' requires 'key' field", edgeID, typ))
		}
		return &BuiltinGuard{Type: GuardType(typ), Key: key}, nil

	case "equals", "not-equals":
		key, ok := gm["key"].(string)
		if !ok {
			return nil, newValidationError(ErrSchemaViolation, wfID,
				fmt.Sprintf("edge '%s': guard type '%s' requires 'key' field", edgeID, typ))
		}
		// value is required but may be null
		value, hasValue := gm["value"]
		if !hasValue {
			return nil, newValidationError(ErrSchemaViolation, wfID,
				fmt.Sprintf("edge '%s': guard type '%s' requires 'value' field", edgeID, typ))
		}
		return &BuiltinGuard{Type: GuardType(typ), Key: key, Value: value}, nil

	case "custom":
		name, ok := gm["name"].(string)
		if !ok {
			return nil, newValidationError(ErrSchemaViolation, wfID,
				fmt.Sprintf("edge '%s': custom guard requires 'name' field", edgeID))
		}
		if opts == nil || opts.Guards == nil || opts.Guards[name] == nil {
			return nil, newValidationError(ErrUnknownGuardReference, wfID,
				fmt.Sprintf("edge '%s': custom guard '%s' not found in guard registry", edgeID, name))
		}
		return opts.Guards[name], nil

	default:
		return nil, newValidationError(ErrSchemaViolation, wfID,
			fmt.Sprintf("edge '%s': unknown guard type '%s'", edgeID, typ))
	}
}
