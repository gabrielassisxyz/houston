package reconcile_test

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/gabrielassisxyz/houston/notes/internal/graph"
	"github.com/gabrielassisxyz/houston/notes/internal/vault/reconcile"
)

const duplicatedNote = "---\nid: dup-0001\ntitle: Original\n---\n\nThe note.\n"

// assertPathHolds fails unless relPath is indexed under id.
func assertPathHolds(t *testing.T, g *graph.Graph, relPath, id string) {
	t.Helper()
	got, found, err := reconcile.Lookup(context.Background(), g, relPath)
	if err != nil {
		t.Fatalf("Lookup %s: %v", relPath, err)
	}
	if !found || got != id {
		t.Fatalf("%s is indexed as (%q, %v), want %q", relPath, got, found, id)
	}
}

// assertNotIndexed fails when relPath has a row in the path cache.
func assertNotIndexed(t *testing.T, g *graph.Graph, relPath string) {
	t.Helper()
	got, found, err := reconcile.Lookup(context.Background(), g, relPath)
	if err != nil {
		t.Fatalf("Lookup %s: %v", relPath, err)
	}
	if found {
		t.Fatalf("%s is indexed as %q, want it left out", relPath, got)
	}
}

// reportKinds returns the kinds reported for relPath.
func reportKinds(rec *reconcile.Reconciler, relPath string) []reconcile.ReportKind {
	var kinds []reconcile.ReportKind
	for _, rep := range rec.Reports() {
		if rep.Path == relPath {
			kinds = append(kinds, rep.Kind)
		}
	}
	return kinds
}

func assertReported(t *testing.T, rec *reconcile.Reconciler, relPath string, kind reconcile.ReportKind) {
	t.Helper()
	for _, k := range reportKinds(rec, relPath) {
		if k == kind {
			return
		}
	}
	t.Fatalf("no %s report for %s; reports: %+v", kind, relPath, rec.Reports())
}

func assertNoReports(t *testing.T, rec *reconcile.Reconciler) {
	t.Helper()
	if reps := rec.Reports(); len(reps) != 0 {
		t.Fatalf("reports = %+v, want none", reps)
	}
}

// TestColdStart_ConflictCopyThatSortsFirstDoesNotTakeThePath is the sync
// client's conflict copy: same id, a name that the walk reaches before the
// note's own. The note keeps its path on every cold start, and the copy is
// reported.
func TestColdStart_ConflictCopyThatSortsFirstDoesNotTakeThePath(t *testing.T) {
	ctx := context.Background()
	g, vault, rec := newColdStartHarness(t)

	writeFile(t, filepath.Join(vault, "note.md"), duplicatedNote)
	if err := rec.ColdStart(ctx); err != nil {
		t.Fatalf("first ColdStart: %v", err)
	}
	writeFile(t, filepath.Join(vault, "00-conflict.md"), duplicatedNote)

	// Twice, and the second time on a fresh reconciler, as after a restart.
	for i, r := range []*reconcile.Reconciler{rec, reconcile.New(g, vault)} {
		if err := r.ColdStart(ctx); err != nil {
			t.Fatalf("ColdStart %d: %v", i+2, err)
		}
		assertPathHolds(t, g, "note.md", "dup-0001")
		assertNotIndexed(t, g, "00-conflict.md")
		assertReported(t, r, "00-conflict.md", reconcile.ReportDuplicateID)
		if n := countLiveNotes(t, g); n != 1 {
			t.Fatalf("live notes = %d, want 1", n)
		}
	}
}

// TestOnChange_LiveCopyDoesNotTakeThePath is the same copy made while the
// service runs. The watcher reports a new file as a change, so the copy reaches
// OnChange, which used to point the note at it.
func TestOnChange_LiveCopyDoesNotTakeThePath(t *testing.T) {
	ctx := context.Background()
	g, vault, rec := newColdStartHarness(t)

	original := filepath.Join(vault, "note.md")
	writeFile(t, original, duplicatedNote)
	if err := rec.OnCreate(ctx, original); err != nil {
		t.Fatalf("OnCreate: %v", err)
	}
	copyPath := filepath.Join(vault, "copy.md")
	writeFile(t, copyPath, duplicatedNote)

	if err := rec.OnChange(ctx, copyPath); err != nil {
		t.Fatalf("OnChange copy: %v", err)
	}
	assertPathHolds(t, g, "note.md", "dup-0001")
	assertNotIndexed(t, g, "copy.md")
	assertReported(t, rec, "copy.md", reconcile.ReportDuplicateID)

	// The service turns a move_candidate whose file still exists into
	// OnCreate, and the copy must not be adopted that way either.
	if err := rec.OnCreate(ctx, copyPath); err != nil {
		t.Fatalf("OnCreate copy: %v", err)
	}
	assertPathHolds(t, g, "note.md", "dup-0001")
	assertNotIndexed(t, g, "copy.md")
	assertReported(t, rec, "copy.md", reconcile.ReportDuplicateID)

	// Deleting the copy clears its report, though it has no row to look up.
	if err := os.Remove(copyPath); err != nil {
		t.Fatal(err)
	}
	if err := rec.OnDelete(ctx, copyPath); err != nil {
		t.Fatalf("OnDelete copy: %v", err)
	}
	assertNoReports(t, rec)
}

// TestOnChange_MoveWhenTheOldPathIsGone keeps the genuine move working: once
// the note's own file is gone, the file carrying its id is the note.
func TestOnChange_MoveWhenTheOldPathIsGone(t *testing.T) {
	ctx := context.Background()
	g, vault, rec := newColdStartHarness(t)

	original := filepath.Join(vault, "note.md")
	writeFile(t, original, duplicatedNote)
	if err := rec.OnCreate(ctx, original); err != nil {
		t.Fatalf("OnCreate: %v", err)
	}
	moved := filepath.Join(vault, "moved.md")
	if err := os.Rename(original, moved); err != nil {
		t.Fatal(err)
	}
	if err := rec.OnChange(ctx, moved); err != nil {
		t.Fatalf("OnChange: %v", err)
	}
	assertPathHolds(t, g, "moved.md", "dup-0001")
	assertNotIndexed(t, g, "note.md")
	assertNoReports(t, rec)
}

// TestColdStart_SecondCopyAfterAGenuineMoveStaysOut moves a note while the
// service is off and leaves a second copy of it further along the walk. The
// first file the walk reaches is the move; the second must find the moved-to
// path, which exists, and stay out - not find the old path gone and move the
// note again.
func TestColdStart_SecondCopyAfterAGenuineMoveStaysOut(t *testing.T) {
	ctx := context.Background()
	g, vault, rec := newColdStartHarness(t)

	original := filepath.Join(vault, "m", "note.md")
	writeFile(t, original, duplicatedNote)
	if err := rec.ColdStart(ctx); err != nil {
		t.Fatalf("first ColdStart: %v", err)
	}

	if err := os.MkdirAll(filepath.Join(vault, "a"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(original, filepath.Join(vault, "a", "note.md")); err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(vault, "c", "note.md"), duplicatedNote)

	if err := rec.ColdStart(ctx); err != nil {
		t.Fatalf("second ColdStart: %v", err)
	}
	assertPathHolds(t, g, filepath.Join("a", "note.md"), "dup-0001")
	assertNotIndexed(t, g, filepath.Join("c", "note.md"))
	assertReported(t, rec, filepath.Join("c", "note.md"), reconcile.ReportDuplicateID)
}

// TestColdStart_DropsTheReportOfAFileThatIsGone: a cold start walks the whole
// vault, so a report for a path it no longer finds is stale.
func TestColdStart_DropsTheReportOfAFileThatIsGone(t *testing.T) {
	ctx := context.Background()
	_, vault, rec := newColdStartHarness(t)

	writeFile(t, filepath.Join(vault, "note.md"), duplicatedNote)
	if err := rec.ColdStart(ctx); err != nil {
		t.Fatalf("ColdStart: %v", err)
	}
	conflict := filepath.Join(vault, "00-conflict.md")
	writeFile(t, conflict, duplicatedNote)
	if err := rec.ColdStart(ctx); err != nil {
		t.Fatalf("ColdStart: %v", err)
	}
	assertReported(t, rec, "00-conflict.md", reconcile.ReportDuplicateID)

	if err := os.Remove(conflict); err != nil {
		t.Fatal(err)
	}
	if err := rec.ColdStart(ctx); err != nil {
		t.Fatalf("ColdStart: %v", err)
	}
	assertNoReports(t, rec)
}
