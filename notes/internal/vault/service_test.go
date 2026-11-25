package vault

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/gabrielassisxyz/houston/notes/internal/config"
	"github.com/gabrielassisxyz/houston/notes/internal/graph"
	"github.com/gabrielassisxyz/houston/notes/internal/graph/search"
	"github.com/gabrielassisxyz/houston/notes/internal/graph/testutil"
	"github.com/gabrielassisxyz/houston/notes/internal/vault/reconcile"
	"github.com/gabrielassisxyz/houston/notes/internal/vault/watcher"
)

// testClock is the reconciler's clock, advanced by hand so a move window
// ends on command instead of after a sleep.
type testClock struct{ now time.Time }

func (c *testClock) Now() time.Time          { return c.now }
func (c *testClock) Advance(d time.Duration) { c.now = c.now.Add(d) }

// routedService is a service whose events the test hands to route directly,
// with no watcher, over an in-memory graph and a fresh vault.
type routedService struct {
	s     *Service
	g     *graph.Graph
	root  string
	clock *testClock
}

func newRoutedService(t *testing.T) *routedService {
	t.Helper()
	g := testutil.NewInMemoryTestGraph(t)
	root := t.TempDir()
	cfg := config.VaultConfig{Root: root}
	ApplyDefaults(&cfg)
	r := reconcile.New(g, root)
	clock := &testClock{now: time.Now()}
	r.SetClock(clock.Now)
	r.SetDeleteWindow(time.Second)
	return &routedService{s: &Service{g: g, cfg: cfg, r: r}, g: g, root: root, clock: clock}
}

func (rs *routedService) write(t *testing.T, rel, content string) string {
	t.Helper()
	path := filepath.Join(rs.root, rel)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func (rs *routedService) route(kind watcher.EventKind, path string) {
	rs.s.route(context.Background(), watcher.ChangeEvent{Kind: kind, Path: path})
}

// endWindow moves the clock past the move window and flushes it.
func (rs *routedService) endWindow(t *testing.T) {
	t.Helper()
	rs.clock.Advance(2 * time.Second)
	if _, err := rs.s.r.FlushExpired(context.Background()); err != nil {
		t.Fatalf("FlushExpired: %v", err)
	}
}

func liveNote(t *testing.T, g *graph.Graph, id string) bool {
	t.Helper()
	var n int
	if err := g.DoRead(context.Background(), func(tx *graph.ReadTx) error {
		return tx.QueryRow(
			`SELECT COUNT(*) FROM nodes WHERE id = ? AND type = 'note' AND deleted_at IS NULL`, id,
		).Scan(&n)
	}); err != nil {
		t.Fatalf("liveNote %s: %v", id, err)
	}
	return n == 1
}

func searchHas(t *testing.T, g *graph.Graph, query, id string) bool {
	t.Helper()
	found := false
	if err := g.DoRead(context.Background(), func(tx *graph.ReadTx) error {
		hits, err := search.Search(context.Background(), tx, query, search.WithTypes("note"))
		for _, h := range hits {
			if h.NodeID == id {
				found = true
			}
		}
		return err
	}); err != nil {
		t.Fatalf("search %q: %v", query, err)
	}
	return found
}

func cachedPath(t *testing.T, g *graph.Graph, id string) string {
	t.Helper()
	rel, _, err := reconcile.LookupByUUID(context.Background(), g, id)
	if err != nil {
		t.Fatalf("LookupByUUID %s: %v", id, err)
	}
	return rel
}

func noteText(id, title string) string {
	return "---\nid: " + id + "\ntitle: " + title + "\n---\n\n" + title + " body\n"
}

func move(t *testing.T, from, to string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(to), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(from, to); err != nil {
		t.Fatal(err)
	}
}

// fsnotify reports the rename on the old path only when the note goes where
// nothing is watched: into .trash/, as the service's own delete route and
// Obsidian do, or out of the vault. Such a note leaves search when the move
// window ends instead of at the next start.
func TestRouteMoveCandidateWithNoNewPathLeavesSearchAfterTheWindow(t *testing.T) {
	for name, dest := range map[string]func(rs *routedService) string{
		"into .trash": func(rs *routedService) string { return filepath.Join(rs.root, ".trash", "notes", "leaving.md") },
		"out of the vault": func(rs *routedService) string {
			return filepath.Join(t.TempDir(), "elsewhere", "leaving.md")
		},
	} {
		t.Run(name, func(t *testing.T) {
			rs := newRoutedService(t)
			old := rs.write(t, "notes/leaving.md", noteText("leaving", "Departure"))
			rs.route(watcher.KindChange, old)
			if !searchHas(t, rs.g, "Departure", "leaving") {
				t.Fatal("fixture note is not searchable")
			}

			move(t, old, dest(rs))
			rs.route(watcher.KindMoveCandidate, old)
			if !liveNote(t, rs.g, "leaving") {
				t.Fatal("tombstoned at once; the move window must be kept")
			}

			rs.endWindow(t)
			if liveNote(t, rs.g, "leaving") || searchHas(t, rs.g, "Departure", "leaving") {
				t.Error("a note moved out of reach is still live in search after the window")
			}
		})
	}
}

// A move inside the vault: the rename on the old path, then the change at the
// new one, keeps the note's identity.
func TestRouteMoveCandidateInsideTheVaultKeepsTheId(t *testing.T) {
	rs := newRoutedService(t)
	old := rs.write(t, "inbox/moving.md", noteText("moving", "Relocation"))
	rs.route(watcher.KindChange, old)

	dest := filepath.Join(rs.root, "archive", "moving.md")
	move(t, old, dest)
	rs.route(watcher.KindMoveCandidate, old)
	rs.route(watcher.KindChange, dest)
	rs.endWindow(t)

	if !liveNote(t, rs.g, "moving") {
		t.Fatal("a note moved inside the vault was tombstoned")
	}
	if got := cachedPath(t, rs.g, "moving"); got != filepath.Join("archive", "moving.md") {
		t.Errorf("cached path = %q, want archive/moving.md", got)
	}
}

// A delete and a recreate inside one coalesce window come out as one delete
// for a file that is back on disk; the note stays.
func TestRouteDeleteOfAFileBackOnDiskKeepsTheNote(t *testing.T) {
	rs := newRoutedService(t)
	path := rs.write(t, "rewritten.md", noteText("rewritten", "Rewritten"))
	rs.route(watcher.KindChange, path)

	rs.route(watcher.KindDelete, path)
	rs.endWindow(t)

	if !liveNote(t, rs.g, "rewritten") {
		t.Error("a delete for a file still on disk tombstoned its note")
	}
}
