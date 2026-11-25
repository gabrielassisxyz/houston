// Package reconcile provides the path↔uuid cache layer over the note_paths
// table, and the create/change event handlers that turn filesystem events into
// graph mutations (U7). Identity is the UUID; path is a disposable cache entry.
package reconcile

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf8"

	"github.com/gabrielassisxyz/houston/notes/internal/graph"
	"github.com/gabrielassisxyz/houston/notes/internal/graph/nodes"
	"github.com/gabrielassisxyz/houston/notes/internal/vault/frontmatter"
	"github.com/gabrielassisxyz/houston/notes/internal/vault/vaultfile"
	"github.com/gabrielassisxyz/houston/notes/internal/vault/wikilink"
	"github.com/google/uuid"
)

// --- Path cache operations ---

// Lookup returns the UUID for the given vault-relative path.
// Returns found=false (no error) when no row exists for the path.
func Lookup(ctx context.Context, g *graph.Graph, path string) (uuid string, found bool, err error) {
	err = g.DoRead(ctx, func(tx *graph.ReadTx) error {
		uuid, found, err = lookupInTx(tx, path)
		return err
	})
	return
}

// lookupInTx is the inner path→uuid query, usable inside any read or write tx.
func lookupInTx(tx interface {
	QueryRow(string, ...any) *sql.Row
}, path string) (string, bool, error) {
	var uuid string
	err := tx.QueryRow(`SELECT uuid FROM note_paths WHERE path = ?`, path).Scan(&uuid)
	if err == sql.ErrNoRows {
		return "", false, nil
	}
	if err != nil {
		return "", false, fmt.Errorf("reconcile: lookup path %q: %w", path, err)
	}
	return uuid, true, nil
}

// LookupByUUID returns the current path for a given UUID.
// Returns found=false (no error) when no row exists for the UUID.
func LookupByUUID(ctx context.Context, g *graph.Graph, uuid string) (path string, found bool, err error) {
	err = g.DoRead(ctx, func(tx *graph.ReadTx) error {
		path, found, err = lookupByUUIDInTx(tx, uuid)
		return err
	})
	return
}

// lookupByUUIDInTx is the inner uuid→path query.
func lookupByUUIDInTx(tx interface {
	QueryRow(string, ...any) *sql.Row
}, uuid string) (string, bool, error) {
	var path string
	err := tx.QueryRow(`SELECT path FROM note_paths WHERE uuid = ?`, uuid).Scan(&path)
	if err == sql.ErrNoRows {
		return "", false, nil
	}
	if err != nil {
		return "", false, fmt.Errorf("reconcile: lookup uuid %q: %w", uuid, err)
	}
	return path, true, nil
}

// Upsert inserts or updates the note_paths row keyed by UUID.
//
// A move is expressed as Upsert with the same UUID and a new path: the row's
// path column is updated and the old path is no longer reachable. A re-upsert
// of the identical (uuid, path, hash) triple is a no-op (idempotent).
//
// This operation touches ONLY note_paths. It never writes nodes, edges, or
// revisions - those are the responsibility of higher-level reconciler logic.
func Upsert(ctx context.Context, g *graph.Graph, uuid, path, contentHash string) error {
	return g.DoWrite(ctx, func(tx *graph.WriteTx) error {
		return upsertInTx(tx, uuid, path, contentHash)
	})
}

// upsertInTx performs the INSERT OR REPLACE inside a caller-supplied write tx.
// Exposed so U7/U11 can batch multiple cache ops inside a single transaction.
func upsertInTx(tx *graph.WriteTx, uuid, path, contentHash string) error {
	_, err := tx.Exec(
		`INSERT INTO note_paths (uuid, path, content_hash, updated_at)
		 VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
		 ON CONFLICT(uuid) DO UPDATE SET
		     path         = excluded.path,
		     content_hash = excluded.content_hash,
		     updated_at   = excluded.updated_at
		 WHERE path != excluded.path OR content_hash IS NOT excluded.content_hash`,
		uuid, path, contentHash,
	)
	if err != nil {
		return fmt.Errorf("reconcile: upsert uuid=%q path=%q: %w", uuid, path, err)
	}
	return nil
}

// Forget removes the note_paths row whose path equals the given value.
// It is a no-op (no error) when no such row exists.
// Only the row for that exact path is removed; other rows are untouched.
func Forget(ctx context.Context, g *graph.Graph, path string) error {
	return g.DoWrite(ctx, func(tx *graph.WriteTx) error {
		return forgetInTx(tx, path)
	})
}

// forgetInTx deletes by path inside a caller-supplied write tx.
func forgetInTx(tx *graph.WriteTx, path string) error {
	_, err := tx.Exec(`DELETE FROM note_paths WHERE path = ?`, path)
	if err != nil {
		return fmt.Errorf("reconcile: forget path %q: %w", path, err)
	}
	return nil
}

// forgetUUIDInTx deletes the row of one note, wherever it points. A note
// being tombstoned is removed by id rather than by its cached path, which
// another note may have taken over in the meantime.
func forgetUUIDInTx(tx *graph.WriteTx, uuid string) error {
	_, err := tx.Exec(`DELETE FROM note_paths WHERE uuid = ?`, uuid)
	if err != nil {
		return fmt.Errorf("reconcile: forget uuid %q: %w", uuid, err)
	}
	return nil
}

// claimPathInTx binds relPath to id in the path cache.
//
// note_paths.path is unique, so a row at relPath held by another id would
// refuse the upsert and leave this file out of the index for the whole run.
// That row belongs to a note whose file was replaced in place - `mv other.md
// note.md`, or a sync client's replacement - so it is removed and the note it
// held is returned as a pending delete: it is tombstoned after the move window
// unless its file shows up elsewhere first. The caller hands the result to
// pathClaimed once its transaction has committed.
func claimPathInTx(tx *graph.WriteTx, id, relPath, contentHash string) (*pendingDelete, error) {
	holder, found, err := lookupInTx(tx, relPath)
	if err != nil {
		return nil, err
	}
	var displaced *pendingDelete
	if found && holder != id {
		if displaced, err = displacedNoteInTx(tx, holder, relPath); err != nil {
			return nil, err
		}
		if err := forgetInTx(tx, relPath); err != nil {
			return nil, err
		}
	}
	if err := upsertInTx(tx, id, relPath, contentHash); err != nil {
		return nil, err
	}
	return displaced, nil
}

// displacedNoteInTx describes, as a pending delete, the live note whose row at
// relPath is about to be removed. It returns nil when the row's note is not
// live, which leaves nothing to tombstone.
func displacedNoteInTx(tx *graph.WriteTx, holder, relPath string) (*pendingDelete, error) {
	var title string
	err := tx.QueryRow(
		`SELECT title FROM nodes WHERE id = ? AND type = 'note' AND deleted_at IS NULL`, holder,
	).Scan(&title)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("reconcile: read displaced note %q: %w", holder, err)
	}
	var hash sql.NullString
	if err := tx.QueryRow(`SELECT content_hash FROM note_paths WHERE uuid = ?`, holder).Scan(&hash); err != nil && err != sql.ErrNoRows {
		return nil, fmt.Errorf("reconcile: read displaced hash %q: %w", holder, err)
	}
	return &pendingDelete{
		contentHash: hash.String,
		relPath:     relPath,
		nodeID:      holder,
		stem:        stemFromRelPath(relPath),
		title:       title,
	}, nil
}

// SetPinned pins or unpins a note in the vault index. Returns graph.ErrNotFound
// when no note_paths row carries that UUID.
//
// The pin lives here rather than on the node's attrs because a note's attrs are
// rebuilt from the file on every reconcile - Note.NodeAttrs() returns a fresh
// map and updateNode writes it over the previous one - so a pin kept there
// would survive until the next edit of the note and then disappear silently.
// Upsert touches only path, content_hash and updated_at, so this column is
// invisible to indexing; and a note deleted from disk loses its row, taking the
// pin with it, which is what deleting a note should do.
func SetPinned(ctx context.Context, tx *graph.WriteTx, uuid string, pinned bool) error {
	value := 0
	if pinned {
		value = 1
	}
	res, err := tx.Exec(`UPDATE note_paths SET pinned = ? WHERE uuid = ?`, value, uuid)
	if err != nil {
		return fmt.Errorf("reconcile: set pinned uuid=%q: %w", uuid, err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return fmt.Errorf("reconcile: set pinned uuid=%q: rows affected: %w", uuid, err)
	}
	if n == 0 {
		return graph.ErrNotFound
	}
	return nil
}

// FindByContentHash returns the UUID of the note_paths row whose content_hash
// matches hash. Returns found=false (no error) when no row matches.
//
// This is the content-hash tiebreak primitive consumed by U11's move/revive
// window: a UUID-less file whose hash matches a known/tombstoned node is a
// move candidate rather than a fresh node.
func FindByContentHash(ctx context.Context, g *graph.Graph, hash string) (uuid string, found bool, err error) {
	err = g.DoRead(ctx, func(tx *graph.ReadTx) error {
		uuid, found, err = findByContentHashInTx(tx, hash)
		return err
	})
	return
}

// findByContentHashInTx is the inner hash→uuid query.
func findByContentHashInTx(tx interface {
	QueryRow(string, ...any) *sql.Row
}, hash string) (string, bool, error) {
	var uuid string
	err := tx.QueryRow(`SELECT uuid FROM note_paths WHERE content_hash = ? LIMIT 1`, hash).Scan(&uuid)
	if err == sql.ErrNoRows {
		return "", false, nil
	}
	if err != nil {
		return "", false, fmt.Errorf("reconcile: find by hash: %w", err)
	}
	return uuid, true, nil
}

// --- Content-hash helpers ---

// HashFile computes the SHA-256 hex digest of the file at the given path.
// Used by U7/U11 before calling Upsert so the hash is always consistent.
func HashFile(filePath string) (string, error) {
	f, err := os.Open(filePath)
	if err != nil {
		return "", fmt.Errorf("reconcile: hash file %q: %w", filePath, err)
	}
	defer f.Close()
	return hashReader(f)
}

// HashBytes computes the SHA-256 hex digest of a byte slice.
// Convenience for callers that already have the content in memory.
func HashBytes(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func hashReader(r io.Reader) (string, error) {
	h := sha256.New()
	if _, err := io.Copy(h, r); err != nil {
		return "", fmt.Errorf("reconcile: hash: %w", err)
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// --- Reconciler ---

// defaultDeleteWindow is the default move/delete correlation window.
// A delete is held for this duration before being tombstoned. A same-UUID or
// same-hash create within the window cancels the tombstone (move semantics).
const defaultDeleteWindow = time.Second

// pendingDelete holds the metadata for a delete that has not yet been tombstoned.
type pendingDelete struct {
	deletedAt   time.Time
	contentHash string
	relPath     string // vault-relative path at time of delete
	nodeID      string
	stem        string // filename stem at time of delete
	title       string // node title at time of delete
}

// Stats captures in-memory counters exposed by the Reconciler for diagnostics.
type Stats struct {
	EventsProcessed  int64
	NotesCreated     int64
	DanglingPromoted int64
	NotesTombstoned  int64
	NotesRevived     int64
}

// Reconciler processes create/change/delete events from the watcher and
// mutates the graph. It owns the chokepoint for note creation, revision
// recording, wikilink resolution, path-cache maintenance, and
// move/delete-window correlation.
type Reconciler struct {
	g         *graph.Graph
	vaultRoot string // absolute path to the vault root for relative path resolution
	resolver  *wikilink.Resolver

	// move/delete window - injectable for deterministic testing
	window time.Duration
	now    func() time.Time

	pendingMu      sync.Mutex
	pendingDeletes map[string]*pendingDelete // keyed by nodeID

	reportsMu sync.Mutex
	reports   map[string]map[ReportKind]FileReport // keyed by vault-relative path

	// counters - updated atomically
	eventsProcessed  atomic.Int64
	notesCreated     atomic.Int64
	danglingPromoted atomic.Int64
	notesTombstoned  atomic.Int64
	notesRevived     atomic.Int64
}

// New creates a Reconciler for the given graph and vault root.
func New(g *graph.Graph, vaultRoot string) *Reconciler {
	abs, err := filepath.Abs(vaultRoot)
	if err != nil {
		abs = vaultRoot
	}
	return &Reconciler{
		g:              g,
		vaultRoot:      abs,
		resolver:       &wikilink.Resolver{},
		window:         defaultDeleteWindow,
		now:            time.Now,
		pendingDeletes: make(map[string]*pendingDelete),
		reports:        make(map[string]map[ReportKind]FileReport),
	}
}

// SetDeleteWindow overrides the move/delete correlation window.
// Useful in tests to make the window expire immediately.
func (r *Reconciler) SetDeleteWindow(d time.Duration) {
	r.window = d
}

// SetClock overrides the clock used for pending-delete timestamps.
// Used in tests to advance time deterministically.
func (r *Reconciler) SetClock(fn func() time.Time) {
	r.now = fn
}

// Stats returns a snapshot of the reconciler's in-memory counters.
func (r *Reconciler) Stats() Stats {
	return Stats{
		EventsProcessed:  r.eventsProcessed.Load(),
		NotesCreated:     r.notesCreated.Load(),
		DanglingPromoted: r.danglingPromoted.Load(),
		NotesTombstoned:  r.notesTombstoned.Load(),
		NotesRevived:     r.notesRevived.Load(),
	}
}

// OnDelete handles a KindDelete event for absPath.
//
// It resolves the path to a UUID via the path cache, records a PENDING delete
// (using the injected clock), and forgets the path from the cache. It does NOT
// tombstone the node yet - that happens in FlushExpired after the window elapses.
// If the path is unknown (no cache entry), the call is a no-op.
func (r *Reconciler) OnDelete(ctx context.Context, absPath string) error {
	relPath := r.relPath(absPath)
	// Before the lookup: a file the index left out has no row, and the
	// early return below would keep its report alive after the file is gone.
	r.clearReports(relPath)

	// Resolve path → UUID + nodeID inside a read tx
	var nodeUUID, nodeID, contentHash, nodeTitle string
	err := r.g.DoRead(ctx, func(tx *graph.ReadTx) error {
		var found bool
		var err error
		nodeUUID, found, err = lookupInTx(tx, relPath)
		if err != nil {
			return fmt.Errorf("lookup path %q: %w", relPath, err)
		}
		if !found {
			return nil // unknown path - no-op
		}
		nodeID = nodeUUID // node id == frontmatter uuid

		// Read title for the pending-delete record
		err = tx.QueryRow(
			`SELECT title FROM nodes WHERE id = ? AND type = 'note' AND deleted_at IS NULL`,
			nodeID,
		).Scan(&nodeTitle)
		if err == sql.ErrNoRows {
			nodeID = "" // already tombstoned or not a note
			return nil
		}
		if err != nil {
			return fmt.Errorf("read note title %q: %w", nodeID, err)
		}

		// Read content hash from path cache
		err = tx.QueryRow(
			`SELECT content_hash FROM note_paths WHERE uuid = ?`,
			nodeUUID,
		).Scan(&contentHash)
		if err != nil && err != sql.ErrNoRows {
			return fmt.Errorf("read content hash %q: %w", nodeUUID, err)
		}
		return nil
	})
	if err != nil {
		return fmt.Errorf("reconcile OnDelete %q: %w", absPath, err)
	}

	if nodeID == "" {
		// No live note found for this path - nothing to do
		return nil
	}

	// Forget path from cache (synchronous - outside the window logic)
	if err := forgetPath(ctx, r.g, relPath); err != nil {
		return fmt.Errorf("reconcile OnDelete %q: forget: %w", absPath, err)
	}

	stem := stemFromPath(absPath)

	r.pendingMu.Lock()
	r.pendingDeletes[nodeID] = &pendingDelete{
		deletedAt:   r.now(),
		contentHash: contentHash,
		relPath:     relPath,
		nodeID:      nodeID,
		stem:        stem,
		title:       nodeTitle,
	}
	r.pendingMu.Unlock()

	r.eventsProcessed.Add(1)

	slog.Info("reconcile: delete pending",
		"event", "delete",
		"path", absPath,
		"node_id", nodeID,
		"decision", "pending",
	)
	return nil
}

// FlushExpired tombstones all pending deletes whose age exceeds the window.
// Tests call this directly after advancing the injected clock.
// Returns the count of notes tombstoned and any error.
func (r *Reconciler) FlushExpired(ctx context.Context) (tombstoned int, err error) {
	r.pendingMu.Lock()
	now := r.now()
	var expired []*pendingDelete
	for _, pd := range r.pendingDeletes {
		if now.Sub(pd.deletedAt) >= r.window {
			expired = append(expired, pd)
		}
	}
	// Remove from map now (before unlock) so concurrent callers don't double-tombstone
	for _, pd := range expired {
		delete(r.pendingDeletes, pd.nodeID)
	}
	r.pendingMu.Unlock()

	for _, pd := range expired {
		author := nodes.Author{Name: "human"}
		txErr := r.g.DoWrite(ctx, func(tx *graph.WriteTx) error {
			return nodes.SoftDeleteNoteTx(ctx, tx, pd.nodeID, pd.relPath, pd.title, author)
		})
		if txErr != nil {
			// If the node is already gone (e.g. concurrent revive), skip
			if txErr == graph.ErrNotFound {
				continue
			}
			err = fmt.Errorf("reconcile FlushExpired node %q: %w", pd.nodeID, txErr)
			return tombstoned, err
		}
		tombstoned++
		r.notesTombstoned.Add(1)

		slog.Info("reconcile: tombstone",
			"event", "delete",
			"node_id", pd.nodeID,
			"path", pd.relPath,
			"decision", "tombstone",
		)
	}
	return tombstoned, nil
}

// OnCreate handles a KindCreate event for absPath. It:
//  1. Reads the file bytes.
//  2. Parses frontmatter; injects a UUID if absent (writes back to disk).
//  3. Checks whether a pending delete matches by UUID or content hash
//     (move/revive detection).
//  4. In ONE DoWrite: either handles the create as a move/revive or as a
//     fresh create, resolves wikilinks, promotes dangling links, and upserts
//     the path-cache entry.
func (r *Reconciler) OnCreate(ctx context.Context, absPath string) error {
	raw, err := os.ReadFile(absPath)
	if err != nil {
		return fmt.Errorf("reconcile OnCreate %q: read file: %w", absPath, err)
	}
	relPath := r.relPath(absPath)
	r.clearReports(relPath)
	if r.skipUnindexable(relPath, raw) {
		return nil
	}

	fm, raw, err := parseAndInject(absPath, raw)
	if err != nil {
		return fmt.Errorf("reconcile OnCreate %q: frontmatter: %w", absPath, err)
	}
	r.reportPermission(relPath, fm)

	author := ResolveAuthor(fm.Author)
	title := resolveTitle(fm, absPath)
	body := extractBody(raw)
	contentHash := HashBytes(raw)
	noteID := fm.ID

	// --- Move/revive correlation ---
	// Check whether this create matches a pending delete (move detection)
	// or a tombstoned node that is returning (revive-after-expiry).
	pending := r.consumePendingDelete(noteID, contentHash)

	if pending != nil {
		// Move: cancel the tombstone, update path cache, preserve identity.
		var promoted int
		var displaced *pendingDelete
		err = r.g.DoWrite(ctx, func(tx *graph.WriteTx) error {
			// Check if the node was tombstoned already (race: expiry ran before us)
			tombstoned, err := nodes.IsNoteTombstoned(ctx, tx, pending.nodeID)
			if err != nil {
				return fmt.Errorf("IsNoteTombstoned: %w", err)
			}

			if tombstoned {
				// Revive path: the expiry timer fired before we could cancel it
				if err := nodes.ReviveNoteTx(ctx, tx, pending.nodeID, pending.stem, title, author); err != nil {
					return fmt.Errorf("ReviveNoteTx: %w", err)
				}
				r.notesRevived.Add(1)
			}
			// If not tombstoned, just update the path cache - the node is live

			// Update note's title/body if the frontmatter changed
			n, err := noteFromFile(ctx, tx, pending.nodeID, fm, title, body)
			if err != nil {
				return err
			}
			if err := nodes.UpdateNote(ctx, tx, n, author); err != nil {
				return fmt.Errorf("UpdateNote (move): %w", err)
			}

			// Re-resolve wikilinks
			if _, err := r.resolver.ResolveInTx(ctx, tx, pending.nodeID, body); err != nil {
				return fmt.Errorf("ResolveInTx (move): %w", err)
			}

			// Promote any dangling links that now point here
			keys := r.danglingKeysFor(pending.nodeID, title, absPath)
			p, err := wikilink.PromoteDanglingInTx(ctx, tx, pending.nodeID, keys...)
			if err != nil {
				return fmt.Errorf("PromoteDanglingInTx (move): %w", err)
			}
			promoted = p

			// Upsert path cache to new location
			displaced, err = claimPathInTx(tx, pending.nodeID, relPath, contentHash)
			return err
		})
		if err != nil {
			return fmt.Errorf("reconcile OnCreate (move) %q: %w", absPath, err)
		}
		r.pathClaimed(pending.nodeID, displaced)

		r.eventsProcessed.Add(1)
		r.danglingPromoted.Add(int64(promoted))

		slog.Info("reconcile: move",
			"event", "create",
			"path", absPath,
			"node_id", pending.nodeID,
			"decision", "move",
			"dangling_promoted", promoted,
		)
		return nil
	}

	// Check whether an already-tombstoned node with this UUID is coming back
	if noteID != "" {
		var wasTombstoned, isLive bool
		checkErr := r.g.DoRead(ctx, func(tx *graph.ReadTx) error {
			var err error
			wasTombstoned, err = nodes.IsNoteTombstoned(ctx, tx, noteID)
			if err != nil {
				return err
			}
			if wasTombstoned {
				return nil
			}
			// Not tombstoned does not mean absent: the node can be alive and
			// simply missing from note_paths (a cache row lost, a file restored
			// from a backup). Creating it again violates the id constraint and
			// the file is skipped on every start after that, so the live case
			// has to be recognised before the fresh-create path is reached.
			_, err = nodes.GetNote(ctx, tx, noteID)
			switch {
			case err == nil:
				isLive = true
			case errors.Is(err, graph.ErrNotFound):
			default:
				return err
			}
			return nil
		})
		if checkErr != nil {
			return fmt.Errorf("reconcile OnCreate %q: tombstone check: %w", absPath, checkErr)
		}

		if isLive {
			// A live note can be adopted by a path only when no other path
			// still holds it: a second file with the same id is a sync
			// client's conflict copy or a duplicated template, not the note.
			if holder, dup, err := r.duplicateHolder(ctx, noteID, relPath); err != nil {
				return fmt.Errorf("reconcile OnCreate %q: %w", absPath, err)
			} else if dup {
				r.reportDuplicate(relPath, noteID, holder)
				return nil
			}
			if err := r.adoptNote(ctx, absPath, relPath, contentHash, noteID, title, body, fm, author); err != nil {
				return err
			}
			return nil
		}

		if wasTombstoned {
			// Revive after expiry - the pending window already fired
			var promoted int
			var displaced *pendingDelete
			stem := stemFromPath(absPath)
			err = r.g.DoWrite(ctx, func(tx *graph.WriteTx) error {
				if err := nodes.ReviveNoteTx(ctx, tx, noteID, stem, title, author); err != nil {
					return fmt.Errorf("ReviveNoteTx: %w", err)
				}
				// Update title/body to the new file content
				n, err := noteFromFile(ctx, tx, noteID, fm, title, body)
				if err != nil {
					return err
				}
				if err := nodes.UpdateNote(ctx, tx, n, author); err != nil {
					return fmt.Errorf("UpdateNote (revive): %w", err)
				}

				keys := r.danglingKeysFor(noteID, title, absPath)
				p, err := wikilink.PromoteDanglingInTx(ctx, tx, noteID, keys...)
				if err != nil {
					return fmt.Errorf("PromoteDanglingInTx (revive): %w", err)
				}
				promoted = p

				if _, err := r.resolver.ResolveInTx(ctx, tx, noteID, body); err != nil {
					return fmt.Errorf("ResolveInTx (revive): %w", err)
				}

				displaced, err = claimPathInTx(tx, noteID, relPath, contentHash)
				return err
			})
			if err != nil {
				return fmt.Errorf("reconcile OnCreate (revive) %q: %w", absPath, err)
			}
			r.pathClaimed(noteID, displaced)

			r.eventsProcessed.Add(1)
			r.notesRevived.Add(1)
			r.danglingPromoted.Add(int64(promoted))

			slog.Info("reconcile: revive",
				"event", "create",
				"path", absPath,
				"node_id", noteID,
				"decision", "revive",
				"dangling_promoted", promoted,
			)
			return nil
		}
	}

	// --- Fresh create ---
	var promoted int
	var displaced *pendingDelete
	err = r.g.DoWrite(ctx, func(tx *graph.WriteTx) error {
		n, err := noteFromFile(ctx, tx, noteID, fm, title, body)
		if err != nil {
			return err
		}

		id, err := nodes.CreateNote(ctx, tx, n, author)
		if err != nil {
			return fmt.Errorf("CreateNote: %w", err)
		}
		noteID = id

		// Resolve wikilinks in body
		if _, err := r.resolver.ResolveInTx(ctx, tx, noteID, body); err != nil {
			return fmt.Errorf("ResolveInTx: %w", err)
		}

		// Promote any previously-dangling links pointing at this note
		keys := r.danglingKeysFor(noteID, title, absPath)
		p, err := wikilink.PromoteDanglingInTx(ctx, tx, noteID, keys...)
		if err != nil {
			return fmt.Errorf("PromoteDanglingInTx: %w", err)
		}
		promoted = p

		// Upsert path cache
		displaced, err = claimPathInTx(tx, noteID, relPath, contentHash)
		return err
	})
	if err != nil {
		return fmt.Errorf("reconcile OnCreate %q: %w", absPath, err)
	}
	r.pathClaimed(noteID, displaced)

	r.eventsProcessed.Add(1)
	r.notesCreated.Add(1)
	r.danglingPromoted.Add(int64(promoted))

	slog.Info("reconcile: create",
		"event", "create",
		"path", absPath,
		"node_id", noteID,
		"decision", "create",
		"dangling_promoted", promoted,
	)
	return nil
}

// adoptNote binds an existing live note to the file carrying its id: the graph
// takes the file's content (the file is the source of truth everywhere else in
// the reconciler) and the path cache learns where that note now lives.
func (r *Reconciler) adoptNote(
	ctx context.Context,
	absPath, relPath, contentHash, noteID, title, body string,
	fm *frontmatter.Frontmatter,
	author nodes.Author,
) error {
	var promoted int
	var displaced *pendingDelete
	err := r.g.DoWrite(ctx, func(tx *graph.WriteTx) error {
		n, err := noteFromFile(ctx, tx, noteID, fm, title, body)
		if err != nil {
			return err
		}
		if err := nodes.UpdateNote(ctx, tx, n, author); err != nil {
			return fmt.Errorf("UpdateNote (adopt): %w", err)
		}
		if _, err := r.resolver.ResolveInTx(ctx, tx, noteID, body); err != nil {
			return fmt.Errorf("ResolveInTx (adopt): %w", err)
		}
		p, err := wikilink.PromoteDanglingInTx(ctx, tx, noteID, r.danglingKeysFor(noteID, title, absPath)...)
		if err != nil {
			return fmt.Errorf("PromoteDanglingInTx (adopt): %w", err)
		}
		promoted = p
		displaced, err = claimPathInTx(tx, noteID, relPath, contentHash)
		return err
	})
	if err != nil {
		return fmt.Errorf("reconcile OnCreate (adopt) %q: %w", absPath, err)
	}
	r.pathClaimed(noteID, displaced)

	r.eventsProcessed.Add(1)
	r.danglingPromoted.Add(int64(promoted))

	slog.Info("reconcile: adopt",
		"event", "create",
		"path", absPath,
		"node_id", noteID,
		"decision", "adopt",
		"dangling_promoted", promoted,
	)
	return nil
}

// OnChange handles a KindChange event for absPath. It:
//  1. Reads the current file bytes.
//  2. Parses frontmatter (UUID must already exist; if missing, treats as create).
//  3. In ONE DoWrite: UpdateNote (diff revision), re-resolves wikilinks,
//     and refreshes the path-cache content hash.
func (r *Reconciler) OnChange(ctx context.Context, absPath string) error {
	raw, err := os.ReadFile(absPath)
	if err != nil {
		return fmt.Errorf("reconcile OnChange %q: read file: %w", absPath, err)
	}
	relPath := r.relPath(absPath)
	r.clearReports(relPath)
	if r.skipUnindexable(relPath, raw) {
		return nil
	}

	fm, raw, err := parseAndInject(absPath, raw)
	if err != nil {
		return fmt.Errorf("reconcile OnChange %q: frontmatter: %w", absPath, err)
	}
	r.reportPermission(relPath, fm)

	// If there's still no UUID after inject (very unusual), fall back to create.
	if fm.ID == "" {
		return r.OnCreate(ctx, absPath)
	}

	// The watcher reports a new file as a change, never as a create, so this
	// is where a live copy of a note arrives. Updating the node from it would
	// point the note at the copy; a different path is a move only when the
	// note's own path no longer holds it.
	if holder, dup, err := r.duplicateHolder(ctx, fm.ID, relPath); err != nil {
		return fmt.Errorf("reconcile OnChange %q: %w", absPath, err)
	} else if dup {
		r.reportDuplicate(relPath, fm.ID, holder)
		return nil
	}

	author := ResolveAuthor(fm.Author)
	title := resolveTitle(fm, absPath)
	body := extractBody(raw)
	contentHash := HashBytes(raw)

	var promoted int
	var displaced *pendingDelete
	err = r.g.DoWrite(ctx, func(tx *graph.WriteTx) error {
		n, err := noteFromFile(ctx, tx, fm.ID, fm, title, body)
		if err != nil {
			return err
		}
		if err := nodes.UpdateNote(ctx, tx, n, author); err != nil {
			return fmt.Errorf("UpdateNote: %w", err)
		}

		// Re-resolve wikilinks
		if _, err := r.resolver.ResolveInTx(ctx, tx, fm.ID, body); err != nil {
			return fmt.Errorf("ResolveInTx: %w", err)
		}

		// Promote any dangling links that now point here. Notes the service
		// creates itself can have their node created before the watcher event
		// arrives as a change, so promoting only in OnCreate left links to
		// them permanently dangling.
		keys := r.danglingKeysFor(fm.ID, title, absPath)
		p, err := wikilink.PromoteDanglingInTx(ctx, tx, fm.ID, keys...)
		if err != nil {
			return fmt.Errorf("PromoteDanglingInTx: %w", err)
		}
		promoted = p

		// Refresh path cache
		displaced, err = claimPathInTx(tx, fm.ID, relPath, contentHash)
		return err
	})
	if err != nil {
		return fmt.Errorf("reconcile OnChange %q: %w", absPath, err)
	}
	r.pathClaimed(fm.ID, displaced)

	r.eventsProcessed.Add(1)
	r.danglingPromoted.Add(int64(promoted))

	slog.Info("reconcile: change",
		"event", "change",
		"path", absPath,
		"node_id", fm.ID,
		"decision", "change",
		"dangling_promoted", promoted,
	)
	return nil
}

// --- helpers ---

// duplicateHolder reports whether the note id is bound to a path other than
// relPath that still holds it, and returns that path. The file at relPath is
// then a second copy of the note and stays out of the index.
func (r *Reconciler) duplicateHolder(ctx context.Context, id, relPath string) (string, bool, error) {
	cached, found, err := LookupByUUID(ctx, r.g, id)
	if err != nil {
		return "", false, err
	}
	if !found || cached == relPath {
		return "", false, nil
	}
	return cached, r.pathStillHolds(cached, id), nil
}

// pathStillHolds reports whether the file at the vault-relative path cached
// for id is still that note's file. A file the reconciler would skip - one it
// cannot read, a sync client's empty placeholder, one that is not UTF-8 or
// does not parse - still is: reading it as gone would let a copy take the
// note while the real file is only out of reach for a moment. Any other file
// is the note's only while it carries the id; one with another id, or none,
// has replaced it, and the note has moved wherever its id now is.
func (r *Reconciler) pathStillHolds(relPath, id string) bool {
	raw, err := os.ReadFile(filepath.Join(r.vaultRoot, relPath))
	if errors.Is(err, fs.ErrNotExist) {
		return false
	}
	if err != nil || len(raw) == 0 || !utf8.Valid(raw) {
		return true
	}
	fm, err := frontmatter.Parse(raw)
	if err != nil {
		return true
	}
	return fm.ID == id
}

// skipUnindexable reports, and returns true for, a file the reconciler
// neither indexes nor writes. A zero-byte file is what a sync client leaves as
// a placeholder before the content arrives: injecting an id would write a
// frontmatter block into it, and the content arriving later would then
// conflict with the service's write. A file that is not valid UTF-8 is not
// text the index can hold, and an id written into it would be a guess at its
// encoding. The node of a note already indexed at that path is left as it was.
func (r *Reconciler) skipUnindexable(relPath string, raw []byte) bool {
	var kind ReportKind
	switch {
	case len(raw) == 0:
		kind = ReportEmptyFile
		r.report(relPath, kind, "zero bytes; left untouched until it has content")
	case !utf8.Valid(raw):
		kind = ReportInvalidUTF8
		r.report(relPath, kind, "not valid UTF-8; left untouched")
	default:
		return false
	}
	slog.Warn("reconcile: file left out of the index", "path", relPath, "reason", string(kind))
	return true
}

// reportDuplicate records that relPath was left out because holder keeps id.
func (r *Reconciler) reportDuplicate(relPath, id, holder string) {
	r.report(relPath, ReportDuplicateID, fmt.Sprintf("id %s is held by %s", id, holder))
	slog.Warn("reconcile: duplicate id; file left out of the index",
		"path", relPath,
		"node_id", id,
		"held_by", holder,
		"decision", "duplicate",
	)
}

// parseAndInject reads frontmatter and injects a UUID if absent.
// It writes the updated bytes back to disk only when injection was needed.
// Returns the updated Frontmatter and (possibly updated) raw bytes.
func parseAndInject(absPath string, raw []byte) (*frontmatter.Frontmatter, []byte, error) {
	fm, err := frontmatter.Parse(raw)
	if err != nil {
		return nil, nil, fmt.Errorf("parse: %w", err)
	}

	if fm.ID == "" {
		newUUID := uuid.Must(uuid.NewV7()).String()
		updated, err := frontmatter.InjectID(raw, newUUID)
		if err != nil {
			return nil, nil, fmt.Errorf("inject id: %w", err)
		}
		if err := vaultfile.WriteFileAtomic(absPath, updated, 0o644); err != nil {
			return nil, nil, fmt.Errorf("write injected id: %w", err)
		}
		raw = updated
		fm.ID = newUUID
	}
	return fm, raw, nil
}

// ResolveAuthor maps frontmatter author to a nodes.Author following R15/AE6:
//   - absent / empty → Author{Name: "human"}
//   - already prefixed "agent:*" → preserved
//   - "da" → agent:da
//   - any other value → Author{Name: value} (treated as human identifier)
//
// Exported because it is the single definition of that mapping, and the notes
// list endpoint has to answer "whose note is this?" from the same rule the
// reconciler wrote the node with. A second copy in the API would drift the day
// one of them learns about a new agent.
func ResolveAuthor(fmAuthor string) nodes.Author {
	if fmAuthor == "" {
		return nodes.Author{Name: "human"}
	}
	if strings.HasPrefix(fmAuthor, "agent:") {
		return nodes.Author{Name: fmAuthor}
	}
	if fmAuthor == "da" {
		return nodes.AuthorAgent("da")
	}
	return nodes.Author{Name: fmAuthor}
}

// Permission values a note's frontmatter can declare. Permission is an
// override, never a required field: the default falls out of the axes that
// already exist, so a note that never mentions permission still has one and no
// migration is needed to give it one.
const (
	PermissionAsk  = "ask"
	PermissionEdit = "edit"
)

// ResolvePermission returns the effective permission for a note: the explicit
// frontmatter value when present, otherwise the default derived from author.
// A note with author "da" is assistant territory and defaults to "edit"; a
// note with no author (or any other author) is the user's and defaults to
// "ask". An unrecognised value is a hard error rather than a silent fallback:
// a typo'd policy that silently reads as permissive is the failure mode worth
// refusing.
//
// Enforcement is deliberately out of scope. For now the assistant OBEYS by
// instruction; kernl ENFORCING is a separate task that depends on the
// assistant writing THROUGH kernl instead of dropping markdown into the vault.
// So this is an honour system, and it does not survive an agent in a hurry or
// a weaker model. The safety net remains the revision log, not this field:
// permission says what is allowed, revisions say what happened.
//
// Exported for the same reason ResolveAuthor is: the notes list endpoint has to
// answer "may the assistant modify this note?" from the same rule the
// reconciler validated the file with, and a second copy in the API would drift.
func ResolvePermission(fmPermission, fmAuthor string) (string, error) {
	switch fmPermission {
	case "":
		if ResolveAuthor(fmAuthor).Name == "agent:da" {
			return PermissionEdit, nil
		}
		return PermissionAsk, nil
	case PermissionAsk, PermissionEdit:
		return fmPermission, nil
	default:
		return "", fmt.Errorf("reconcile: invalid permission %q: must be %q or %q", fmPermission, PermissionAsk, PermissionEdit)
	}
}

// NoteFromFile builds the Note a file's frontmatter describes. It is the one
// place a file becomes a Note, shared by the reconciler and the endpoint. Link
// state is not read from the file (it is not in frontmatter); the reconciler
// preserves it via noteFromFile, and the endpoint sets it explicitly.
func NoteFromFile(fm *frontmatter.Frontmatter, title, body string) nodes.Note {
	return nodes.Note{
		ID:         fm.ID,
		Title:      title,
		Body:       body,
		Origin:     nodes.NormalizeOrigin(fm.Origin),
		Author:     fm.Author,
		Permission: fm.Permission,
		Kind:       nodes.NormalizeNoteKind(fm.Kind),
		Refs:       []string(fm.Refs),
		Tags:       []string(fm.Tags),
	}
}

// noteFromFile builds the Note a file's frontmatter describes, carrying over
// the link state the node already holds. Link state (channel, offered
// suggestions, no-links reason) is machine bookkeeping written straight to
// attrs, never to frontmatter, so a rebuild from the file would silently drop
// it. Every site that turns a file into a Note goes through here, so a future
// site cannot forget to preserve it.
func noteFromFile(ctx context.Context, tx *graph.WriteTx, id string, fm *frontmatter.Frontmatter, title, body string) (nodes.Note, error) {
	n := NoteFromFile(fm, title, body)
	n.ID = id
	// An unrecognised permission value is stored as "ask", the most
	// restrictive known one, at the moment the file becomes a note. Refusing
	// it hid the whole note from the index over one typo'd field, and storing
	// it as written would sit in attrs where every reader of the index has to
	// refuse it again. The reconciler reports the file, so the typo is still
	// seen; the write endpoint keeps refusing it, since a writer can be told.
	if permissionUnknown(fm) {
		n.Permission = PermissionAsk
	}
	existing, err := nodes.GetNote(ctx, tx.AsReadTx(), id)
	if err == nil {
		n.Channel = existing.Channel
		n.LinkSuggestions = existing.LinkSuggestions
		n.NoLinksReason = existing.NoLinksReason
		return n, nil
	}
	if errors.Is(err, graph.ErrNotFound) {
		return n, nil
	}
	return n, err
}

// permissionUnknown reports whether the file declares a permission that
// ResolvePermission refuses.
func permissionUnknown(fm *frontmatter.Frontmatter) bool {
	_, err := ResolvePermission(fm.Permission, fm.Author)
	return err != nil
}

// reportPermission records a file whose permission is indexed as "ask"
// because the value it declares is unknown.
func (r *Reconciler) reportPermission(relPath string, fm *frontmatter.Frontmatter) {
	if !permissionUnknown(fm) {
		return
	}
	r.report(relPath, ReportUnknownPermission, fmt.Sprintf("permission %q is unknown; indexed as %q", fm.Permission, PermissionAsk))
	slog.Warn("reconcile: unknown permission; indexed as ask",
		"path", relPath,
		"permission", fm.Permission,
	)
}

// LinkState is the link bookkeeping the endpoint writes onto a note after
// writing its file: where the write came from, which links were offered, and
// why the writer declined them (when they did).
type LinkState struct {
	Channel       string
	Suggestions   []nodes.LinkCandidate
	NoLinksReason string
}

// LinkStateFor reads the link state a note carries, or an empty state when the
// note does not exist. The endpoint uses it to derive which previously-offered
// suggestions the writer accepted on this write.
func LinkStateFor(ctx context.Context, g *graph.Graph, noteID string) (LinkState, error) {
	var state LinkState
	err := g.DoRead(ctx, func(tx *graph.ReadTx) error {
		n, err := nodes.GetNote(ctx, tx, noteID)
		if err == nil {
			state.Channel = n.Channel
			state.Suggestions = n.LinkSuggestions
			state.NoLinksReason = n.NoLinksReason
			return nil
		}
		if errors.Is(err, graph.ErrNotFound) {
			return nil
		}
		return err
	})
	return state, err
}

// SetLinkState writes link state onto a note's attrs, creating the note from
// the file when it does not exist yet. The endpoint calls this after writing
// the file; noteFromFile preserves the state on every later rebuild. It does
// not resolve wikilinks - the reconciler owns that, and runs it on the same
// file in its own pass.
func SetLinkState(ctx context.Context, g *graph.Graph, vaultRoot, absPath string, state LinkState) error {
	raw, err := os.ReadFile(absPath)
	if err != nil {
		return fmt.Errorf("reconcile SetLinkState %q: read file: %w", absPath, err)
	}
	fm, err := frontmatter.Parse(raw)
	if err != nil {
		return fmt.Errorf("reconcile SetLinkState %q: frontmatter: %w", absPath, err)
	}
	if fm.ID == "" {
		// No id yet: the reconciler will inject one and create the node. The
		// state cannot be attached to a node that does not exist, so it is
		// dropped - the endpoint injects the id before writing, so this is the
		// unusual case of a file written without one.
		return nil
	}
	title := resolveTitle(fm, absPath)
	body := extractBody(raw)
	author := ResolveAuthor(fm.Author)

	return g.DoWrite(ctx, func(tx *graph.WriteTx) error {
		n, err := noteFromFile(ctx, tx, fm.ID, fm, title, body)
		if err != nil {
			return err
		}
		// The channel is a fact about THIS write, so it always replaces. The
		// other two are not: a write that offers nothing is not a write that
		// withdraws the last offer, and a write that declares no reason is not
		// a write that erases the one already given. Overwriting them wholesale
		// meant the user opening a note in the web UI and saving it erased the
		// receipt the assistant had just recorded, silently, taking the derived
		// accepted/rejected of every later write with it.
		n.Channel = state.Channel
		if len(state.Suggestions) > 0 {
			n.LinkSuggestions = state.Suggestions
		}
		if state.NoLinksReason != "" {
			n.NoLinksReason = state.NoLinksReason
		}

		_, err = nodes.GetNote(ctx, tx.AsReadTx(), fm.ID)
		switch {
		case err == nil:
			return nodes.UpdateNote(ctx, tx, n, author)
		case errors.Is(err, graph.ErrNotFound):
			_, err := nodes.CreateNote(ctx, tx, n, author)
			return err
		default:
			return err
		}
	})
}

// resolveTitle returns the title from frontmatter or falls back to the filename stem.
func resolveTitle(fm *frontmatter.Frontmatter, absPath string) string {
	if fm.Title != "" {
		return fm.Title
	}
	base := filepath.Base(absPath)
	return strings.TrimSuffix(base, filepath.Ext(base))
}

// WriteNoteBody rewrites the body of a note's vault markdown file, preserving
// its frontmatter, so the file (the source of truth) reflects an
// in-graph body change. Callers that mutate a note's body directly via
// nodes.UpdateNote (e.g. ingest/inbox merges) MUST also call this - otherwise
// the file diverges and the merge is clobbered the next time the file is
// reconciled (OnChange re-derives the node body from the stale file).
//
// It returns written=false (no error) when the file cannot be located - no
// vault root, or no path cached and no frontmatter id match. The caller's
// node-level update still stands; only the file mirror is skipped.
func WriteNoteBody(ctx context.Context, g *graph.Graph, vaultRoot, noteID, newBody string) (written bool, err error) {
	if vaultRoot == "" {
		return false, nil
	}
	full, ok, err := locateNoteFile(ctx, g, vaultRoot, noteID)
	if err != nil {
		return false, err
	}
	if !ok {
		return false, nil
	}

	raw, err := os.ReadFile(full)
	if err != nil {
		return false, fmt.Errorf("reconcile: read note %q: %w", full, err)
	}
	// extractBody returns the body region (a suffix of the file), so trimming it
	// off leaves the frontmatter block plus its separator untouched.
	body := extractBody(raw)
	prefix := strings.TrimSuffix(string(raw), body)
	if err := vaultfile.WriteFileAtomic(full, []byte(prefix+newBody), 0o644); err != nil {
		return false, fmt.Errorf("reconcile: write note %q: %w", full, err)
	}
	return true, nil
}

// locateNoteFile resolves a note's absolute file path: first via the note_paths
// cache, then by scanning for a markdown whose frontmatter id matches (the cache
// may not be populated yet for a freshly created note).
func locateNoteFile(ctx context.Context, g *graph.Graph, vaultRoot, noteID string) (string, bool, error) {
	if rel, found, err := LookupByUUID(ctx, g, noteID); err != nil {
		return "", false, err
	} else if found && rel != "" {
		return filepath.Join(vaultRoot, rel), true, nil
	}

	var match string
	_ = filepath.WalkDir(vaultRoot, func(path string, d os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return nil
		}
		// A copy in .trash or another dot-directory is not the note's file;
		// judged below the root only, so a vault under a dot-named directory
		// is still searched.
		if rel, relErr := vaultfile.VaultRel(vaultRoot, path); relErr != nil || vaultfile.IsHiddenRel(rel) {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if d.IsDir() || !vaultfile.IsNoteFile(path) {
			return nil
		}
		raw, readErr := os.ReadFile(path)
		if readErr != nil {
			return nil
		}
		if fm, perr := frontmatter.Parse(raw); perr == nil && fm.ID == noteID {
			match = path
			return filepath.SkipAll
		}
		return nil
	})
	if match == "" {
		return "", false, nil
	}
	return match, true, nil
}

// extractBody returns the content after the frontmatter block.
// If no frontmatter is present, returns the full content, and so does a block
// that is opened and never closed: the file is read as body rather than lose
// whatever follows the stray fence.
func extractBody(raw []byte) string {
	fm := vaultfile.ScanFrontmatter(raw)
	if fm.State != vaultfile.ClosedBlock {
		return string(raw)
	}
	return string(bytes.TrimLeft(raw[fm.End:], "\n\r"))
}

// danglingKeysFor returns every normalized spelling under which this note could
// have been linked before it existed: the file stem, the title, the
// vault-relative path without its extension, and the note id.
//
// All four go through wikilink.NormalizeTarget so promotion matches the exact
// normalized keys written by the resolver and by softDeleteNote.
func (r *Reconciler) danglingKeysFor(noteID, title, absPath string) []wikilink.PromoteKey {
	base := filepath.Base(absPath)
	stem := strings.TrimSuffix(base, filepath.Ext(base))

	seen := map[string]bool{}
	var keys []wikilink.PromoteKey
	add := func(raw string) {
		k := wikilink.NormalizeTarget(raw)
		if k == "" || seen[k] {
			return
		}
		seen[k] = true
		keys = append(keys, wikilink.PromoteKey{Key: k})
	}
	add(stem)
	add(title)
	rel := r.relPath(absPath)
	add(strings.TrimSuffix(rel, filepath.Ext(rel)))
	add(noteID)
	return keys
}

// relPath returns the path relative to the vault root.
// If absPath does not start with vaultRoot, returns absPath unchanged.
func (r *Reconciler) relPath(absPath string) string {
	rel, err := filepath.Rel(r.vaultRoot, absPath)
	if err != nil {
		return absPath
	}
	return rel
}

// consumePendingDelete checks whether a pending delete matches the given UUID or
// content hash. If a match is found, the entry is removed from pendingDeletes and
// returned so the caller can handle it as a move/revive.
func (r *Reconciler) consumePendingDelete(noteID, contentHash string) *pendingDelete {
	r.pendingMu.Lock()
	defer r.pendingMu.Unlock()

	// Primary match: same UUID
	if noteID != "" {
		if pd, ok := r.pendingDeletes[noteID]; ok {
			delete(r.pendingDeletes, noteID)
			return pd
		}
	}

	// Secondary match: content-hash tiebreak (UUID-less files)
	if contentHash != "" {
		for id, pd := range r.pendingDeletes {
			if pd.contentHash == contentHash {
				delete(r.pendingDeletes, id)
				return pd
			}
		}
	}

	return nil
}

// pathClaimed finishes a committed claimPathInTx. The note now bound to a path
// is live on disk, so a delete still pending for it - its old file removed
// before this one appeared - is cancelled; the watcher reports the new file as
// a change, so this is often the only place that can. A note the claim
// displaced starts its move window here.
func (r *Reconciler) pathClaimed(id string, displaced *pendingDelete) {
	r.pendingMu.Lock()
	delete(r.pendingDeletes, id)
	if displaced != nil {
		displaced.deletedAt = r.now()
		r.pendingDeletes[displaced.nodeID] = displaced
	}
	r.pendingMu.Unlock()

	if displaced != nil {
		slog.Info("reconcile: path taken over; delete pending",
			"path", displaced.relPath,
			"node_id", displaced.nodeID,
			"taken_by", id,
			"decision", "pending",
		)
	}
}

// forgetPath removes a path from the note_paths cache.
func forgetPath(ctx context.Context, g *graph.Graph, relPath string) error {
	return g.DoWrite(ctx, func(tx *graph.WriteTx) error {
		return forgetInTx(tx, relPath)
	})
}

// stemFromPath returns the filename stem (without extension) for an absolute path.
func stemFromPath(absPath string) string {
	base := filepath.Base(absPath)
	return strings.TrimSuffix(base, filepath.Ext(base))
}

// cachedPathEntry is one row from note_paths used by ColdStart.
type cachedPathEntry struct {
	uuid        string
	path        string
	contentHash string
}

// listAllCachedPaths returns every row in note_paths as a slice.
// Used by ColdStart to build the disappeared-UUID set.
func listAllCachedPaths(ctx context.Context, g *graph.Graph) ([]cachedPathEntry, error) {
	var out []cachedPathEntry
	err := g.DoRead(ctx, func(tx *graph.ReadTx) error {
		rows, err := tx.Query(`SELECT uuid, path, content_hash FROM note_paths`)
		if err != nil {
			return fmt.Errorf("listAllCachedPaths: %w", err)
		}
		defer rows.Close()
		for rows.Next() {
			var e cachedPathEntry
			var hash sql.NullString
			if err := rows.Scan(&e.uuid, &e.path, &hash); err != nil {
				return fmt.Errorf("listAllCachedPaths: scan: %w", err)
			}
			if hash.Valid {
				e.contentHash = hash.String
			}
			out = append(out, e)
		}
		return rows.Err()
	})
	return out, err
}
