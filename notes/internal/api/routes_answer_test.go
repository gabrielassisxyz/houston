package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sort"
	"testing"
)

// kernl carries no test of its own for the route below. It answers here from
// the dependency struct alone, through the registered mux.

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
