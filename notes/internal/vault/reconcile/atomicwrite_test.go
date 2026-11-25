package reconcile_test

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gabrielassisxyz/houston/notes/internal/vault/reconcile"
)

// assertReplacedAtomically fails unless path is a new file - renamed over the
// old one rather than written into it - with the old file's mode, and its
// directory holds no temporary file.
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
		t.Errorf("mode = %v, want the file's own %v", after.Mode().Perm(), before.Mode().Perm())
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

func statWithMode(t *testing.T, path string, mode os.FileMode) os.FileInfo {
	t.Helper()
	if err := os.Chmod(path, mode); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	return info
}

// TestInjectedIDIsWrittenAtomically: id injection writes into thousands of
// notes on the first index, and a crash mid-write must not leave one of them
// half written.
func TestInjectedIDIsWrittenAtomically(t *testing.T) {
	ctx := context.Background()
	_, vault, rec := newColdStartHarness(t)
	path := filepath.Join(vault, "no-id.md")
	writeFile(t, path, "---\ntitle: No id yet\n---\n\nBody.\n")
	before := statWithMode(t, path, 0o640)

	if err := rec.OnCreate(ctx, path); err != nil {
		t.Fatalf("OnCreate: %v", err)
	}
	assertReplacedAtomically(t, path, before)
}

func TestWriteNoteBodyIsWrittenAtomically(t *testing.T) {
	ctx := context.Background()
	g, vault, rec := newColdStartHarness(t)
	path := filepath.Join(vault, "topic.md")
	writeFile(t, path, "---\nid: atomic-1\ntitle: Topic\n---\n\nOriginal body.\n")
	if err := rec.OnCreate(ctx, path); err != nil {
		t.Fatalf("OnCreate: %v", err)
	}
	before := statWithMode(t, path, 0o640)

	if _, err := reconcile.WriteNoteBody(ctx, g, vault, "atomic-1", "Merged body.\n"); err != nil {
		t.Fatalf("WriteNoteBody: %v", err)
	}
	assertReplacedAtomically(t, path, before)
}
