package watcher

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"testing"
	"time"

	"github.com/fsnotify/fsnotify"
)

func mkfile(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("note\n"), 0o644); err != nil {
		t.Fatal(err)
	}
}

// startWithBackend starts a watcher on a fresh root with the test's clock, raw
// events and fake OS watches. setup runs before Start, so the directories it
// makes are tracked from the beginning.
func startWithBackend(t *testing.T, setup func(root string)) (*Watcher, *fakeScheduler, *fakeBackend, chan fsnotify.Event) {
	t.Helper()
	root := t.TempDir()
	if setup != nil {
		setup(root)
	}
	sched := &fakeScheduler{}
	backend := &fakeBackend{}
	raw := make(chan fsnotify.Event, 64)
	w := newWithSources(root, Config{CoalesceWindow: time.Hour}, sched, raw, make(chan error, 1), backend)
	if err := w.Start(context.Background()); err != nil {
		t.Fatalf("Start: %v", err)
	}
	t.Cleanup(w.Stop)
	return w, sched, backend, raw
}

func eventPaths(evs []ChangeEvent, kind EventKind) []string {
	var out []string
	for _, ev := range evs {
		if ev.Kind == kind {
			out = append(out, ev.Path)
		}
	}
	sort.Strings(out)
	return out
}

// A directory moved into the vault arrives as one event on the directory. It is
// watched recursively, dot-directories excepted, and every note inside it is
// reported as a change, since no event will ever name them.
func TestDirectoryMovedInIsWatchedAndReportsItsNotes(t *testing.T) {
	for _, op := range []fsnotify.Op{fsnotify.Create, fsnotify.Rename} {
		t.Run(op.String(), func(t *testing.T) {
			w, sched, backend, raw := startWithBackend(t, nil)
			moved := under(w, "moved")
			mkfile(t, filepath.Join(moved, "a.md"))
			mkfile(t, filepath.Join(moved, "sub", "B.MD"))
			mkfile(t, filepath.Join(moved, ".sync", "c.md"))
			mkfile(t, filepath.Join(moved, "readme.txt"))

			feed(t, sched, raw, 2, fsnotify.Event{Name: moved, Op: op})
			sched.fireDue()

			want := []string{filepath.Join(moved, "a.md"), filepath.Join(moved, "sub", "B.MD")}
			if got := eventPaths(drain(w), KindChange); !reflect.DeepEqual(got, want) {
				t.Errorf("changes = %v, want %v", got, want)
			}
			added, _ := backend.snapshot()
			wantAdded := []string{w.root, moved, filepath.Join(moved, "sub")}
			if !reflect.DeepEqual(added, wantAdded) {
				t.Errorf("watches added = %v, want %v", added, wantAdded)
			}
			if !w.isTrackedDir(filepath.Join(moved, "sub")) {
				t.Error("the moved-in subdirectory is not tracked")
			}
		})
	}
}

// A tracked directory removed or renamed away is no longer a directory on
// disk: it is recognised by the directory set, pruned with its subdirectories,
// its OS watches removed, and one directory-delete event emitted.
func TestDirectoryMovedOutEmitsADirectoryDelete(t *testing.T) {
	for _, op := range []fsnotify.Op{fsnotify.Rename, fsnotify.Remove} {
		t.Run(op.String(), func(t *testing.T) {
			var gone, deep string
			w, sched, backend, raw := startWithBackend(t, func(root string) {
				gone = filepath.Join(root, "gone")
				deep = filepath.Join(gone, "deep")
				mkfile(t, filepath.Join(deep, "n.md"))
				mkfile(t, filepath.Join(root, "gone-sibling", "keep.md"))
			})
			if err := os.RemoveAll(gone); err != nil {
				t.Fatal(err)
			}

			feed(t, sched, raw, 1, fsnotify.Event{Name: gone, Op: op})
			// The directory's own watch reports the same path again; it is no
			// longer tracked, so nothing more is scheduled.
			raw <- fsnotify.Event{Name: gone, Op: op}
			feed(t, sched, raw, 2, fsnotify.Event{Name: under(w, "later.md"), Op: fsnotify.Write})
			sched.fireDue()

			evs := drain(w)
			if got := eventPaths(evs, KindDirDelete); !reflect.DeepEqual(got, []string{gone}) {
				t.Errorf("directory deletes = %v, want [%s] (events %+v)", got, gone, evs)
			}
			_, removed := backend.snapshot()
			sort.Strings(removed)
			if want := []string{gone, deep}; !reflect.DeepEqual(removed, want) {
				t.Errorf("watches removed = %v, want %v", removed, want)
			}
			if w.isTrackedDir(gone) || w.isTrackedDir(deep) {
				t.Error("the removed tree is still tracked")
			}
			if !w.isTrackedDir(filepath.Join(w.root, "gone-sibling")) {
				t.Error("a sibling sharing the name's prefix was pruned with it")
			}
		})
	}
}

// Against the real inotify backend: a folder renamed inside the vault reports
// a directory delete for the old path and a change for each note at the new
// one, and the new location is watched.
func TestWatcherFollowsAFolderRenamedInsideTheVault(t *testing.T) {
	dir := t.TempDir()
	mkfile(t, filepath.Join(dir, "old", "inner", "n.md"))

	w, err := New(dir, Config{CoalesceWindow: 50 * time.Millisecond})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if err := w.Start(context.Background()); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer w.Stop()

	oldDir, newDir := filepath.Join(dir, "old"), filepath.Join(dir, "new")
	if err := os.Rename(oldDir, newDir); err != nil {
		t.Fatal(err)
	}
	moved := filepath.Join(newDir, "inner", "n.md")

	var gotDirDelete, gotMoved bool
	timeout := time.After(3 * time.Second)
	for !gotDirDelete || !gotMoved {
		select {
		case ev := <-w.Events():
			switch {
			case ev.Kind == KindDirDelete && ev.Path == oldDir:
				gotDirDelete = true
			case ev.Kind == KindChange && ev.Path == moved:
				gotMoved = true
			}
		case <-timeout:
			t.Fatalf("after the rename: dir delete of old=%v, change of the moved note=%v", gotDirDelete, gotMoved)
		}
	}

	// The note's new directory is watched: an edit there is reported.
	if err := os.WriteFile(moved, []byte("edited\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	timeout = time.After(3 * time.Second)
	for {
		select {
		case ev := <-w.Events():
			if ev.Kind == KindChange && ev.Path == moved {
				return
			}
		case <-timeout:
			t.Fatal("an edit in the renamed folder raised no event")
		}
	}
}
