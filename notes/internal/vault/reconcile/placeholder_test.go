package reconcile_test

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/gabrielassisxyz/houston/notes/internal/vault/reconcile"
)

// unindexable are the files the reconciler neither indexes nor writes. The
// UTF-8 case carries no frontmatter, which is the shape the injector used to
// prepend a block to.
var unindexable = []struct {
	name    string
	content string
	kind    reconcile.ReportKind
}{
	{"empty", "", reconcile.ReportEmptyFile},
	{"invalid UTF-8", "plain \xff\xfe text\n", reconcile.ReportInvalidUTF8},
}

// TestUnindexableFileIsLeftUntouched covers OnCreate, OnChange and the cold
// start: the file keeps its bytes, gets no row, and is reported.
func TestUnindexableFileIsLeftUntouched(t *testing.T) {
	for _, tc := range unindexable {
		t.Run(tc.name, func(t *testing.T) {
			ctx := context.Background()
			g, vault, rec := newColdStartHarness(t)
			path := filepath.Join(vault, "placeholder.md")
			writeFile(t, path, tc.content)

			steps := map[string]func() error{
				"OnCreate":  func() error { return rec.OnCreate(ctx, path) },
				"OnChange":  func() error { return rec.OnChange(ctx, path) },
				"ColdStart": func() error { return rec.ColdStart(ctx) },
			}
			for _, step := range []string{"OnCreate", "OnChange", "ColdStart"} {
				if err := steps[step](); err != nil {
					t.Fatalf("%s: %v", step, err)
				}
				raw, err := os.ReadFile(path)
				if err != nil {
					t.Fatal(err)
				}
				if string(raw) != tc.content {
					t.Fatalf("%s wrote into the file: %q", step, raw)
				}
				assertNotIndexed(t, g, "placeholder.md")
				assertReported(t, rec, "placeholder.md", tc.kind)
			}
			if n := countAllNodes(t, g); n != 0 {
				t.Fatalf("nodes = %d, want 0", n)
			}
		})
	}
}

// TestDeletingASkippedFileClearsItsReport: the file never had a row, so
// OnDelete's lookup finds nothing, and the report must go anyway.
func TestDeletingASkippedFileClearsItsReport(t *testing.T) {
	ctx := context.Background()
	_, vault, rec := newColdStartHarness(t)
	path := filepath.Join(vault, "placeholder.md")
	writeFile(t, path, "")
	if err := rec.OnChange(ctx, path); err != nil {
		t.Fatalf("OnChange: %v", err)
	}
	assertReported(t, rec, "placeholder.md", reconcile.ReportEmptyFile)

	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := rec.OnDelete(ctx, path); err != nil {
		t.Fatalf("OnDelete: %v", err)
	}
	assertNoReports(t, rec)
}

// TestFillingAPlaceholderIndexesIt: once the content arrives, the next event
// indexes the note and the report goes.
func TestFillingAPlaceholderIndexesIt(t *testing.T) {
	ctx := context.Background()
	g, vault, rec := newColdStartHarness(t)
	path := filepath.Join(vault, "placeholder.md")
	writeFile(t, path, "")
	if err := rec.OnChange(ctx, path); err != nil {
		t.Fatalf("OnChange: %v", err)
	}
	writeFile(t, path, "---\nid: filled-1\ntitle: Filled\n---\n\nArrived.\n")
	if err := routeChange(ctx, rec, path); err != nil {
		t.Fatalf("change: %v", err)
	}
	assertPathHolds(t, g, "placeholder.md", "filled-1")
	assertNoReports(t, rec)
}

// TestIndexedNoteSurvivesItsFileBeingSkipped is a sync client replacing an
// indexed note with a placeholder, or the file becoming unreadable or
// malformed for a while. The walk skips the file, and the tombstone sweep used
// to read that as the note being gone.
func TestIndexedNoteSurvivesItsFileBeingSkipped(t *testing.T) {
	const indexed = "---\nid: survivor-1\ntitle: Survivor\n---\n\nThe note.\n"
	cases := map[string]func(t *testing.T, path string){
		"emptied": func(t *testing.T, path string) {
			writeFile(t, path, "")
		},
		"not UTF-8": func(t *testing.T, path string) {
			writeFile(t, path, "---\nid: survivor-1\ntitle: \xff\n---\n")
		},
		"malformed": func(t *testing.T, path string) {
			writeFile(t, path, "---\nid: survivor-1\ntitle: never closed\n")
		},
		"unreadable": func(t *testing.T, path string) {
			if os.Geteuid() == 0 {
				t.Skip("root reads a file whatever its mode")
			}
			if err := os.Chmod(path, 0o000); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = os.Chmod(path, 0o644) })
		},
	}
	for name, damage := range cases {
		t.Run(name, func(t *testing.T) {
			ctx := context.Background()
			g, vault, rec := newColdStartHarness(t)
			path := filepath.Join(vault, "note.md")
			writeFile(t, path, indexed)
			if err := rec.ColdStart(ctx); err != nil {
				t.Fatalf("ColdStart: %v", err)
			}
			damage(t, path)

			if err := reconcile.New(g, vault).ColdStart(ctx); err != nil {
				t.Fatalf("ColdStart: %v", err)
			}
			assertPathHolds(t, g, "note.md", "survivor-1")
			if !isLiveNote(t, g, "survivor-1") {
				t.Fatal("the note was tombstoned because its file was skipped")
			}
		})
	}
}
