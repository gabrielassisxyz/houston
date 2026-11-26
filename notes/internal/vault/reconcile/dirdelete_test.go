package reconcile_test

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/gabrielassisxyz/houston/notes/internal/graph/testutil"
	"github.com/gabrielassisxyz/houston/notes/internal/vault/reconcile"
)

func noteFile(id, title string) string {
	return "---\nid: " + id + "\ntitle: " + title + "\n---\n\n" + title + " body\n"
}

// A folder renamed inside the vault: the watcher reports the old directory
// gone and a change for each note at the new path. OnDirDelete holds every
// note's delete for the move window, and the changes at the new paths cancel
// them, so each note keeps its id.
func TestOnDirDelete_FolderRenamedInsideTheVaultKeepsIds(t *testing.T) {
	ctx := context.Background()
	g := testutil.NewInMemoryTestGraph(t)
	vault := t.TempDir()
	writeFile(t, filepath.Join(vault, "projects", "a.md"), noteFile("dir-a", "Alpha"))
	writeFile(t, filepath.Join(vault, "projects", "deep", "b.md"), noteFile("dir-b", "Beta"))
	writeFile(t, filepath.Join(vault, "projects-archive", "c.md"), noteFile("dir-c", "Gamma"))
	rec, clk := newTestReconcilerWithClock(g, vault)
	if err := rec.ColdStart(ctx); err != nil {
		t.Fatalf("ColdStart: %v", err)
	}

	if err := os.Rename(filepath.Join(vault, "projects"), filepath.Join(vault, "renamed")); err != nil {
		t.Fatal(err)
	}
	if err := rec.OnDirDelete(ctx, filepath.Join(vault, "projects")); err != nil {
		t.Fatalf("OnDirDelete: %v", err)
	}
	for _, rel := range []string{"renamed/a.md", "renamed/deep/b.md"} {
		if err := rec.OnChange(ctx, filepath.Join(vault, rel)); err != nil {
			t.Fatalf("OnChange %s: %v", rel, err)
		}
	}

	clk.Advance(2 * time.Second)
	if n, err := rec.FlushExpired(ctx); err != nil || n != 0 {
		t.Fatalf("FlushExpired = %d, %v; want nothing tombstoned", n, err)
	}
	for id, want := range map[string]string{
		"dir-a": filepath.Join("renamed", "a.md"),
		"dir-b": filepath.Join("renamed", "deep", "b.md"),
		"dir-c": filepath.Join("projects-archive", "c.md"),
	} {
		if !isLive(t, g, id) {
			t.Errorf("%s is not live after the folder rename", id)
		}
		if got, found, err := reconcile.LookupByUUID(ctx, g, id); err != nil || !found || got != want {
			t.Errorf("%s cached at %q (found=%v, err=%v), want %q", id, got, found, err, want)
		}
	}
}

// A folder deleted or moved out of the vault: its notes are tombstoned once
// the window ends. Only the notes under that exact directory go: a directory
// whose name a LIKE pattern would match (a_b against axb) keeps its note even
// when that note's own file is gone too, since its own event will say so.
func TestOnDirDelete_FolderGoneTombstonesOnlyItsNotes(t *testing.T) {
	ctx := context.Background()
	g := testutil.NewInMemoryTestGraph(t)
	vault := t.TempDir()
	writeFile(t, filepath.Join(vault, "a_b", "one.md"), noteFile("gone-one", "One"))
	writeFile(t, filepath.Join(vault, "a_b", "sub", "two.md"), noteFile("gone-two", "Two"))
	writeFile(t, filepath.Join(vault, "axb", "other.md"), noteFile("other", "Other"))
	writeFile(t, filepath.Join(vault, "a_b-kept", "kept.md"), noteFile("kept", "Kept"))
	rec, clk := newTestReconcilerWithClock(g, vault)
	if err := rec.ColdStart(ctx); err != nil {
		t.Fatalf("ColdStart: %v", err)
	}

	if err := os.RemoveAll(filepath.Join(vault, "a_b")); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(vault, "axb", "other.md")); err != nil {
		t.Fatal(err)
	}
	if err := rec.OnDirDelete(ctx, filepath.Join(vault, "a_b")); err != nil {
		t.Fatalf("OnDirDelete: %v", err)
	}
	if !isLive(t, g, "gone-one") {
		t.Fatal("OnDirDelete tombstoned at once instead of holding the move window")
	}

	clk.Advance(2 * time.Second)
	if n, err := rec.FlushExpired(ctx); err != nil || n != 2 {
		t.Fatalf("FlushExpired = %d, %v; want the folder's 2 notes", n, err)
	}
	for id, live := range map[string]bool{"gone-one": false, "gone-two": false, "other": true, "kept": true} {
		if got := isLive(t, g, id); got != live {
			t.Errorf("%s live = %v, want %v", id, got, live)
		}
	}
}
