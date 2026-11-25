package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sort"
	"testing"
)

// kernl carries no test of its own for the three routes below. Each answers
// here from the dependency struct alone, so every ported route is exercised
// through the registered mux.

func getJSON(t *testing.T, mux *http.ServeMux, target string, into any) {
	t.Helper()
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, httptest.NewRequest(http.MethodGet, target, nil))
	if w.Code != http.StatusOK {
		t.Fatalf("GET %s = %d: %s", target, w.Code, w.Body.String())
	}
	if err := json.Unmarshal(w.Body.Bytes(), into); err != nil {
		t.Fatalf("GET %s: decode: %v: %s", target, err, w.Body.String())
	}
}

// The list walks the disk rather than the index, so it is also where a note
// moved into the vault trash would come back; a deleted note must not.
func TestVaultListAnswersTheMarkdownFilesOutsideTheTrash(t *testing.T) {
	root := t.TempDir()
	mux := newTestRouter(t, newTestDeps(t, root))
	writeVaultFile(t, root, "top.md", "top\n")
	writeVaultFile(t, root, "sub/nested.md", "nested\n")
	writeVaultFile(t, root, "sub/.trash/kept.md", "a folder of that name below the root is not the trash\n")
	writeVaultFile(t, root, "attachment.txt", "not a note\n")
	writeVaultFile(t, root, "doomed.md", "deleted\n")
	if w := deleteVaultFile(t, mux, "doomed.md"); w.Code != http.StatusNoContent {
		t.Fatalf("DELETE = %d: %s", w.Code, w.Body.String())
	}

	var payload struct {
		Files []string `json:"files"`
	}
	getJSON(t, mux, "/api/vault/list", &payload)
	sort.Strings(payload.Files)
	want := []string{"sub/.trash/kept.md", "sub/nested.md", "top.md"}
	if len(payload.Files) != len(want) {
		t.Fatalf("files = %v, want %v", payload.Files, want)
	}
	for i := range want {
		if payload.Files[i] != want[i] {
			t.Fatalf("files = %v, want %v", payload.Files, want)
		}
	}
}

func TestNotesTagsAnswersTheTagTree(t *testing.T) {
	d := newTestDeps(t, "")
	seedVaultNote(t, d.Graph, "first", "notes/first.md", "", "", "work/sprint")
	seedVaultNote(t, d.Graph, "second", "notes/second.md", "", "", "work/sprint", "solo")

	var tree map[string]struct {
		Files []string `json:"files"`
	}
	getJSON(t, newTestRouter(t, d), "/api/notes/tags", &tree)
	if got := tree["work/sprint"].Files; len(got) != 2 || got[0] != "notes/first.md" || got[1] != "notes/second.md" {
		t.Errorf("work/sprint files = %v, want [notes/first.md notes/second.md]", got)
	}
	if got := tree["solo"].Files; len(got) != 1 || got[0] != "notes/second.md" {
		t.Errorf("solo files = %v, want [notes/second.md]", got)
	}
}

// Related answers the live neighbours with their title and type, and leaves
// out the soft-deleted one the edge fixture plants.
func TestNodeRelatedAnswersTheLiveNeighbours(t *testing.T) {
	d := seedNodeEdgeFixture(t)

	var related []relatedNode
	getJSON(t, newTestRouter(t, d), "/api/nodes/n1/related", &related)
	byID := map[string]relatedNode{}
	for _, n := range related {
		byID[n.ID] = n
	}
	if n := byID["n2"]; n.Title != "Two" || n.Type != "note" {
		t.Errorf("n2 = %+v, want title Two, type note", n)
	}
	if n := byID["n3"]; n.Title != "Three" || n.Type != "task" {
		t.Errorf("n3 = %+v, want title Three, type task", n)
	}
	if _, ok := byID["n4"]; ok {
		t.Errorf("soft-deleted n4 must be left out: %+v", related)
	}
	if _, ok := byID["n1"]; ok {
		t.Errorf("a node is not related to itself: %+v", related)
	}
}
