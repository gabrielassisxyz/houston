package reconcile_test

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/gabrielassisxyz/houston/notes/internal/graph"
	"github.com/gabrielassisxyz/houston/notes/internal/graph/search"
	"github.com/gabrielassisxyz/houston/notes/internal/graph/testutil"
	"github.com/gabrielassisxyz/houston/notes/internal/vault/frontmatter"
	"github.com/gabrielassisxyz/houston/notes/internal/vault/reconcile"
)

// searchFinds reports whether a note search for query returns id.
func searchFinds(t *testing.T, g *graph.Graph, query, id string) bool {
	t.Helper()
	found := false
	if err := g.DoRead(context.Background(), func(tx *graph.ReadTx) error {
		hits, err := search.Search(context.Background(), tx, query, search.WithTypes("note"))
		if err != nil {
			return err
		}
		for _, h := range hits {
			if h.NodeID == id {
				found = true
			}
		}
		return nil
	}); err != nil {
		t.Fatalf("search %q: %v", query, err)
	}
	return found
}

// indexOne writes a note and indexes it through a cold start.
func indexOne(t *testing.T, rel, content string) (*graph.Graph, string, *reconcile.Reconciler, *advancedClock) {
	t.Helper()
	g := testutil.NewInMemoryTestGraph(t)
	vault := t.TempDir()
	writeFile(t, filepath.Join(vault, rel), content)
	rec, clk := newTestReconcilerWithClock(g, vault)
	if err := rec.ColdStart(context.Background()); err != nil {
		t.Fatalf("ColdStart: %v", err)
	}
	return g, vault, rec, clk
}

// The watcher reports the recreated file as a change. Inside the move window
// the change cancels the pending delete, so the window's end tombstones nothing.
func TestOnChange_DeleteThenRecreateWithinTheWindowStaysLive(t *testing.T) {
	ctx := context.Background()
	content := noteFile("recreate-in", "Phoenix")
	g, vault, rec, clk := indexOne(t, "phoenix.md", content)
	path := filepath.Join(vault, "phoenix.md")

	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := rec.OnDelete(ctx, path); err != nil {
		t.Fatalf("OnDelete: %v", err)
	}
	writeFile(t, path, content)
	if err := rec.OnChange(ctx, path); err != nil {
		t.Fatalf("OnChange: %v", err)
	}

	clk.Advance(2 * time.Second)
	if n, err := rec.FlushExpired(ctx); err != nil || n != 0 {
		t.Fatalf("FlushExpired = %d, %v; want nothing tombstoned", n, err)
	}
	if !isLive(t, g, "recreate-in") || !searchFinds(t, g, "Phoenix", "recreate-in") {
		t.Error("a note recreated inside the window is not live and searchable")
	}
}

// After the window the note is tombstoned. Its file coming back as a change
// revives it; updating the tombstoned row in place used to keep it hidden.
func TestOnChange_DeleteThenRecreateAfterTheWindowRevives(t *testing.T) {
	ctx := context.Background()
	content := noteFile("recreate-after", "Lazarus")
	g, vault, rec, clk := indexOne(t, "lazarus.md", content)
	path := filepath.Join(vault, "lazarus.md")

	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := rec.OnDelete(ctx, path); err != nil {
		t.Fatalf("OnDelete: %v", err)
	}
	clk.Advance(2 * time.Second)
	if n, err := rec.FlushExpired(ctx); err != nil || n != 1 {
		t.Fatalf("FlushExpired = %d, %v; want the note tombstoned", n, err)
	}

	writeFile(t, path, content)
	if err := rec.OnChange(ctx, path); err != nil {
		t.Fatalf("OnChange: %v", err)
	}
	if !isLive(t, g, "recreate-after") {
		t.Fatal("a note recreated after its window is still tombstoned")
	}
	if !searchFinds(t, g, "Lazarus", "recreate-after") {
		t.Error("the revived note is not searchable")
	}
	if rel, found, err := reconcile.LookupByUUID(ctx, g, "recreate-after"); err != nil || !found || rel != "lazarus.md" {
		t.Errorf("path cache = %q (found=%v, err=%v), want lazarus.md", rel, found, err)
	}
}

// A new note written under a deleted note's name is a different note: its
// change must not cancel the old note's delete, which a match by path would.
func TestOnChange_NewNoteUnderADeletedNotesNameLeavesItDeleted(t *testing.T) {
	ctx := context.Background()
	g, vault, rec, clk := indexOne(t, "shared.md", noteFile("old-tenant", "Old"))
	path := filepath.Join(vault, "shared.md")

	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := rec.OnDelete(ctx, path); err != nil {
		t.Fatalf("OnDelete: %v", err)
	}
	writeFile(t, path, "---\ntitle: New\n---\n\nA different note.\n")
	err := rec.OnChange(ctx, path)
	if errors.Is(err, graph.ErrNotFound) {
		// What the service's router does with a change for an id it has
		// never seen.
		err = rec.OnCreate(ctx, path)
	}
	if err != nil {
		t.Fatalf("OnChange/OnCreate: %v", err)
	}

	clk.Advance(2 * time.Second)
	if _, err := rec.FlushExpired(ctx); err != nil {
		t.Fatalf("FlushExpired: %v", err)
	}
	if isLive(t, g, "old-tenant") {
		t.Error("the deleted note came back because a new note took its name")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	fm, err := frontmatter.Parse(raw)
	if err != nil || fm.ID == "" || fm.ID == "old-tenant" {
		t.Fatalf("new note's id = %q (err %v), want a fresh one", fm.ID, err)
	}
	if !isLive(t, g, fm.ID) {
		t.Error("the new note is not live")
	}
}
