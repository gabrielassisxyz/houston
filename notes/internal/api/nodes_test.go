package api

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"testing"

	"github.com/gabrielassisxyz/houston/notes/internal/graph"
	"github.com/gabrielassisxyz/houston/notes/internal/graph/nodes"
)

func TestListNodes(t *testing.T) {
	d := newTestDeps(t, "")
	// Seed a note
	ctx := context.Background()
	_ = d.Graph.DoWrite(ctx, func(tx *graph.WriteTx) error {
		_, err := nodes.CreateNote(ctx, tx, nodes.Note{Title: "Test Note", Body: "Body"}, nodes.Author{Name: "test"})
		return err
	})

	r := newTestRouter(t, d)
	req := httptest.NewRequest("GET", "/api/nodes", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var list []struct {
		ID    string `json:"id"`
		Title string `json:"title"`
		Type  string `json:"type"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &list)
	if len(list) == 0 {
		t.Fatal("expected at least one node")
	}
	found := false
	for _, n := range list {
		if n.Type == "note" && n.Title == "Test Note" {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("expected Test Note in list, got %+v", list)
	}
}
