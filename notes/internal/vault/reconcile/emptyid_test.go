package reconcile_test

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/gabrielassisxyz/houston/notes/internal/graph/testutil"
	"github.com/gabrielassisxyz/houston/notes/internal/vault/frontmatter"
	"github.com/gabrielassisxyz/houston/notes/internal/vault/reconcile"
)

// TestEmptyIDLineGetsTheIDOnce drives the reconciler over a note whose id line
// is present and empty. The injector used to hand such a note back unchanged
// while the reconciler recorded a freshly minted id for it, so the file never
// carried the id it was indexed under and every event wrote it again. The id
// must land in the file, match the node, and a second event must write
// nothing.
func TestEmptyIDLineGetsTheIDOnce(t *testing.T) {
	// The subtests are named rather than titled by the value: the in-memory
	// graph is keyed by the test name, and a '#' in it breaks the database URI.
	values := []struct{ name, value string }{
		{"bare", ""}, {"null", "null"}, {"NULL", "NULL"}, {"tilde", "~"}, {"comment", "# filled in later"},
	}
	for _, tc := range values {
		value := tc.value
		t.Run(tc.name, func(t *testing.T) {
			ctx := context.Background()
			g := testutil.NewInMemoryTestGraph(t)
			vault := t.TempDir()
			rec := reconcile.New(g, vault)

			path := filepath.Join(vault, "empty-id.md")
			writeFile(t, path, "---\ntitle: Empty id\nid: "+value+"\n---\n\nBody.\n")
			if err := rec.OnCreate(ctx, path); err != nil {
				t.Fatalf("OnCreate: %v", err)
			}

			raw, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			fm, err := frontmatter.Parse(raw)
			if err != nil {
				t.Fatalf("the injected note does not parse: %v\n%q", err, raw)
			}
			if fm.ID == "" {
				t.Fatalf("the file still carries no id:\n%q", raw)
			}
			indexed, found, err := reconcile.Lookup(ctx, g, "empty-id.md")
			if err != nil || !found {
				t.Fatalf("Lookup: found=%v err=%v", found, err)
			}
			if indexed != fm.ID {
				t.Fatalf("indexed under %q but the file carries %q", indexed, fm.ID)
			}

			// Age the file, so any later write shows up as a new mtime.
			past := time.Now().Add(-time.Hour).Truncate(time.Second)
			if err := os.Chtimes(path, past, past); err != nil {
				t.Fatal(err)
			}
			if err := rec.OnChange(ctx, path); err != nil {
				t.Fatalf("OnChange: %v", err)
			}
			info, err := os.Stat(path)
			if err != nil {
				t.Fatal(err)
			}
			if !info.ModTime().Equal(past) {
				t.Errorf("the second event wrote the file again (mtime %v, want %v)", info.ModTime(), past)
			}
			again, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			if string(again) != string(raw) {
				t.Errorf("the second event changed the file:\n%q\nwas\n%q", again, raw)
			}
			if n := countLiveNotes(t, g); n != 1 {
				t.Errorf("live notes = %d, want 1", n)
			}
		})
	}
}
