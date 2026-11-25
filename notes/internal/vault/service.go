package vault

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gabrielassisxyz/houston/notes/internal/config"
	"github.com/gabrielassisxyz/houston/notes/internal/graph"
	"github.com/gabrielassisxyz/houston/notes/internal/vault/reconcile"
	"github.com/gabrielassisxyz/houston/notes/internal/vault/watcher"
)

// Service manages the vault watcher lifecycle: cold-start reconciliation,
// live fsnotify event routing, periodic FlushExpired, and optional rescan.
// Construct with New, then call Start(ctx) and Stop().
type Service struct {
	g   *graph.Graph
	cfg config.VaultConfig

	// r is built by New and never reassigned, so Status reads it from any
	// goroutine; Start used to assign it, unguarded, while health could read.
	r        *reconcile.Reconciler
	indexing atomic.Bool

	// newSource and coldStart are the seams tests replace: the watcher, and
	// the pass over the whole vault that the first index and every rescan run.
	newSource func(root string, cfg watcher.Config) (eventSource, error)
	coldStart func(ctx context.Context) error

	w eventSource

	cancel context.CancelFunc
	wg     sync.WaitGroup
}

// eventSource is the part of *watcher.Watcher the service drives.
type eventSource interface {
	Start(ctx context.Context) error
	Events() <-chan watcher.ChangeEvent
	TakeDropped() bool
	Stop()
}

// Status is the service's readiness, safe to read from any goroutine from New
// on.
type Status struct {
	// Indexing is true until the first index has returned.
	Indexing bool
	// Reports counts, by kind, the files the index left out or indexed with
	// something other than what they say. Every kind is present.
	Reports map[reconcile.ReportKind]int
}

// New creates a Service for the given graph and vault config.
// cfg must already have defaults applied (ApplyDefaults) and be validated
// (Validate). It is a programming error to call New with an empty Root.
func New(g *graph.Graph, cfg config.VaultConfig) *Service {
	r := reconcile.New(g, cfg.Root)
	r.SetDeleteWindow(moveWindow(cfg))
	s := &Service{g: g, cfg: cfg, r: r, coldStart: r.ColdStart}
	s.newSource = func(root string, wc watcher.Config) (eventSource, error) {
		w, err := watcher.New(root, wc)
		if err != nil {
			return nil, err
		}
		return w, nil
	}
	s.indexing.Store(true)
	return s
}

// Status reports whether the first index is still running and the current
// counts of the reconciler's file reports.
func (s *Service) Status() Status {
	counts := make(map[reconcile.ReportKind]int)
	for _, kind := range reconcile.ReportKinds() {
		counts[kind] = 0
	}
	for _, rep := range s.r.Reports() {
		counts[rep.Kind]++
	}
	return Status{Indexing: s.indexing.Load(), Reports: counts}
}

// Start runs the vault lifecycle:
//  1. Constructs and starts the watcher, so its OS watches are armed before
//     the first index: a note written while the index runs raises an event,
//     which the watcher keeps while nothing reads it yet.
//  2. Runs ColdStart (full vault → graph diff). If it fails or is cancelled,
//     the watcher is stopped and Start returns the error.
//  3. Rescans once if the watcher dropped events while nothing drained them.
//  4. Spawns the goroutine that routes watcher events to the reconciler,
//     calls FlushExpired at moveWindow cadence, checks for dropped events on
//     each of those ticks, and, if RescanIntervalSec > 0, rescans periodically.
//     It starts only now, so live events never run against the cold start's
//     snapshot and its tombstone sweep, and one goroutine doing all four keeps
//     every later rescan out of the way of live events too.
//
// Start fails fast with a clear error when the vault root is missing or not a
// directory (even though Validate already caught this - belt-and-suspenders).
func (s *Service) Start(ctx context.Context) error {
	if err := Validate(s.cfg); err != nil {
		return fmt.Errorf("vault service start: %w", err)
	}

	root := s.cfg.Root
	slog.Info("vault: starting",
		"root", root,
		"coalesce_window_ms", s.cfg.CoalesceWindowMs,
		"move_window_ms", s.cfg.MoveWindowMs,
		"rescan_interval_sec", s.cfg.RescanIntervalSec,
	)

	innerCtx, cancel := context.WithCancel(ctx)
	s.cancel = cancel

	// 1. Watcher, armed before the first index.
	w, err := s.newSource(root, watcher.Config{CoalesceWindow: coalesceWindow(s.cfg)})
	if err != nil {
		cancel()
		return fmt.Errorf("vault: create watcher: %w", err)
	}
	if err := w.Start(innerCtx); err != nil {
		cancel()
		return fmt.Errorf("vault: start watcher: %w", err)
	}
	s.w = w

	// 2. First index.
	err = s.coldStart(innerCtx)
	s.indexing.Store(false)
	if err != nil {
		s.w.Stop()
		cancel()
		return fmt.Errorf("vault cold-start: %w", err)
	}
	coldStats := s.r.Stats()
	slog.Info("vault: cold-start complete",
		"events_processed", coldStats.EventsProcessed,
		"notes_created", coldStats.NotesCreated,
		"tombstoned", coldStats.NotesTombstoned,
		"revived", coldStats.NotesRevived,
	)

	// 3. Events lost while nothing drained them.
	s.rescanIfDropped(innerCtx)

	// 4. Live routing.
	s.wg.Add(1)
	go s.run(innerCtx, moveWindow(s.cfg), time.Duration(s.cfg.RescanIntervalSec)*time.Second)

	slog.Info("vault: live watch started", "root", root)
	return nil
}

// Stop shuts down the watcher and waits for all goroutines to exit.
// It is safe to call Stop multiple times.
func (s *Service) Stop() {
	if s.cancel != nil {
		s.cancel()
	}
	if s.w != nil {
		s.w.Stop()
	}
	s.wg.Wait()
	slog.Info("vault: stopped")
}

// run routes watcher events to the reconciler until the context ends or the
// events channel closes. On every flush tick it tombstones the deletes whose
// move window has elapsed and rescans if events were dropped, which also
// recovers a kernel queue overflow during live running; with rescanEvery > 0
// it also rescans on that interval as a safety net for missed fsnotify events
// (e.g. watch-add failures).
func (s *Service) run(ctx context.Context, flushEvery, rescanEvery time.Duration) {
	defer s.wg.Done()
	flush := time.NewTicker(flushEvery)
	defer flush.Stop()
	var rescanC <-chan time.Time
	if rescanEvery > 0 {
		t := time.NewTicker(rescanEvery)
		defer t.Stop()
		rescanC = t.C
	}
	for {
		select {
		case <-ctx.Done():
			return
		case ev, ok := <-s.w.Events():
			if !ok {
				return
			}
			s.route(ctx, ev)
		case <-flush.C:
			s.flushExpired(ctx)
			s.rescanIfDropped(ctx)
		case <-rescanC:
			s.rescan(ctx, "periodic")
		}
	}
}

// route dispatches one watcher event to the reconciler. Handler errors are
// logged but do not stop the caller.
func (s *Service) route(ctx context.Context, ev watcher.ChangeEvent) {
	var err error
	switch ev.Kind {
	case watcher.KindCreate:
		err = s.r.OnCreate(ctx, ev.Path)
	case watcher.KindMoveCandidate:
		// fsnotify reports Rename on the OLD path of a move, which has already
		// vanished from disk. It goes to OnDelete, which holds the delete for
		// the move window: a move within the vault keeps the note's identity
		// through the change at the new path, and a note moved where no event
		// will name it again - into .trash/, a dot-directory nobody watches,
		// or out of the vault - is tombstoned when the window ends. If the path
		// unexpectedly still exists, fall through to create handling.
		if fileExists(ev.Path) {
			err = s.r.OnCreate(ctx, ev.Path)
		} else {
			err = s.r.OnDelete(ctx, ev.Path)
		}
	case watcher.KindChange:
		err = s.change(ctx, ev.Path)
	case watcher.KindDelete:
		// A delete and a recreate inside one coalesce window - an editor that
		// unlinks the file and writes it anew - coalesce to a delete for a
		// file that is back on disk: that is a change, not a delete.
		if fileExists(ev.Path) {
			err = s.change(ctx, ev.Path)
		} else {
			err = s.r.OnDelete(ctx, ev.Path)
		}
	case watcher.KindDirDelete:
		err = s.r.OnDirDelete(ctx, ev.Path)
	}
	if err != nil {
		slog.Error("vault: reconcile event error",
			"kind", ev.Kind,
			"path", ev.Path,
			"error", err,
		)
	}
}

// change hands a changed path to OnChange. On Linux, inotify often coalesces
// a file create+write into a single change; when OnChange returns
// graph.ErrNotFound (no node for the file's id yet), the path is retried as
// OnCreate so the note is properly ingested.
func (s *Service) change(ctx context.Context, path string) error {
	err := s.r.OnChange(ctx, path)
	if errors.Is(err, graph.ErrNotFound) {
		err = s.r.OnCreate(ctx, path)
	}
	return err
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// flushExpired tombstones the deletes whose move window has elapsed.
func (s *Service) flushExpired(ctx context.Context) {
	n, err := s.r.FlushExpired(ctx)
	if err != nil {
		slog.Error("vault: FlushExpired error", "error", err)
		return
	}
	if n > 0 {
		slog.Info("vault: tombstoned expired deletes", "count", n)
	}
}

// rescanIfDropped clears the watcher's dropped flag and, when it was set,
// runs one rescan: the events lost are changes the index has not seen.
func (s *Service) rescanIfDropped(ctx context.Context) {
	if !s.w.TakeDropped() {
		return
	}
	slog.Warn("vault: watcher dropped events; rescanning the vault")
	s.rescan(ctx, "dropped events")
}

// rescan re-runs the cold start's pass over the whole vault.
func (s *Service) rescan(ctx context.Context, reason string) {
	slog.Info("vault: rescan starting", "reason", reason)
	if err := s.coldStart(ctx); err != nil {
		slog.Error("vault: rescan error", "reason", reason, "error", err)
		return
	}
	slog.Info("vault: rescan complete",
		"reason", reason,
		"total_events_processed", s.r.Stats().EventsProcessed,
	)
}
