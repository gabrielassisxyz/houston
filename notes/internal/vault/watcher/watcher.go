// Package watcher provides recursive filesystem watching for .md files
// using fsnotify with per-path event coalescing.
package watcher

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/fsnotify/fsnotify"

	"github.com/gabrielassisxyz/houston/notes/internal/vault/vaultfile"
)

// EventKind represents the type of a filesystem change event.
type EventKind string

const (
	KindCreate        EventKind = "create"
	KindChange        EventKind = "change"
	KindDelete        EventKind = "delete"
	KindMoveCandidate EventKind = "move_candidate"
	// KindDirDelete reports a tracked directory removed or renamed away. No
	// event names the notes it held, and the watcher has no access to the
	// index, so the reconciler looks them up under the directory's path.
	KindDirDelete EventKind = "dir_delete"
)

// ChangeEvent is a normalized filesystem event emitted by the Watcher.
type ChangeEvent struct {
	Kind           EventKind `json:"kind"`
	Path           string    `json:"path"`
	CoalescedCount int       `json:"coalesced_count"`
	Timestamp      time.Time `json:"ts"`
}

// Config configures the Watcher.
type Config struct {
	// CoalesceWindow is the quiet period after the last event for a path
	// before the coalesced event is emitted. Default 300ms.
	CoalesceWindow time.Duration
}

// DefaultCoalesceWindow is the default debounce window.
const DefaultCoalesceWindow = 300 * time.Millisecond

// stoppableTimer is the part of *time.Timer this package uses. Stop reports
// whether it prevented the callback from running, which is load-bearing here:
// it is how Stop knows whether a scheduled coalescer will ever decrement the
// WaitGroup, or whether it must do so on its behalf.
type stoppableTimer interface {
	Stop() bool
}

// timerScheduler is the clock boundary. Production schedules on real time;
// tests inject a fake they advance by hand, because a coalesce window proven
// by sleeping is a test that passes on an idle laptop and fails on a loaded
// CI runner - and an injected Now() alone would not help, since what has to
// be controlled is when the callback FIRES, not what time it reports.
type timerScheduler interface {
	AfterFunc(d time.Duration, f func()) stoppableTimer
}

type realScheduler struct{}

func (realScheduler) AfterFunc(d time.Duration, f func()) stoppableTimer {
	return time.AfterFunc(d, f)
}

// notifyBackend is the part of *fsnotify.Watcher this package drives: the OS
// watches, one per directory. Tests supply a fake, so a directory moved in or
// out of the vault can be played without the OS and its timing.
type notifyBackend interface {
	Add(name string) error
	Remove(name string) error
	Close() error
}

// Watcher watches a root directory recursively for .md file changes
// and emits coalesced ChangeEvents on a channel.
type Watcher struct {
	root   string
	events chan ChangeEvent
	cfg    Config
	// backend holds the OS watches. Production passes the fsnotify watcher
	// whose channels feed rawEvents and rawErrors; tests inject both.
	backend   notifyBackend
	sched     timerScheduler
	rawEvents <-chan fsnotify.Event
	rawErrors <-chan error
	cancel    context.CancelFunc
	// shuttingDown is closed by Stop before it waits, so a coalescer already
	// past its Stop() check abandons its send instead of blocking forever on a
	// full buffer nobody is draining any more.
	shuttingDown chan struct{}
	wg           sync.WaitGroup
	mu           sync.Mutex
	closed       bool
	dirs         map[string]struct{} // tracked directories
	timers       map[string]stoppableTimer
	pending      map[string][]EventKind // pending events per path (latest kind wins)

	// dropped records that an event was lost - the events buffer was full,
	// or the kernel's own queue overflowed - so the consumer can rescan.
	dropped atomic.Bool
}

// New creates a new Watcher for the given root directory.
// The caller must call Start() to begin watching, and Stop() to shut down.
func New(root string, cfg Config) (*Watcher, error) {
	if cfg.CoalesceWindow <= 0 {
		cfg.CoalesceWindow = DefaultCoalesceWindow
	}

	absRoot, err := filepath.Abs(root)
	if err != nil {
		return nil, fmt.Errorf("resolve watcher root: %w", err)
	}

	fsw, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, fmt.Errorf("create fsnotify watcher: %w", err)
	}

	w := &Watcher{
		root:         absRoot,
		events:       make(chan ChangeEvent, 256),
		cfg:          cfg,
		backend:      fsw,
		sched:        realScheduler{},
		rawEvents:    fsw.Events,
		rawErrors:    fsw.Errors,
		shuttingDown: make(chan struct{}),
		dirs:         make(map[string]struct{}),
		timers:       make(map[string]stoppableTimer),
		pending:      make(map[string][]EventKind),
	}

	return w, nil
}

// newWithSources builds a Watcher whose clock, raw event source and OS watches
// are supplied by the caller. Only tests use it: the coalescing, shutdown and
// directory invariants are about this package's own bookkeeping, and driving
// them through real inotify delivery is what made the original test assert a
// timing window by sleeping.
func newWithSources(root string, cfg Config, sched timerScheduler, raw <-chan fsnotify.Event, rawErrs <-chan error, backend notifyBackend) *Watcher {
	if cfg.CoalesceWindow <= 0 {
		cfg.CoalesceWindow = DefaultCoalesceWindow
	}
	return &Watcher{
		root:         root,
		events:       make(chan ChangeEvent, 256),
		cfg:          cfg,
		backend:      backend,
		sched:        sched,
		rawEvents:    raw,
		rawErrors:    rawErrs,
		shuttingDown: make(chan struct{}),
		dirs:         make(map[string]struct{}),
		timers:       make(map[string]stoppableTimer),
		pending:      make(map[string][]EventKind),
	}
}

// Events returns the channel on which ChangeEvents are emitted.
func (w *Watcher) Events() <-chan ChangeEvent {
	return w.events
}

// TakeDropped reports whether an event was lost since the last call, and
// clears the flag. A true answer means the index may have missed a change
// that only a rescan of the vault will find.
func (w *Watcher) TakeDropped() bool {
	return w.dropped.Swap(false)
}

// Start begins watching the root directory recursively.
// It returns after the initial recursive walk to add watches.
func (w *Watcher) Start(ctx context.Context) error {
	// Add watches for all existing directories recursively. The notes already
	// in them are the cold start's to read, so none is reported here.
	if err := w.addDirRecursive(w.root, false); err != nil {
		w.backend.Close()
		return fmt.Errorf("add watches recursively: %w", err)
	}

	ctx, w.cancel = context.WithCancel(ctx)

	w.wg.Add(1)
	go w.loop(ctx)

	return nil
}

// Stop shuts down the watcher and closes the events channel. It is idempotent,
// and it does not return until every scheduled coalescer has finished, so a
// consumer that sees the channel close knows no further event can arrive.
//
// Every scheduled coalescer holds a WaitGroup token from the moment it is
// scheduled, which is what makes that guarantee available: an unfired timer's
// token is released here (Stop() reporting true means its callback will never
// run), and a fired one releases its own. Waiting on a WaitGroup that only
// covered the read loop - as this used to - left the callbacks unaccounted for,
// which is why closing the channel looked unsafe and was skipped.
func (w *Watcher) Stop() {
	w.mu.Lock()
	if w.closed {
		w.mu.Unlock()
		return
	}
	w.closed = true
	pending := w.timers
	w.timers = make(map[string]stoppableTimer)
	w.mu.Unlock()

	if w.cancel != nil {
		w.cancel()
	}

	// Before the wait, so a coalescer that already passed its own closed check
	// abandons its send rather than blocking on a buffer nobody drains.
	close(w.shuttingDown)

	for _, timer := range pending {
		if timer.Stop() {
			w.wg.Done()
		}
	}

	w.wg.Wait()

	w.backend.Close()
	close(w.events)
}

// addDirRecursive adds a watch for the given directory and all subdirectories,
// skipping dot-directories below the root. With reportNotes it also schedules a
// change for every note it passes: a directory moved into the vault arrives as
// one event on the directory, and no event will ever name the notes inside it.
// Errors for individual directories are logged but don't stop the walk.
func (w *Watcher) addDirRecursive(dir string, reportNotes bool) error {
	return filepath.WalkDir(dir, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		rel, relErr := vaultfile.VaultRel(w.root, path)
		if relErr != nil || vaultfile.IsHiddenRel(rel) {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if !d.IsDir() {
			if reportNotes && vaultfile.IsNoteFile(path) {
				w.schedule(path, KindCreate)
			}
			return nil
		}
		if err := w.backend.Add(path); err != nil {
			slog.Warn("watcher: add watch failed",
				"path", path,
				"error", err,
			)
			return nil
		}
		w.mu.Lock()
		w.dirs[path] = struct{}{}
		w.mu.Unlock()
		return nil
	})
}

// isTrackedDir reports whether dir has a watch of this watcher's.
func (w *Watcher) isTrackedDir(dir string) bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	_, ok := w.dirs[dir]
	return ok
}

// forgetDirTree drops dir and every tracked directory below it from the set
// and removes their OS watches, reporting whether dir was tracked. A directory
// moved out keeps its inode, so inotify would go on reporting events from it
// under the old names; removal errors are expected for a deleted directory,
// whose watch the kernel already dropped, and are ignored.
func (w *Watcher) forgetDirTree(dir string) bool {
	w.mu.Lock()
	if _, ok := w.dirs[dir]; !ok {
		w.mu.Unlock()
		return false
	}
	pruned := []string{dir}
	delete(w.dirs, dir)
	prefix := dir + string(filepath.Separator)
	for d := range w.dirs {
		if strings.HasPrefix(d, prefix) {
			delete(w.dirs, d)
			pruned = append(pruned, d)
		}
	}
	w.mu.Unlock()

	for _, d := range pruned {
		_ = w.backend.Remove(d)
	}
	return true
}

func (w *Watcher) loop(ctx context.Context) {
	defer w.wg.Done()

	for {
		select {
		case <-ctx.Done():
			return
		case event, ok := <-w.rawEvents:
			if !ok {
				return
			}
			w.handleEvent(event)
		case err, ok := <-w.rawErrors:
			if !ok {
				return
			}
			if errors.Is(err, fsnotify.ErrEventOverflow) {
				// The kernel's queue overflowed: events were lost before
				// they ever reached this process.
				w.dropped.Store(true)
			}
			slog.Error("watcher: fsnotify error", "error", err)
		}
	}
}

func (w *Watcher) handleEvent(event fsnotify.Event) {
	path := filepath.Clean(event.Name)

	// Dot-files and dot-directories are judged by the path below the root,
	// never by the directories above it, so a vault under a dot-named
	// directory is watched; a path outside the root is refused as such.
	rel, err := vaultfile.VaultRel(w.root, path)
	if err != nil {
		slog.Debug("watcher: event outside the vault root ignored", "path", path)
		return
	}
	if vaultfile.IsHiddenRel(rel) {
		return
	}

	// Only care about notes and directories (for recursive watch extension).
	isDir := false
	if info, err := os.Stat(path); err == nil && info.IsDir() {
		isDir = true
	}

	// A tracked directory removed or renamed away is no longer a directory on
	// disk, and its name has no note extension, so it is recognised by its
	// entry in the directory set, before the extension filter drops it.
	if !isDir && (event.Has(fsnotify.Remove) || event.Has(fsnotify.Rename)) && w.forgetDirTree(path) {
		w.schedule(path, KindDirDelete)
		return
	}

	if isDir {
		// A directory created or renamed into the vault (a move in arrives as
		// Create on Linux and as Rename on some other systems): watch it and
		// everything below it, and report the notes it brought. An existing
		// directory is already watched.
		if (event.Has(fsnotify.Create) || event.Has(fsnotify.Rename)) && !w.isTrackedDir(path) {
			_ = w.addDirRecursive(path, true)
		}
		return
	}

	if !vaultfile.IsNoteFile(path) {
		return
	}

	// Map raw ops to a normalized kind.
	kind := w.normalizeKind(event)
	if kind == "" {
		return
	}
	w.schedule(path, kind)
}

// schedule records kind for path and (re)starts the path's coalesce timer.
func (w *Watcher) schedule(path string, kind EventKind) {
	// Coalesce: reset the debounce timer for this path.
	w.mu.Lock()

	// A timer scheduled after Stop has taken the pending set would never be
	// waited for, and its send would race the channel close.
	if w.closed {
		w.mu.Unlock()
		return
	}

	w.pending[path] = append(w.pending[path], kind)
	// Keep only the most recent kind; but for move_candidate, also keep it.
	// Strategy: coalesce all events for this path, emit the "most important" kind.
	// delete/move_candidate > change > create

	// Cancel the existing timer, releasing its token when the cancellation
	// beat its callback - otherwise that callback releases its own.
	if t, ok := w.timers[path]; ok {
		if t.Stop() {
			w.wg.Done()
		}
	}
	w.wg.Add(1)
	w.timers[path] = w.sched.AfterFunc(w.cfg.CoalesceWindow, func() {
		defer w.wg.Done()

		w.mu.Lock()
		kinds := w.pending[path]
		delete(w.pending, path)
		delete(w.timers, path)
		w.mu.Unlock()

		if len(kinds) == 0 {
			return
		}

		finalKind := coalesceKinds(kinds)

		ev := ChangeEvent{
			Kind:           finalKind,
			Path:           path,
			CoalescedCount: len(kinds),
			Timestamp:      time.Now(),
		}

		slog.Info("watcher: event",
			"kind", ev.Kind,
			"path", ev.Path,
			"coalesced_count", ev.CoalescedCount,
			"ts", ev.Timestamp.Format(time.RFC3339Nano),
		)

		select {
		case w.events <- ev:
		case <-w.shuttingDown:
			// Dropping a coalesced event during shutdown is the correct
			// trade: the alternative is Stop hanging on a full buffer.
		default:
			// Never block. A first run that writes an id into thousands of
			// notes raises an event for each write while nothing drains the
			// buffer yet, and a blocking send would leave one goroutine
			// waiting per event. The loss is recorded instead; the consumer
			// takes the flag and rescans.
			w.dropped.Store(true)
			slog.Warn("watcher: events buffer full; event dropped", "kind", ev.Kind, "path", ev.Path)
		}
	})
	w.mu.Unlock()
}

// coalesceKinds picks the most significant kind from a sequence.
// dir_delete, delete and move_candidate take highest priority, in that order.
func coalesceKinds(kinds []EventKind) EventKind {
	hasDirDelete := false
	hasDelete := false
	hasMove := false

	for _, k := range kinds {
		switch k {
		case KindDirDelete:
			hasDirDelete = true
		case KindDelete:
			hasDelete = true
		case KindMoveCandidate:
			hasMove = true
			// create is coalesced to change; neither individually matters.
		case KindCreate, KindChange:
			// default priority
		}
	}

	if hasDirDelete {
		return KindDirDelete
	}
	if hasDelete {
		return KindDelete
	}
	if hasMove {
		return KindMoveCandidate
	}
	return KindChange
}

func (w *Watcher) normalizeKind(event fsnotify.Event) EventKind {
	if event.Has(fsnotify.Remove) {
		return KindDelete
	}
	if event.Has(fsnotify.Rename) {
		return KindMoveCandidate
	}
	if event.Has(fsnotify.Create) {
		return KindCreate
	}
	if event.Has(fsnotify.Write) {
		return KindChange
	}
	return ""
}

// ErrWatchFailed is the sentinel for watch-add failures that should not stop the watcher.
var ErrWatchFailed = errors.New("watch add failed for path")
