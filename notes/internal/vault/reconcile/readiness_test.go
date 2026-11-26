package reconcile_test

import (
	"context"
	"errors"
	"io"
	"log"
	"log/slog"
	"os"
	"path/filepath"
	"testing"

	"github.com/gabrielassisxyz/houston/notes/internal/graph/testutil"
	"github.com/gabrielassisxyz/houston/notes/internal/vault/frontmatter"
	"github.com/gabrielassisxyz/houston/notes/internal/vault/reconcile"
)

// cancelOnRecord is a slog handler that cancels a context when a record with
// the given message is logged: the reconciler logs "reconcile: create" at the
// end of each note it creates, on the walk's own goroutine, so this cancels the
// walk at an exact point between two files.
type cancelOnRecord struct {
	slog.Handler
	message string
	cancel  context.CancelFunc
}

func (h cancelOnRecord) Handle(ctx context.Context, r slog.Record) error {
	if r.Message == h.message {
		h.cancel()
	}
	return h.Handler.Handle(ctx, r)
}

func (h cancelOnRecord) Enabled(context.Context, slog.Level) bool { return true }

// A cancelled walk returns at once and skips the tombstone sweep: the notes it
// had not reached stay live, and the files after the cancellation are not
// touched - the walk used to go on injecting ids into every remaining file.
func TestColdStart_CancelledWalkStopsAtOnceAndTombstonesNothing(t *testing.T) {
	g := testutil.NewInMemoryTestGraph(t)
	vault := t.TempDir()
	writeFile(t, filepath.Join(vault, "k1.md"), noteFile("kept-1", "Kept one"))
	writeFile(t, filepath.Join(vault, "k2.md"), noteFile("kept-2", "Kept two"))
	if err := reconcile.New(g, vault).ColdStart(context.Background()); err != nil {
		t.Fatalf("first ColdStart: %v", err)
	}
	// Walked in lexical order: a-new.md is created first, and the walk is
	// cancelled as its creation is logged; k1, k2 and z-new.md come after.
	writeFile(t, filepath.Join(vault, "a-new.md"), "# First new\n")
	late := filepath.Join(vault, "z-new.md")
	writeFile(t, late, "# Second new\n")

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	// A handler of its own: wrapping the default one deadlocks, since
	// SetDefault routes the log package, which that handler writes through,
	// back into slog.
	previous := slog.Default()
	restore := func() {
		// Restoring the default handler leaves the log package writing into
		// the replaced one; point it back at stderr.
		slog.SetDefault(previous)
		log.SetOutput(os.Stderr)
		log.SetFlags(log.LstdFlags)
	}
	quiet := slog.NewTextHandler(io.Discard, nil)
	slog.SetDefault(slog.New(cancelOnRecord{Handler: quiet, message: "reconcile: create", cancel: cancel}))
	t.Cleanup(restore)

	err := reconcile.New(g, vault).ColdStart(ctx)
	restore()
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("ColdStart = %v, want context.Canceled", err)
	}

	for _, id := range []string{"kept-1", "kept-2"} {
		if !isLive(t, g, id) {
			t.Errorf("%s was tombstoned by a cancelled walk", id)
		}
	}
	raw, err := os.ReadFile(late)
	if err != nil {
		t.Fatal(err)
	}
	if fm, err := frontmatter.Parse(raw); err != nil || fm.ID != "" {
		t.Errorf("the walk went on after cancellation and wrote an id into z-new.md: %q", raw)
	}
}

// A change for a file whose id, path and hash the cache already records is a
// no-op: the cold start's own id injections raise one such event per note.
func TestOnChange_FileTheCacheAlreadyHoldsIsANoOp(t *testing.T) {
	ctx := context.Background()
	g := testutil.NewInMemoryTestGraph(t)
	vault := t.TempDir()
	path := filepath.Join(vault, "steady.md")
	writeFile(t, path, "# Steady\n\nno id yet\n")
	rec := reconcile.New(g, vault)
	if err := rec.ColdStart(ctx); err != nil {
		t.Fatalf("ColdStart: %v", err)
	}
	before := rec.Stats().EventsProcessed

	// The event the id injection raised.
	if err := rec.OnChange(ctx, path); err != nil {
		t.Fatalf("OnChange: %v", err)
	}
	if got := rec.Stats().EventsProcessed; got != before {
		t.Errorf("OnChange of an indexed, unchanged file processed %d events, want 0", got-before)
	}

	// An edit is still applied.
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	writeFile(t, path, string(raw)+"\nedited\n")
	if err := rec.OnChange(ctx, path); err != nil {
		t.Fatalf("OnChange after an edit: %v", err)
	}
	if got := rec.Stats().EventsProcessed; got != before+1 {
		t.Errorf("an edit processed %d events, want 1", got-before)
	}
}
