package api

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// The list skips .obsidian and every other dot-file or dot-directory below
// the root, matches the note extension without regard to case, and still lists
// a vault whose own directory sits under a dot-named parent.
func TestVaultListSkipsDotPathsBelowTheRootOnly(t *testing.T) {
	root := filepath.Join(t.TempDir(), ".test", "vault")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	mux := newTestRouter(t, newTestDeps(t, root))
	writeVaultFile(t, root, "a.md", "a\n")
	writeVaultFile(t, root, "Sub/Upper.MD", "upper\n")
	writeVaultFile(t, root, ".obsidian/workspace.md", "settings\n")
	writeVaultFile(t, root, "notes/.hidden.md", "dot-file\n")
	writeVaultFile(t, root, "notes/kept.md", "kept\n")
	writeVaultFile(t, root, "notes/readme.txt", "not a note\n")

	var payload struct {
		Files []string `json:"files"`
	}
	getJSON(t, mux, "/api/vault/list", &payload)
	want := []string{"Sub/Upper.MD", "a.md", "notes/kept.md"}
	if !reflect.DeepEqual(payload.Files, want) {
		t.Errorf("files = %v, want %v", payload.Files, want)
	}
}
