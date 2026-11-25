package api

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

// writeVaultFile creates rel under root with body, making its directories.
func writeVaultFile(t *testing.T, root, rel, body string) string {
	t.Helper()
	full := filepath.Join(root, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(full, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return full
}

func deleteVaultFile(t *testing.T, mux *http.ServeMux, rel string) *httptest.ResponseRecorder {
	t.Helper()
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, httptest.NewRequest(http.MethodDelete, "/api/vault/file?path="+rel, nil))
	return w
}

// assertVaultFile fails unless rel under root holds exactly want.
func assertVaultFile(t *testing.T, root, rel, want string) {
	t.Helper()
	got, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(rel)))
	if err != nil {
		t.Fatalf("%s: %v", rel, err)
	}
	if string(got) != want {
		t.Errorf("%s holds %q, want %q", rel, got, want)
	}
}

func assertNoVaultFile(t *testing.T, root, rel string) {
	t.Helper()
	if _, err := os.Lstat(filepath.Join(root, filepath.FromSlash(rel))); !os.IsNotExist(err) {
		t.Errorf("%s must not exist (lstat: %v)", rel, err)
	}
}

// A deleted note lands in the vault's own .trash folder, which the delete
// creates when the vault has none yet, so it can be moved back by hand.
func TestVaultDeleteMovesTheNoteIntoTheVaultTrash(t *testing.T) {
	root := t.TempDir()
	mux := newTestRouter(t, newTestDeps(t, root))
	writeVaultFile(t, root, "note.md", "the note\n")
	assertNoVaultFile(t, root, ".trash")

	if w := deleteVaultFile(t, mux, "note.md"); w.Code != http.StatusNoContent {
		t.Fatalf("DELETE = %d: %s", w.Code, w.Body.String())
	}
	assertNoVaultFile(t, root, "note.md")
	assertVaultFile(t, root, ".trash/note.md", "the note\n")
}

// The note keeps its folder inside the trash: two notes of one name in two
// folders must not meet there, and restoring one means knowing where it lived.
func TestVaultDeleteKeepsTheSubPathInTheTrash(t *testing.T) {
	root := t.TempDir()
	mux := newTestRouter(t, newTestDeps(t, root))
	writeVaultFile(t, root, "sub/dir/note.md", "nested\n")

	if w := deleteVaultFile(t, mux, "sub/dir/note.md"); w.Code != http.StatusNoContent {
		t.Fatalf("DELETE = %d: %s", w.Code, w.Body.String())
	}
	assertVaultFile(t, root, ".trash/sub/dir/note.md", "nested\n")
	assertNoVaultFile(t, root, ".trash/note.md")
	assertNoVaultFile(t, root, "sub/dir/note.md")
}

// A rename silently replaces whatever sits at its destination, and in the
// trash that is a note already deleted once. Deleting the same name three
// times keeps all three, each under the next numeric suffix.
func TestVaultDeleteSuffixesANameAlreadyInTheTrash(t *testing.T) {
	root := t.TempDir()
	mux := newTestRouter(t, newTestDeps(t, root))

	for _, body := range []string{"first\n", "second\n", "third\n"} {
		writeVaultFile(t, root, "sub/log.md", body)
		if w := deleteVaultFile(t, mux, "sub/log.md"); w.Code != http.StatusNoContent {
			t.Fatalf("DELETE of %q = %d: %s", body, w.Code, w.Body.String())
		}
	}
	assertVaultFile(t, root, ".trash/sub/log.md", "first\n")
	assertVaultFile(t, root, ".trash/sub/log 1.md", "second\n")
	assertVaultFile(t, root, ".trash/sub/log 2.md", "third\n")
}

// A directory is not a note. Moving one would take every note under it out of
// the index at once, so it is refused, and nothing is left in the trash.
func TestVaultDeleteRefusesADirectory(t *testing.T) {
	root := t.TempDir()
	mux := newTestRouter(t, newTestDeps(t, root))
	writeVaultFile(t, root, "sub/dir/note.md", "kept\n")

	for _, rel := range []string{"sub", "sub/dir"} {
		w := deleteVaultFile(t, mux, rel)
		if w.Code != http.StatusBadRequest {
			t.Errorf("DELETE %s = %d, want 400: %s", rel, w.Code, w.Body.String())
		}
		assertNoPathLeak(t, w.Body.String(), root)
	}
	assertVaultFile(t, root, "sub/dir/note.md", "kept\n")
	assertNoVaultFile(t, root, ".trash")
}

// The trash is where a deleted note can still be recovered, so nothing in it
// is a delete target - neither the folder nor a note in it, in any case of its
// name, since a macOS volume treats ".TRASH" and ".trash" as one folder.
func TestVaultDeleteRefusesAPathInTheTrash(t *testing.T) {
	root := t.TempDir()
	mux := newTestRouter(t, newTestDeps(t, root))
	writeVaultFile(t, root, ".trash/old.md", "deleted once\n")

	for _, rel := range []string{".trash", ".trash/old.md", ".TRASH/old.md", "sub/../.trash/old.md"} {
		w := deleteVaultFile(t, mux, rel)
		if w.Code != http.StatusBadRequest {
			t.Errorf("DELETE %s = %d, want 400: %s", rel, w.Code, w.Body.String())
		}
		assertNoPathLeak(t, w.Body.String(), root)
	}
	assertVaultFile(t, root, ".trash/old.md", "deleted once\n")
	assertNoVaultFile(t, root, ".trash/.trash")
}

// The name is claimed with an empty placeholder before the rename. A rename
// that fails - here because the note's folder is read-only - must take the
// placeholder back out, or the trash would hold an empty file wearing the
// note's name.
func TestVaultDeleteThatFailsLeavesNoPlaceholder(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root ignores the read-only folder that makes the rename fail")
	}
	root := t.TempDir()
	mux := newTestRouter(t, newTestDeps(t, root))
	writeVaultFile(t, root, "locked/note.md", "stays\n")
	locked := filepath.Join(root, "locked")
	if err := os.Chmod(locked, 0o555); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(locked, 0o755) })

	if w := deleteVaultFile(t, mux, "locked/note.md"); w.Code != http.StatusInternalServerError {
		t.Fatalf("DELETE from a read-only folder = %d, want 500: %s", w.Code, w.Body.String())
	}
	assertVaultFile(t, root, "locked/note.md", "stays\n")
	assertNoVaultFile(t, root, ".trash/locked/note.md")
}

// A missing note answers 404, names the path the caller sent rather than the
// absolute one, and creates no trash folder on the way.
func TestVaultDeleteOfAMissingNoteIs404(t *testing.T) {
	root := t.TempDir()
	mux := newTestRouter(t, newTestDeps(t, root))

	w := deleteVaultFile(t, mux, "sub/absent.md")
	if w.Code != http.StatusNotFound {
		t.Fatalf("DELETE of a missing note = %d, want 404: %s", w.Code, w.Body.String())
	}
	assertNoPathLeak(t, w.Body.String(), root)
	assertNoVaultFile(t, root, ".trash")
}
