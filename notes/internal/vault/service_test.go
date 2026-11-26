package vault

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
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

// A folder's directory delete reaches OnDirDelete: renamed inside the vault,
// its notes keep their ids through the changes at the new path; removed, they
// are tombstoned when the window ends.
func TestRouteDirDeleteFollowsTheFolder(t *testing.T) {
	rs := newRoutedService(t)
	kept := rs.write(t, "projects/kept.md", noteText("kept", "Kept"))
	gone := rs.write(t, "scratch/gone.md", noteText("gone", "Gone"))
	rs.route(watcher.KindChange, kept)
	rs.route(watcher.KindChange, gone)

	move(t, filepath.Join(rs.root, "projects"), filepath.Join(rs.root, "renamed"))
	if err := os.RemoveAll(filepath.Join(rs.root, "scratch")); err != nil {
		t.Fatal(err)
	}
	rs.route(watcher.KindDirDelete, filepath.Join(rs.root, "projects"))
	rs.route(watcher.KindDirDelete, filepath.Join(rs.root, "scratch"))
	rs.route(watcher.KindChange, filepath.Join(rs.root, "renamed", "kept.md"))
	rs.endWindow(t)

	if !liveNote(t, rs.g, "kept") || cachedPath(t, rs.g, "kept") != filepath.Join("renamed", "kept.md") {
		t.Errorf("the renamed folder's note: live=%v at %q, want live at renamed/kept.md",
			liveNote(t, rs.g, "kept"), cachedPath(t, rs.g, "kept"))
	}
	if liveNote(t, rs.g, "gone") {
		t.Error("the removed folder's note is still live after the window")
	}
}

// fakeSource stands in for the watcher: the test pushes events into it and
// sets its dropped flag by hand.
type fakeSource struct {
	events   chan watcher.ChangeEvent
	dropped  atomic.Bool
	started  atomic.Bool
	stopped  atomic.Bool
	stopOnce sync.Once
}

func newFakeSource() *fakeSource {
	return &fakeSource{events: make(chan watcher.ChangeEvent, 16)}
}

func (f *fakeSource) Start(context.Context) error        { f.started.Store(true); return nil }
func (f *fakeSource) Events() <-chan watcher.ChangeEvent { return f.events }
func (f *fakeSource) TakeDropped() bool                  { return f.dropped.Swap(false) }
func (f *fakeSource) Stop() {
	f.stopOnce.Do(func() {
		f.stopped.Store(true)
		close(f.events)
	})
}

// newTestService is a service over a file-backed graph and a fresh vault,
// with short windows; files maps vault-relative paths to their content,
// written before anything starts.
func newTestService(t *testing.T, files map[string]string) (*Service, *graph.Graph, string) {
	t.Helper()
	g := testutil.NewTestGraph(t)
	root := t.TempDir()
	for rel, content := range files {
		path := filepath.Join(root, rel)
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	cfg := config.VaultConfig{Root: root, CoalesceWindowMs: 50, MoveWindowMs: 50}
	ApplyDefaults(&cfg)
	s := New(g, cfg)
	t.Cleanup(s.Stop)
	return s, g, root
}

// withFakeSource makes s use src instead of a real watcher.
func withFakeSource(s *Service, src *fakeSource) {
	s.newSource = func(string, watcher.Config) (eventSource, error) { return src, nil }
}

// The OS watches are armed before the first index, and nothing drains the
// events until it has returned: an event raised while it runs waits, then
// reaches the reconciler.
func TestStartArmsTheWatcherBeforeTheFirstIndexAndRoutesAfterIt(t *testing.T) {
	s, g, root := newTestService(t, nil)
	src := newFakeSource()
	withFakeSource(s, src)
	coldStart := s.coldStart
	var armed, buffered bool
	s.coldStart = func(ctx context.Context) error {
		armed = src.started.Load()
		if err := coldStart(ctx); err != nil {
			return err
		}
		path := filepath.Join(root, "during.md")
		if err := os.WriteFile(path, []byte(noteText("during", "During")), 0o644); err != nil {
			return err
		}
		src.events <- watcher.ChangeEvent{Kind: watcher.KindChange, Path: path}
		// Time for a router that was already running to take the event.
		time.Sleep(100 * time.Millisecond)
		buffered = len(src.events) == 1 && !liveNote(t, g, "during")
		return nil
	}

	if err := s.Start(context.Background()); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if !armed {
		t.Error("the watcher was not started before the first index")
	}
	if !buffered {
		t.Error("an event was routed while the first index ran")
	}
	waitFor(t, 5*time.Second, "the event raised during the first index is applied", func() bool {
		return liveNote(t, g, "during")
	})
}

// A first index that fails, or is cancelled, stops the watcher it armed.
func TestStartStopsTheWatcherWhenTheFirstIndexFails(t *testing.T) {
	for name, fail := range map[string]func(ctx context.Context, cancel context.CancelFunc) error{
		"failure": func(context.Context, context.CancelFunc) error { return errors.New("disk on fire") },
		"cancelled": func(ctx context.Context, cancel context.CancelFunc) error {
			cancel()
			<-ctx.Done()
			return ctx.Err()
		},
	} {
		t.Run(name, func(t *testing.T) {
			s, _, _ := newTestService(t, nil)
			src := newFakeSource()
			withFakeSource(s, src)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			s.coldStart = func(inner context.Context) error { return fail(inner, cancel) }

			if err := s.Start(ctx); err == nil {
				t.Fatal("Start succeeded although the first index failed")
			}
			if !src.stopped.Load() {
				t.Error("the watcher armed for the first index was left running")
			}
		})
	}
}

// Status is safe to read from any goroutine from New on: indexing is true
// until the first index returns, and the report counts are read while the
// index writes them. Run under -race.
func TestStatusIsReadableDuringTheFirstIndex(t *testing.T) {
	files := map[string]string{"placeholder.md": ""}
	for i := 0; i < 50; i++ {
		files[fmt.Sprintf("notes/n%02d.md", i)] = fmt.Sprintf("# Note %d\n", i)
	}
	s, _, _ := newTestService(t, files)
	withFakeSource(s, newFakeSource())

	if st := s.Status(); !st.Indexing {
		t.Fatal("Status before Start says the index is finished")
	}
	coldStart := s.coldStart
	entered, release := make(chan struct{}), make(chan struct{})
	s.coldStart = func(ctx context.Context) error {
		close(entered)
		<-release
		return coldStart(ctx)
	}

	started := make(chan error, 1)
	go func() { started <- s.Start(context.Background()) }()
	<-entered
	st := s.Status()
	if !st.Indexing {
		t.Error("Status says the index is finished while it runs")
	}
	for _, kind := range reconcile.ReportKinds() {
		if _, ok := st.Reports[kind]; !ok {
			t.Errorf("Status has no count for %s", kind)
		}
	}

	stop := make(chan struct{})
	var readers sync.WaitGroup
	for i := 0; i < 4; i++ {
		readers.Add(1)
		go func() {
			defer readers.Done()
			for {
				select {
				case <-stop:
					return
				default:
					_ = s.Status()
				}
			}
		}()
	}
	close(release)
	if err := <-started; err != nil {
		t.Fatalf("Start: %v", err)
	}
	close(stop)
	readers.Wait()

	st = s.Status()
	if st.Indexing {
		t.Error("Status still says indexing after the first index returned")
	}
	if st.Reports[reconcile.ReportEmptyFile] != 1 {
		t.Errorf("empty_file count = %d, want 1", st.Reports[reconcile.ReportEmptyFile])
	}
}

// Against the real watcher: a note written after the first index has walked
// past, but before it returns, is indexed - its event used to fall between the
// index and a watcher started after it.
func TestAnEventDuringTheFirstIndexIsNotLost(t *testing.T) {
	s, g, root := newTestService(t, map[string]string{"existing.md": noteText("existing", "Existing")})
	coldStart := s.coldStart
	first := true
	s.coldStart = func(ctx context.Context) error {
		err := coldStart(ctx)
		if first {
			first = false
			if werr := os.WriteFile(filepath.Join(root, "late.md"), []byte(noteText("late", "Late")), 0o644); werr != nil {
				return werr
			}
		}
		return err
	}

	if err := s.Start(context.Background()); err != nil {
		t.Fatalf("Start: %v", err)
	}
	waitFor(t, 5*time.Second, "the note written during the first index is indexed", func() bool {
		return liveNote(t, g, "late")
	})
}

// blockedWatcherSends counts goroutines of the watcher package parked on a
// channel send.
func blockedWatcherSends() int {
	buf := make([]byte, 1<<20)
	for {
		n := runtime.Stack(buf, true)
		if n < len(buf) {
			buf = buf[:n]
			break
		}
		buf = make([]byte, 2*len(buf))
	}
	blocked := 0
	for _, g := range strings.Split(string(buf), "\n\n") {
		header, _, _ := strings.Cut(g, "\n")
		if strings.Contains(header, "[chan send") && strings.Contains(g, "/internal/vault/watcher.") {
			blocked++
		}
	}
	return blocked
}

// A first run over a few hundred id-less notes writes an id into each, and
// every write raises an event while nothing drains them. No coalescer is left
// blocked on the full buffer, and each note is written to the graph once: the
// events of the cold start's own writes find the cache already up to date.
func TestFirstRunOverIdlessNotesBlocksNothingAndWritesEachNoteOnce(t *testing.T) {
	const count = 300
	files := map[string]string{}
	for i := 0; i < count; i++ {
		files[fmt.Sprintf("dir%d/note-%03d.md", i%3, i)] = fmt.Sprintf("# Note %d\n\nbody %d\n", i, i)
	}
	s, g, root := newTestService(t, files)
	coldStart := s.coldStart
	first := true
	blocked := -1
	s.coldStart = func(ctx context.Context) error {
		err := coldStart(ctx)
		if first {
			first = false
			// Every coalescer of the id writes fires within a few windows.
			time.Sleep(300 * time.Millisecond)
			blocked = blockedWatcherSends()
		}
		return err
	}

	if err := s.Start(context.Background()); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if blocked != 0 {
		t.Errorf("%d watcher goroutines blocked sending while the first index ran", blocked)
	}

	// A sentinel written now is routed after every event the first run
	// raised, so once it is indexed those have all been handled.
	if err := os.WriteFile(filepath.Join(root, "sentinel.md"), []byte(noteText("sentinel", "Sentinel")), 0o644); err != nil {
		t.Fatal(err)
	}
	waitFor(t, 10*time.Second, "the sentinel is indexed", func() bool { return liveNote(t, g, "sentinel") })

	if got := s.r.Stats().EventsProcessed; got != count+1 {
		t.Errorf("events processed = %d, want %d: one write per note and the sentinel", got, count+1)
	}
	if got := countLiveNotes(t, g); got != count+1 {
		t.Errorf("live notes = %d, want %d", got, count+1)
	}
}

// An overflow during live running - the watcher's dropped flag set after the
// first index - is followed by exactly one rescan on the next flush tick,
// which finds the change no event reported.
func TestADroppedEventDuringLiveRunningIsFollowedByOneRescan(t *testing.T) {
	s, g, root := newTestService(t, map[string]string{"drift.md": noteText("drift", "Drift")})
	src := newFakeSource()
	withFakeSource(s, src)
	coldStart := s.coldStart
	// Counted when a pass has finished, so the check below reads its result.
	var passes atomic.Int32
	s.coldStart = func(ctx context.Context) error {
		err := coldStart(ctx)
		passes.Add(1)
		return err
	}
	if err := s.Start(context.Background()); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if got := passes.Load(); got != 1 {
		t.Fatalf("passes after Start = %d, want the first index only", got)
	}

	path := filepath.Join(root, "drift.md")
	if err := os.WriteFile(path, []byte(noteText("drift", "Drift")+"\nchanged while events were lost\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	src.dropped.Store(true)
	waitFor(t, 5*time.Second, "a rescan after the drop", func() bool { return passes.Load() == 2 })
	if n := getNote(t, g, "drift"); !strings.Contains(n.Body, "changed while events were lost") {
		t.Errorf("the rescan did not pick up the change: body %q", n.Body)
	}

	// Several more ticks: the flag was cleared, so no second rescan.
	time.Sleep(300 * time.Millisecond)
	if got := passes.Load(); got != 2 {
		t.Errorf("passes = %d after the flag was taken, want 2", got)
	}
}
