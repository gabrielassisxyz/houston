package watcher

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/fsnotify/fsnotify"
)

// drain returns every event already emitted, without waiting for more.
func drain(w *Watcher) []ChangeEvent {
	var out []ChangeEvent
	for {
		select {
		case ev, ok := <-w.Events():
			if !ok {
				return out
			}
			out = append(out, ev)
		default:
			return out
		}
	}
}

// startInjectedAt is startInjected with a root of the test's choosing.
func startInjectedAt(t *testing.T, root string, sched *fakeScheduler) (*Watcher, chan fsnotify.Event) {
	t.Helper()
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	raw := make(chan fsnotify.Event, 64)
	w := newWithSources(root, Config{CoalesceWindow: time.Hour}, sched, raw, make(chan error, 1))
	if err := w.Start(context.Background()); err != nil {
		t.Fatalf("Start: %v", err)
	}
	t.Cleanup(w.Stop)
	return w, raw
}

// A vault kept under a dot-named directory is watched: only the components
// below the root decide whether a path is hidden.
func TestLiveEventsUnderADotNamedParentAreEmitted(t *testing.T) {
	sched := &fakeScheduler{}
	w, raw := startInjectedAt(t, filepath.Join(t.TempDir(), ".test", "vault"), sched)

	feed(t, sched, raw, 1, fsnotify.Event{Name: under(w, "note.md"), Op: fsnotify.Write})
	sched.fireDue()

	if got := drain(w); len(got) != 1 || got[0].Path != under(w, "note.md") {
		t.Fatalf("events = %+v, want one change for note.md", got)
	}
}

// Dot-files and files in dot-directories below the root raise no event, and a
// path outside the root is refused rather than read as a dot-path.
func TestLiveEventsSkipDotPathsAndPathsOutsideTheRoot(t *testing.T) {
	sched := &fakeScheduler{}
	w, raw := startInjectedAt(t, t.TempDir(), sched)

	for _, name := range []string{
		under(w, ".hidden.md"),
		under(w, ".obsidian/workspace.md"),
		under(w, "notes/.sync/conflict.md"),
		filepath.Join(w.root, "..", "outside.md"),
	} {
		raw <- fsnotify.Event{Name: name, Op: fsnotify.Write}
	}
	// A visible note after them proves the loop read the four first.
	feed(t, sched, raw, 1, fsnotify.Event{Name: under(w, "visible.md"), Op: fsnotify.Write})
	if n := sched.scheduled(); n != 1 {
		t.Fatalf("%d coalescers scheduled, want only the visible note's", n)
	}
	sched.fireDue()
	if got := drain(w); len(got) != 1 || got[0].Path != under(w, "visible.md") {
		t.Fatalf("events = %+v, want one change for visible.md", got)
	}
}

// The note extension is matched without regard to case.
func TestLiveEventsMatchTheNoteExtensionWithoutCase(t *testing.T) {
	sched := &fakeScheduler{}
	w, raw := startInjectedAt(t, t.TempDir(), sched)

	feed(t, sched, raw, 2,
		fsnotify.Event{Name: under(w, "Upper.MD"), Op: fsnotify.Write},
		fsnotify.Event{Name: under(w, "mixed.Md"), Op: fsnotify.Write},
	)
	sched.fireDue()
	if got := drain(w); len(got) != 2 {
		t.Fatalf("events = %+v, want a change for each of Upper.MD and mixed.Md", got)
	}
}
