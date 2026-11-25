package reconcile_test

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/gabrielassisxyz/houston/notes/internal/graph"
	"github.com/gabrielassisxyz/houston/notes/internal/graph/nodes"
	"github.com/gabrielassisxyz/houston/notes/internal/graph/testutil"
	"github.com/gabrielassisxyz/houston/notes/internal/vault/reconcile"
)

const (
	takeoverA = "---\nid: take-a\ntitle: Note A\n---\n\nA's body.\n"
	takeoverB = "---\nid: take-b\ntitle: Note B\n---\n\nB's body.\n"
)

// routeChange does what the service does with a change event: OnChange, and
// OnCreate when the file names a note the graph does not have yet.
func routeChange(ctx context.Context, rec *reconcile.Reconciler, absPath string) error {
	err := rec.OnChange(ctx, absPath)
	if errors.Is(err, graph.ErrNotFound) {
		err = rec.OnCreate(ctx, absPath)
	}
	return err
}

func isLiveNote(t *testing.T, g *graph.Graph, id string) bool {
	t.Helper()
	var live bool
	err := g.DoRead(context.Background(), func(tx *graph.ReadTx) error {
		_, err := nodes.GetNote(context.Background(), tx, id)
		switch {
		case err == nil:
			live = true
		case errors.Is(err, graph.ErrNotFound):
		default:
			return err
		}
		return nil
	})
	if err != nil {
		t.Fatalf("GetNote %s: %v", id, err)
	}
	return live
}

// expireWindow moves the injected clock past the delete window and flushes.
func expireWindow(t *testing.T, rec *reconcile.Reconciler, clk *advancedClock) int {
	t.Helper()
	clk.Advance(2 * time.Second)
	n, err := rec.FlushExpired(context.Background())
	if err != nil {
		t.Fatalf("FlushExpired: %v", err)
	}
	return n
}

// TestOnChange_FileReplacedInPlaceIsIndexedUnderItsID is `mv other.md
// note.md` while the service runs: the path is unique in the cache, so the
// upsert under the new id used to fail and leave note.md out of the index. It
// must be indexed under the id it now carries, and the note it replaced is
// deleted once the window passes.
func TestOnChange_FileReplacedInPlaceIsIndexedUnderItsID(t *testing.T) {
	ctx := context.Background()
	g := testutil.NewInMemoryTestGraph(t)
	vault := t.TempDir()
	rec, clk := newTestReconcilerWithClock(g, vault)

	note := filepath.Join(vault, "note.md")
	other := filepath.Join(vault, "other.md")
	writeFile(t, note, takeoverA)
	writeFile(t, other, takeoverB)
	for _, p := range []string{note, other} {
		if err := rec.OnCreate(ctx, p); err != nil {
			t.Fatalf("OnCreate %s: %v", p, err)
		}
	}

	if err := os.Rename(other, note); err != nil {
		t.Fatal(err)
	}
	if err := routeChange(ctx, rec, note); err != nil {
		t.Fatalf("change on the replaced path: %v", err)
	}
	assertPathHolds(t, g, "note.md", "take-b")
	assertNotIndexed(t, g, "other.md")
	if !isLiveNote(t, g, "take-a") {
		t.Fatal("the displaced note must wait out the window before it is deleted")
	}

	if n := expireWindow(t, rec, clk); n != 1 {
		t.Fatalf("tombstoned %d notes after the window, want the displaced one", n)
	}
	if isLiveNote(t, g, "take-a") {
		t.Error("the displaced note is still live after the window")
	}
	if !isLiveNote(t, g, "take-b") {
		t.Error("the note that took the path over must stay live")
	}
}

// TestOnChange_NewNoteReplacingAPathIsIndexed is the same replacement by a note
// the graph has never seen, as a sync client's replacement brings.
func TestOnChange_NewNoteReplacingAPathIsIndexed(t *testing.T) {
	ctx := context.Background()
	g := testutil.NewInMemoryTestGraph(t)
	vault := t.TempDir()
	rec, clk := newTestReconcilerWithClock(g, vault)

	note := filepath.Join(vault, "note.md")
	writeFile(t, note, takeoverA)
	if err := rec.OnCreate(ctx, note); err != nil {
		t.Fatalf("OnCreate: %v", err)
	}
	writeFile(t, note, "---\nid: take-new\ntitle: Replacement\n---\n\nNew body.\n")
	if err := routeChange(ctx, rec, note); err != nil {
		t.Fatalf("change on the replaced path: %v", err)
	}
	assertPathHolds(t, g, "note.md", "take-new")
	if n := expireWindow(t, rec, clk); n != 1 {
		t.Fatalf("tombstoned %d notes after the window, want the displaced one", n)
	}
}

// TestDisplacedNoteKeepsItsIdentityWhenItsFileShowsUpElsewhere is the window
// doing its job: the note pushed off a path is not deleted when its file turns
// up at another path before the window ends, and the watcher reports that file
// as a change, so OnChange is where the pending delete has to be cancelled.
func TestDisplacedNoteKeepsItsIdentityWhenItsFileShowsUpElsewhere(t *testing.T) {
	ctx := context.Background()
	g := testutil.NewInMemoryTestGraph(t)
	vault := t.TempDir()
	rec, clk := newTestReconcilerWithClock(g, vault)

	note := filepath.Join(vault, "note.md")
	writeFile(t, note, takeoverA)
	if err := rec.OnCreate(ctx, note); err != nil {
		t.Fatalf("OnCreate: %v", err)
	}

	writeFile(t, note, "---\nid: take-new\ntitle: Replacement\n---\n\nNew body.\n")
	if err := routeChange(ctx, rec, note); err != nil {
		t.Fatalf("change on the replaced path: %v", err)
	}
	archived := filepath.Join(vault, "archive", "note.md")
	writeFile(t, archived, takeoverA)
	if err := routeChange(ctx, rec, archived); err != nil {
		t.Fatalf("change on the archived copy: %v", err)
	}

	if n := expireWindow(t, rec, clk); n != 0 {
		t.Fatalf("tombstoned %d notes, want none: the displaced note's file showed up", n)
	}
	assertPathHolds(t, g, filepath.Join("archive", "note.md"), "take-a")
	assertPathHolds(t, g, "note.md", "take-new")
	if !isLiveNote(t, g, "take-a") {
		t.Error("the displaced note lost its identity although its file showed up")
	}
}

// TestColdStart_FileReplacedInPlaceWhileOff: the note's file is gone and a note
// with another id sits at its path. The newcomer is indexed there and the old
// note is tombstoned.
func TestColdStart_FileReplacedInPlaceWhileOff(t *testing.T) {
	ctx := context.Background()
	g, vault, rec := newColdStartHarness(t)

	note := filepath.Join(vault, "note.md")
	writeFile(t, note, takeoverA)
	if err := rec.ColdStart(ctx); err != nil {
		t.Fatalf("ColdStart: %v", err)
	}
	writeFile(t, note, takeoverB)
	if err := rec.ColdStart(ctx); err != nil {
		t.Fatalf("ColdStart: %v", err)
	}
	assertPathHolds(t, g, "note.md", "take-b")
	if isLiveNote(t, g, "take-a") {
		t.Error("the replaced note's file is nowhere, so a cold start tombstones it")
	}
}

// TestColdStart_MoveWhenTheOldPathHoldsAnotherNote moves a note while off and
// puts a new note at its old path - with an id, and without one, as a note
// just created in an editor has. The old path exists but no longer holds the
// note, so the move is a move, not a duplicate, and both notes are indexed.
func TestColdStart_MoveWhenTheOldPathHoldsAnotherNote(t *testing.T) {
	newcomers := map[string]string{
		"with an id":    takeoverB,
		"without an id": "# A new note\n\nWritten in an editor.\n",
	}
	for name, newcomer := range newcomers {
		t.Run(name, func(t *testing.T) {
			ctx := context.Background()
			g, vault, rec := newColdStartHarness(t)

			note := filepath.Join(vault, "note.md")
			writeFile(t, note, takeoverA)
			if err := rec.ColdStart(ctx); err != nil {
				t.Fatalf("ColdStart: %v", err)
			}
			if err := os.MkdirAll(filepath.Join(vault, "archive"), 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.Rename(note, filepath.Join(vault, "archive", "note.md")); err != nil {
				t.Fatal(err)
			}
			writeFile(t, note, newcomer)

			if err := rec.ColdStart(ctx); err != nil {
				t.Fatalf("ColdStart: %v", err)
			}
			assertPathHolds(t, g, filepath.Join("archive", "note.md"), "take-a")
			if _, found, err := reconcile.Lookup(ctx, g, "note.md"); err != nil || !found {
				t.Fatalf("the newcomer at note.md is not indexed (found=%v, err=%v)", found, err)
			}
			if n := countLiveNotes(t, g); n != 2 {
				t.Fatalf("live notes = %d, want 2", n)
			}
			assertNoReports(t, rec)
		})
	}
}
