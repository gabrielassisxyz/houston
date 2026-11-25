package api

import (
	"net/http"
	"os"
	"path/filepath"
	"testing"
)

// assertNoNewDirectory fails when the refused write left its parent
// directory behind: the route used to create directories before it checked
// anything else.
func assertNoNewDirectory(t *testing.T, root, dir string) {
	t.Helper()
	if _, err := os.Stat(filepath.Join(root, dir)); !os.IsNotExist(err) {
		t.Errorf("a refused write left the directory %s behind (stat error: %v)", dir, err)
	}
}

// TestVaultWriteRefusesWhatTheIndexWouldNeverRead: the reconciler neither
// indexes nor writes a zero-byte file or a note that is not UTF-8, so the
// route refuses to write one rather than answer "saved" for a note the index
// never shows. An empty body used to get a frontmatter block written into it.
func TestVaultWriteRefusesWhatTheIndexWouldNeverRead(t *testing.T) {
	cases := map[string]string{
		"empty body":    "",
		"invalid UTF-8": "---\ntitle: T\n---\n\nbad \xff\xfe bytes\n",
	}
	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			root := t.TempDir()
			d := newTestDeps(t, root)

			code, doc := vaultFileWrite(t, d, "fresh-dir/sub/note.md", body)
			if code != http.StatusBadRequest {
				t.Fatalf("expected 400, got %d (%+v)", code, doc)
			}
			if doc.Status != "error" || doc.Error == "" {
				t.Fatalf("a refusal must answer an error document with a reason, got %+v", doc)
			}
			assertNoNewDirectory(t, root, "fresh-dir")
		})
	}
}

// TestVaultWriteRefusalLeavesNoDirectory covers the refusals that were already
// there, for the permission, for the id lookup and for the tags: none may
// leave behind the directories its path named.
func TestVaultWriteRefusalLeavesNoDirectory(t *testing.T) {
	t.Run("permission", func(t *testing.T) {
		root := t.TempDir()
		d := newTestDeps(t, root)
		code, _ := vaultFileWrite(t, d, "fresh-dir/note.md", "---\npermission: read-only\n---\n\nbody\n")
		if code != http.StatusBadRequest {
			t.Fatalf("expected 400, got %d", code)
		}
		assertNoNewDirectory(t, root, "fresh-dir")
	})

	t.Run("id lookup", func(t *testing.T) {
		root := t.TempDir()
		d := newTestDeps(t, root)
		// A closed graph makes the lookup of the path's id fail.
		if err := d.Graph.Close(); err != nil {
			t.Fatal(err)
		}
		code, _ := vaultFileWrite(t, d, "fresh-dir/note.md", "---\ntitle: T\n---\n\nbody\n")
		if code != http.StatusInternalServerError {
			t.Fatalf("expected 500, got %d", code)
		}
		assertNoNewDirectory(t, root, "fresh-dir")
	})

	t.Run("tags", func(t *testing.T) {
		root := t.TempDir()
		d := newTestDeps(t, root)
		code, _ := vaultFileWrite(t, d, "fresh-dir/note.md&tags=a", "---\n\t\tt\n---\n\nbody\n")
		if code != http.StatusBadRequest {
			t.Fatalf("expected 400, got %d", code)
		}
		assertNoNewDirectory(t, root, "fresh-dir")
	})
}

// TestVaultWriteStillCreatesTheDirectories is the other direction: a write
// that is accepted still creates the directories its path names.
func TestVaultWriteStillCreatesTheDirectories(t *testing.T) {
	root := t.TempDir()
	d := newTestDeps(t, root)
	code, doc := vaultFileWrite(t, d, "fresh-dir/sub/note.md", "---\ntitle: T\n---\n\nbody\n")
	if code != http.StatusOK {
		t.Fatalf("expected 200, got %d (%+v)", code, doc)
	}
	if _, err := os.Stat(filepath.Join(root, "fresh-dir", "sub", "note.md")); err != nil {
		t.Fatalf("the accepted note is not on disk: %v", err)
	}
}
