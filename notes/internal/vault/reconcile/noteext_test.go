package reconcile_test

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gabrielassisxyz/houston/notes/internal/graph"
	"github.com/gabrielassisxyz/houston/notes/internal/graph/nodes"
	"github.com/gabrielassisxyz/houston/notes/internal/graph/testutil"
	"github.com/gabrielassisxyz/houston/notes/internal/vault/reconcile"
)

// isLive reports whether a note node exists and is not tombstoned.
func isLive(t *testing.T, g *graph.Graph, id string) bool {
	t.Helper()
	var live bool
	if err := g.DoRead(context.Background(), func(tx *graph.ReadTx) error {
		var n int
		if err := tx.QueryRow(
			`SELECT COUNT(*) FROM nodes WHERE id = ? AND type = 'note' AND deleted_at IS NULL`, id,
		).Scan(&n); err != nil {
			return err
		}
		live = n == 1
		return nil
	}); err != nil {
		t.Fatalf("isLive %s: %v", id, err)
	}
	return live
}

// A note named Note.MD is a note: indexed by the cold start, and still live
// after the next one, which matched only ".md" and swept it away before.
func TestColdStart_UpperCaseExtensionIndexedAndKept(t *testing.T) {
	ctx := context.Background()
	g := testutil.NewInMemoryTestGraph(t)
	vault := t.TempDir()
	path := filepath.Join(vault, "Note.MD")
	writeFile(t, path, "---\nid: upper-ext-id\ntitle: Upper\n---\n\nbody\n")

	if err := reconcile.New(g, vault).ColdStart(ctx); err != nil {
		t.Fatalf("first ColdStart: %v", err)
	}
	if !isLive(t, g, "upper-ext-id") {
		t.Fatal("Note.MD was not indexed by the cold start")
	}
	if rel, found, err := reconcile.LookupByUUID(ctx, g, "upper-ext-id"); err != nil || !found || rel != "Note.MD" {
		t.Fatalf("path cache = %q (found=%v, err=%v), want Note.MD", rel, found, err)
	}

	if err := reconcile.New(g, vault).ColdStart(ctx); err != nil {
		t.Fatalf("second ColdStart: %v", err)
	}
	if !isLive(t, g, "upper-ext-id") {
		t.Error("Note.MD was tombstoned by the second cold start")
	}
}

// WriteNoteBody looks a note up by its id when the path cache does not hold
// it. A copy of the note in .trash, which the walk reaches first, is not its
// file; the vault itself sits under a dot-named directory and is still read.
func TestWriteNoteBody_SkipsCopiesInDotDirectories(t *testing.T) {
	ctx := context.Background()
	g := testutil.NewInMemoryTestGraph(t)
	vault := filepath.Join(t.TempDir(), ".test")
	const id = "located-id"
	content := "---\nid: " + id + "\ntitle: Located\n---\n\nold body\n"
	trashed := filepath.Join(vault, ".trash", "located.md")
	real := filepath.Join(vault, "notes", "located.md")
	writeFile(t, trashed, content)
	writeFile(t, real, content)
	if err := g.DoWrite(ctx, func(tx *graph.WriteTx) error {
		_, err := nodes.CreateNote(ctx, tx, nodes.Note{ID: id, Title: "Located", Body: "old body\n"}, nodes.Author{Name: "human"})
		return err
	}); err != nil {
		t.Fatalf("CreateNote: %v", err)
	}

	written, err := reconcile.WriteNoteBody(ctx, g, vault, id, "new body\n")
	if err != nil || !written {
		t.Fatalf("WriteNoteBody = %v, %v; want written", written, err)
	}
	if got, _ := os.ReadFile(real); !strings.Contains(string(got), "new body") {
		t.Errorf("the note's own file was not written: %q", got)
	}
	if got, _ := os.ReadFile(trashed); strings.Contains(string(got), "new body") {
		t.Errorf("the copy in .trash was written instead: %q", got)
	}
}
