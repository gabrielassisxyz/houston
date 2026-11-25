package api

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// assertReplacedAtomically fails unless path was renamed over rather than
// written into, kept its mode, and left no temporary file beside it.
func assertReplacedAtomically(t *testing.T, path string, before os.FileInfo) {
	t.Helper()
	after, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if os.SameFile(before, after) {
		t.Errorf("%s kept its inode: it was written in place", filepath.Base(path))
	}
	if after.Mode().Perm() != before.Mode().Perm() {
		t.Errorf("mode = %v, want the note's own %v", after.Mode().Perm(), before.Mode().Perm())
	}
	entries, err := os.ReadDir(filepath.Dir(path))
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".houston-tmp-") {
			t.Errorf("temporary file %s left behind", e.Name())
		}
	}
}

func existingNote(t *testing.T, root, name, content string) (string, os.FileInfo) {
	t.Helper()
	path := filepath.Join(root, name)
	if err := os.WriteFile(path, []byte(content), 0o640); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, 0o640); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	return path, info
}

// The two routes the CLI writes through replace a note as a whole, so a crash
// mid-write leaves the old note or the new one, never half of either.
func TestVaultFileWriteIsAtomic(t *testing.T) {
	root := t.TempDir()
	d := newTestDeps(t, root)
	path, before := existingNote(t, root, "note.md", "---\nid: 019f14ca-58ad-7203-8cf8-487f765f0010\n---\n\nold\n")

	code, doc := vaultFileWrite(t, d, "note.md", "---\nid: 019f14ca-58ad-7203-8cf8-487f765f0010\n---\n\nnew\n")
	if code != http.StatusOK {
		t.Fatalf("expected 200, got %d (%+v)", code, doc)
	}
	assertReplacedAtomically(t, path, before)
}

func TestVaultAppendIsAtomic(t *testing.T) {
	mux, full := appendVault(t)
	if err := os.Chmod(full, 0o640); err != nil {
		t.Fatal(err)
	}
	before, err := os.Stat(full)
	if err != nil {
		t.Fatal(err)
	}

	w := postAppend(t, mux, "path=log.md", "## newer\n")
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	assertReplacedAtomically(t, full, before)
}
