package api

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/gabrielassisxyz/houston/notes/internal/vault/reconcile"
)

func writeNoteWithPermission(t *testing.T, d Deps, permission string) *httptest.ResponseRecorder {
	t.Helper()
	mux := newTestRouter(t, d)

	body := "---\ntitle: Policy note\npermission: " + permission + "\n---\n\nA note that declares a policy.\n"
	req := httptest.NewRequest("POST", "/api/vault/file?path=policy-note.md", bytes.NewBufferString(body))
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, req)
	return w
}

// TestVaultWriteRefusesInvalidPermission verifies the refusal reaches the caller
// and, more importantly, that nothing lands on disk.
//
// noteFromFile refuses the value too, but that runs on the reconciler's own
// pass: the write would answer "saved", the file would exist, and the graph
// would never adopt it. A note that exists as a file and not as a node is the
// orphan the shared write primitive was built to remove, and it is invisible
// from the caller's side.
func TestVaultWriteRefusesInvalidPermission(t *testing.T) {
	root := t.TempDir()
	d := newTestDeps(t, root)

	w := writeNoteWithPermission(t, d, "read-only")
	if w.Code != http.StatusBadRequest {
		t.Fatalf("an unrecognised permission must be refused with 400, got %d: %s", w.Code, w.Body.String())
	}
	if _, err := os.Stat(filepath.Join(root, "policy-note.md")); !os.IsNotExist(err) {
		t.Errorf("a refused write must not leave a file behind, but policy-note.md exists")
	}
}

// TestVaultWriteAcceptsValidPermission is the other direction: the guard must
// not refuse a value the resolver accepts.
func TestVaultWriteAcceptsValidPermission(t *testing.T) {
	for _, permission := range []string{"ask", "edit"} {
		t.Run(permission, func(t *testing.T) {
			root := t.TempDir()
			d := newTestDeps(t, root)

			w := writeNoteWithPermission(t, d, permission)
			if w.Code != http.StatusOK {
				t.Fatalf("permission %q must be accepted, got %d: %s", permission, w.Code, w.Body.String())
			}
			if _, err := os.Stat(filepath.Join(root, "policy-note.md")); err != nil {
				t.Errorf("an accepted write must leave the file: %v", err)
			}
		})
	}
}

// TestNoteIndexServesANoteWithAnUnknownPermission drives the reconciler over a
// file the write route would have refused - a note typed by hand, or synced
// in - and reads the index back. The note used to be skipped, and one unknown
// value stored in the graph made GET /api/notes answer 500 for every note. It
// is listed now, as "ask".
func TestNoteIndexServesANoteWithAnUnknownPermission(t *testing.T) {
	root := t.TempDir()
	d := newTestDeps(t, root)

	path := filepath.Join(root, "typed-by-hand.md")
	note := "---\nid: perm-unknown-1\ntitle: Typed by hand\nauthor: da\npermission: readonly\n---\n\nBody.\n"
	if err := os.WriteFile(path, []byte(note), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := reconcile.New(d.Graph, root).OnCreate(context.Background(), path); err != nil {
		t.Fatalf("OnCreate: %v", err)
	}

	index := getNoteIndex(t, d)
	if got := entryByPath(t, index, "typed-by-hand.md").Permission; got != "ask" {
		t.Errorf("permission = %q, want %q", got, "ask")
	}
}
