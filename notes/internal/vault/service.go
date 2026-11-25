package vault

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"sync"
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

	w *watcher.Watcher
	r *reconcile.Reconciler

	cancel context.CancelFunc
	wg     sync.WaitGroup
}

// New creates a Service for the given graph and vault config.
// cfg must already have defaults applied (ApplyDefaults) and be validated
// (Validate). It is a programming error to call New with an empty Root.
func New(g *graph.Graph, cfg config.VaultConfig) *Service {
	return &Service{g: g, cfg: cfg}
}

// Start runs the vault lifecycle:
//  1. Constructs the reconciler and sets its delete window.
//  2. Runs ColdStart (full vault → graph diff) before live watching.
//  3. Constructs and starts the watcher.
//  4. Spawns a goroutine that routes watcher events to the reconciler.
//  5. Spawns a ticker goroutine that calls FlushExpired at moveWindow cadence.
//  6. If RescanIntervalSec > 0, spawns a periodic rescan goroutine.
//
// Start fails fast with a clear error when the vault root is missing or not a
// directory (even though Validate already caught this - belt-and-suspenders).
func (s *Service) Start(ctx context.Context) error {
	if err := Validate(s.cfg); err != nil {
		return fmt.Errorf("vault service start: %w", err)
	}

	root := s.cfg.Root
	coalWindow := coalesceWindow(s.cfg)
	mvWindow := moveWindow(s.cfg)

	slog.Info("vault: starting",
		"root", root,
		"coalesce_window_ms", s.cfg.CoalesceWindowMs,
		"move_window_ms", s.cfg.MoveWindowMs,
		"rescan_interval_sec", s.cfg.RescanIntervalSec,
	)

	// 1. Reconciler.
	s.r = reconcile.New(s.g, root)
	s.r.SetDeleteWindow(mvWindow)

	// 2. Cold-start reconciliation before live watching.
	if err := s.r.ColdStart(ctx); err != nil {
		return fmt.Errorf("vault cold-start: %w", err)
	}
	coldStats := s.r.Stats()
	slog.Info("vault: cold-start complete",
		"events_processed", coldStats.EventsProcessed,
		"notes_created", coldStats.NotesCreated,
		"tombstoned", coldStats.NotesTombstoned,
		"revived", coldStats.NotesRevived,
	)

	// 3. Watcher.
	w, err := watcher.New(root, watcher.Config{CoalesceWindow: coalWindow})
	if err != nil {
		return fmt.Errorf("vault: create watcher: %w", err)
	}
	s.w = w

	innerCtx, cancel := context.WithCancel(ctx)
	s.cancel = cancel

	if err := s.w.Start(innerCtx); err != nil {
		cancel()
		return fmt.Errorf("vault: start watcher: %w", err)
	}

	// 4. Event router goroutine.
	s.wg.Add(1)
	go s.routeEvents(innerCtx)

	// 5. FlushExpired ticker goroutine.
	s.wg.Add(1)
	go s.flushTicker(innerCtx, mvWindow)

	// 6. Optional periodic rescan.
	if s.cfg.RescanIntervalSec > 0 {
		s.wg.Add(1)
		go s.rescanTicker(innerCtx, time.Duration(s.cfg.RescanIntervalSec)*time.Second)
	}

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

// routeEvents reads from the watcher's event channel and dispatches each event
// to the reconciler until the context ends or the channel closes.
func (s *Service) routeEvents(ctx context.Context) {
	defer s.wg.Done()
	for {
		select {
		case <-ctx.Done():
			return
		case ev, ok := <-s.w.Events():
			if !ok {
				return
			}
			s.route(ctx, ev)
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

// flushTicker calls FlushExpired at the given cadence to tombstone deletes
// whose move window has elapsed.
func (s *Service) flushTicker(ctx context.Context, cadence time.Duration) {
	defer s.wg.Done()
	t := time.NewTicker(cadence)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			n, err := s.r.FlushExpired(ctx)
			if err != nil {
				slog.Error("vault: FlushExpired error", "error", err)
				continue
			}
			if n > 0 {
				slog.Info("vault: tombstoned expired deletes", "count", n)
			}
		}
	}
}

// rescanTicker re-runs ColdStart at the given interval as a safety net for
// missed fsnotify events (e.g. watch-add failures or OS-level dropped events).
func (s *Service) rescanTicker(ctx context.Context, interval time.Duration) {
	defer s.wg.Done()
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			slog.Info("vault: periodic rescan starting")
			if err := s.r.ColdStart(ctx); err != nil {
				slog.Error("vault: periodic rescan error", "error", err)
				continue
			}
			stats := s.r.Stats()
			slog.Info("vault: periodic rescan complete",
				"total_events_processed", stats.EventsProcessed,
			)
		}
	}
}
