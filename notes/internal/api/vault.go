package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"

	"github.com/gabrielassisxyz/houston/notes/internal/graph"
	"github.com/gabrielassisxyz/houston/notes/internal/graph/nodes"
	"github.com/gabrielassisxyz/houston/notes/internal/notes"
	"github.com/gabrielassisxyz/houston/notes/internal/vault/frontmatter"
	"github.com/gabrielassisxyz/houston/notes/internal/vault/reconcile"
	"github.com/gabrielassisxyz/houston/notes/internal/vault/vaultfile"
)

// Where POST /api/vault/append puts the block. An ordinary journal grows at the
// end; a newest-first log grows at the start, or - when it opens with a preamble
// the reader must see before the entries - directly under the `---` that divides
// the two.
//
// All three are named structures, not offsets. That is the line this route does
// not cross: an offset-addressed insert goes stale between the read that found
// the number and the write that uses it, and corrupts the note without a word.
// A named anchor is either present or the request fails.
const (
	appendPositionStart      = "start"
	appendPositionEnd        = "end"
	appendPositionAfterBreak = "after-break"
)

// appendPositions is the accepted set, in the order the error message lists
// them, so a rejected value and the CLI's help agree on the vocabulary.
var appendPositions = []string{appendPositionStart, appendPositionEnd, appendPositionAfterBreak}

// vaultFileWriteResponse is what POST /api/vault/file answers with.
//
// Suggestions, accepted and rejected are kernl's link-suggestion receipts. This
// service does not port the suggestion step, so they always answer null - what
// kernl answers when it offers no suggestion - and the fields stay so a client
// written against kernl reads the same document shape.
//
// Status is the contract every answer carries - saved on success, error when
// the write did not land - so a caller can tell the outcome from the document
// alone, without reading the note back. The server never answers this route
// without a status: the write handler refuses every failure before the file
// lands, so a non-2xx answer always means "not written, retry is safe" and a
// 200 always means "written".
type vaultFileWriteResponse struct {
	Status      string                `json:"status"`
	Error       string                `json:"error,omitempty"`
	Suggestions []nodes.LinkCandidate `json:"suggestions"`
	Accepted    []nodes.LinkCandidate `json:"accepted"`
	Rejected    []nodes.LinkCandidate `json:"rejected"`
}

// vaultFileWriteError answers a failed POST /api/vault/file with the same
// document shape as a success - a status field saying error - so a --json
// caller sees a parseable verdict instead of a bare text body it cannot read
// the outcome from. The status code keeps its meaning: 4xx is a bad
// invocation, 5xx is the backend failing, and every one of them is written
// before the file lands, so a non-200 answer means the write did not apply.
func vaultFileWriteError(w http.ResponseWriter, status int, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(vaultFileWriteResponse{Status: "error", Error: message})
}

func registerVaultRoutes(mux *http.ServeMux, d Deps) {
	mux.HandleFunc("GET /api/vault/list", func(w http.ResponseWriter, r *http.Request) {
		root := d.VaultRoot

		var files []string
		_ = filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
			if err != nil {
				return nil
			}
			rel, relErr := vaultfile.VaultRel(root, path)
			if relErr != nil {
				return nil
			}
			// The walk reads the disk, not the index, so it would bring back
			// .obsidian, a sync client's dot-folders and every note a delete
			// moved into the vault trash. Judged below the root only, so a
			// vault kept under a dot-named directory is still listed.
			if vaultfile.IsHiddenRel(rel) {
				if d.IsDir() {
					return filepath.SkipDir
				}
				return nil
			}
			if !d.IsDir() && vaultfile.IsNoteFile(path) {
				files = append(files, rel)
			}
			return nil
		})

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"files": files})
	})

	// Vault files joined with their graph nodes (via the reconciler's path
	// cache). One request gives the UI path→type (list badges) and id→path
	// (wikilink navigation) without N+1 frontmatter parsing.
	mux.HandleFunc("GET /api/vault/notes", func(w http.ResponseWriter, r *http.Request) {
		type vaultNote struct {
			Path   string `json:"path"`
			ID     string `json:"id"`
			Type   string `json:"type"`
			Title  string `json:"title"`
			Author string `json:"author"`
		}
		out := []vaultNote{}
		err := d.Graph.DoRead(r.Context(), func(tx *graph.ReadTx) error {
			rows, err := tx.Query(`
				SELECT np.path, np.uuid, COALESCE(n.type, ''), COALESCE(n.title, ''),
				       COALESCE(json_extract(n.attrs, '$.author'), '')
				FROM note_paths np
				LEFT JOIN nodes n ON n.id = np.uuid AND n.deleted_at IS NULL`)
			if err != nil {
				return err
			}
			defer rows.Close()
			for rows.Next() {
				var vn vaultNote
				var rawAuthor string
				if err := rows.Scan(&vn.Path, &vn.ID, &vn.Type, &vn.Title, &rawAuthor); err != nil {
					return err
				}
				vn.Author = reconcile.ResolveAuthor(rawAuthor).Name
				out = append(out, vn)
			}
			return rows.Err()
		})
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(out)
	})

	mux.HandleFunc("GET /api/vault/file", func(w http.ResponseWriter, r *http.Request) {
		root := d.VaultRoot

		filePath := r.URL.Query().Get("path")
		if filePath == "" {
			http.Error(w, "missing path", http.StatusBadRequest)
			return
		}

		fullPath, err := resolveVaultFilePath(root, filePath)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		data, err := os.ReadFile(fullPath)
		if err != nil {
			http.Error(w, err.Error(), http.StatusNotFound)
			return
		}
		// Expose the file mtime so the editor uses the server's clock as the
		// conflict-detection baseline (If-Match on save), not the client's.
		if info, statErr := os.Stat(fullPath); statErr == nil {
			lm := info.ModTime().Format(time.RFC3339)
			w.Header().Set("Last-Modified", lm)
			w.Header().Set("ETag", lm)
		}
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Content-Type", "text/plain")
		_, _ = w.Write(data)
	})

	mux.HandleFunc("POST /api/vault/file", func(w http.ResponseWriter, r *http.Request) {
		root := d.VaultRoot

		filePath := r.URL.Query().Get("path")
		if filePath == "" {
			vaultFileWriteError(w, http.StatusBadRequest, "missing path")
			return
		}

		fullPath, err := resolveVaultFilePath(root, filePath)
		if err != nil {
			vaultFileWriteError(w, http.StatusBadRequest, err.Error())
			return
		}

		body, err := io.ReadAll(r.Body)
		if err != nil {
			vaultFileWriteError(w, http.StatusInternalServerError, err.Error())
			return
		}

		// The reconciler never indexes a zero-byte file or a note that is not
		// UTF-8, so writing one would answer "saved" for a note the index then
		// never shows - the orphan the permission check below also refuses.
		if len(body) == 0 {
			vaultFileWriteError(w, http.StatusBadRequest, filePath+": the body is empty, and an empty file is never indexed")
			return
		}
		if vaultfile.IsNoteFile(fullPath) && !utf8.Valid(body) {
			vaultFileWriteError(w, http.StatusBadRequest, filePath+": the body is not valid UTF-8, and such a note is never indexed")
			return
		}

		// Inject the node id at creation. Without it the reconciler injects one
		// out-of-band right after the editor loads the file, bumping the mtime and
		// turning the editor's very next autosave into a false 409 conflict.
		// InjectID is a no-op when an id is already present.
		//
		// The id to inject is the one this PATH already has, and minting a fresh one
		// unconditionally is what destroyed a note's history on 2026-08-01: a save whose
		// frontmatter omitted id - which the editor's own round-trip produces - gave the
		// file a stranger's identity, and the next cold start could not match it to the
		// cached uuid, so it tombstoned the original node and adopted the new one. The
		// body survived; the revisions and every edge pointing at the old id did not.
		// A path with no row is genuinely new and gets a new id, which is the case the
		// injection was written for.
		if vaultfile.IsNoteFile(fullPath) {
			relPath, relErr := filepath.Rel(root, fullPath)
			if relErr != nil {
				vaultFileWriteError(w, http.StatusInternalServerError, relErr.Error())
				return
			}
			id, err := noteIDForPath(r.Context(), d.Graph, relPath)
			if err != nil {
				vaultFileWriteError(w, http.StatusInternalServerError, err.Error())
				return
			}
			if id == "" {
				id = uuid.Must(uuid.NewV7()).String()
			}
			if injected, injErr := frontmatter.InjectID(body, id); injErr == nil {
				body = injected
			}

			// --tags REPLACES the frontmatter's tags: block outright - the
			// query param must be present, not merely non-empty, because
			// 'tags=' (present, empty) is the clearing signal and omitting
			// the param entirely must leave whatever tags the note already
			// has untouched. Has() is what keeps those two apart; Get() != ""
			// would collapse the clearing case into "do nothing".
			if r.URL.Query().Has("tags") {
				tags, tagErr := parseNoteTags(r.URL.Query().Get("tags"))
				if tagErr != nil {
					vaultFileWriteError(w, http.StatusBadRequest, tagErr.Error())
					return
				}
				// Unlike InjectID above, this is never best-effort: InjectID
				// runs on every write whether or not the caller cares, but
				// InjectTags only runs because --tags was explicitly asked
				// for. Swallowing its error the same way InjectID's is
				// swallowed would report success on a write the caller
				// believes tagged the note and did not - nothing on disk
				// changes, and nothing said so. The body is what failed to
				// parse, so 400 names the note the caller was writing.
				injected, injErr := frontmatter.InjectTags(body, tags)
				if injErr != nil {
					vaultFileWriteError(w, http.StatusBadRequest, fmt.Sprintf("%s: %s", filePath, injErr.Error()))
					return
				}
				body = injected
			}
		}

		// Refuse an unrecognised permission BEFORE the file lands. noteFromFile
		// refuses it too, but that runs on the reconciler's own pass: the write
		// would answer "saved", the file would sit on disk, and the graph would
		// quietly never adopt it - the orphan shape the shared write primitive
		// exists to prevent. Same resolver, so there is one definition of the rule.
		if vaultfile.IsNoteFile(fullPath) {
			if fm, fmErr := frontmatter.Parse(body); fmErr == nil {
				if _, permErr := reconcile.ResolvePermission(fm.Permission, fm.Author); permErr != nil {
					vaultFileWriteError(w, http.StatusBadRequest, permErr.Error())
					return
				}
			}
		}

		// Only now, after every check: a refused request must leave nothing
		// behind, not even the directories its path named.
		if err := os.MkdirAll(filepath.Dir(fullPath), 0755); err != nil {
			vaultFileWriteError(w, http.StatusInternalServerError, err.Error())
			return
		}

		// Through a temporary file and a rename: a crash mid-write must not
		// leave half a note where the whole one was.
		err = vaultfile.WriteFileAtomic(fullPath, body, 0o644)
		if err != nil {
			vaultFileWriteError(w, http.StatusInternalServerError, err.Error())
			return
		}

		if info, statErr := os.Stat(fullPath); statErr == nil {
			lm := info.ModTime().Format(time.RFC3339)
			w.Header().Set("Last-Modified", lm)
			w.Header().Set("ETag", lm)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(vaultFileWriteResponse{Status: "saved"})
	})

	// Add a block at one of the note's named positions without a
	// read-modify-write round trip. POST /api/vault/file is the wrong tool for a
	// log that only grows in one place: the caller has to ship the whole file
	// back, twice the transfer for a 160 KB note, and anything that writes
	// between the read and the write is silently overwritten.
	//
	// The graph is deliberately left to the vault watcher, exactly as the
	// full-file write leaves it: OnChange re-reads the file, updates the note
	// node and refreshes note_paths.content_hash from the bytes on disk. Writing
	// the hash here as well would only race that same write.
	mux.HandleFunc("POST /api/vault/append", func(w http.ResponseWriter, r *http.Request) {
		root := d.VaultRoot

		filePath := r.URL.Query().Get("path")
		if filePath == "" {
			http.Error(w, "missing path", http.StatusBadRequest)
			return
		}
		position := r.URL.Query().Get("position")
		if position == "" {
			position = appendPositionEnd
		}
		if !slices.Contains(appendPositions, position) {
			http.Error(w, "position must be one of "+strings.Join(appendPositions, ", "), http.StatusBadRequest)
			return
		}

		fullPath, err := resolveVaultFilePath(root, filePath)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}

		block, err := io.ReadAll(r.Body)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		if strings.TrimSpace(string(block)) == "" {
			http.Error(w, "the block to add is empty", http.StatusBadRequest)
			return
		}

		// Append never creates. A typo'd path that silently produced a new note
		// would scatter one log across several files, and the caller would find
		// out only when the entries went missing.
		current, err := os.ReadFile(fullPath)
		if err != nil {
			if os.IsNotExist(err) {
				http.Error(w, "no such note: "+filePath+" - append only adds to a note that exists; create it first with POST /api/vault/file", http.StatusNotFound)
				return
			}
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}

		var updated string
		switch position {
		case appendPositionStart:
			updated = notes.PrependBlock(string(current), string(block))
		case appendPositionAfterBreak:
			var found bool
			updated, found = notes.InsertAfterThematicBreak(string(current), string(block))
			if !found {
				// Falling back to either end would be the worst outcome: every
				// entry still reads correctly on its own, so the note would rot
				// into the wrong shape with nothing ever complaining.
				http.Error(w, "no thematic break in "+filePath+" - position="+appendPositionAfterBreak+" inserts under the first `---` line below the frontmatter, and this note has none", http.StatusConflict)
				return
			}
		default:
			updated = notes.AppendBlock(string(current), string(block))
		}
		if err := vaultfile.WriteFileAtomic(fullPath, []byte(updated), 0o644); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}

		if info, statErr := os.Stat(fullPath); statErr == nil {
			lm := info.ModTime().Format(time.RFC3339)
			w.Header().Set("Last-Modified", lm)
			w.Header().Set("ETag", lm)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"status":   "appended",
			"path":     filePath,
			"position": position,
			"bytes":    len(block),
		})
	})

	// Moving the file out is enough: the vault watcher's OnDelete reconciles the
	// graph node away, the same path an external (file-explorer) delete takes.
	// The note goes to the vault's own .trash folder rather than the system
	// trash; see moveToVaultTrash for why.
	mux.HandleFunc("DELETE /api/vault/file", func(w http.ResponseWriter, r *http.Request) {
		root := d.VaultRoot

		filePath := r.URL.Query().Get("path")
		if filePath == "" {
			http.Error(w, "missing path", http.StatusBadRequest)
			return
		}

		// Destructive op: refuse anything that escapes the vault root.
		fullPath, err := resolveVaultFilePath(root, filePath)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		// resolveVaultFilePath treats the root itself as contained; deleting it
		// would trash the whole vault, so only paths *below* it are targets.
		if absRoot, absErr := filepath.Abs(root); absErr != nil || fullPath == absRoot {
			http.Error(w, "path must stay within the vault", http.StatusBadRequest)
			return
		}

		if _, err := moveToVaultTrash(root, fullPath); err != nil {
			switch {
			case errors.Is(err, os.ErrNotExist):
				http.Error(w, "no such note: "+filePath, http.StatusNotFound)
			case errors.Is(err, ErrInvalidDeleteTarget):
				http.Error(w, err.Error(), http.StatusBadRequest)
			default:
				http.Error(w, err.Error(), http.StatusInternalServerError)
			}
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})
}

// noteIDForPath returns the node id the vault cache already holds for a path, or
// the empty string when the path is new to it.
//
// Only a LIVE node counts. A path whose node was tombstoned is not an identity to
// preserve - resurrecting a deleted id would reattach the new file to a history that
// was deliberately ended - so that case is treated as new and gets a fresh id.
func noteIDForPath(ctx context.Context, g *graph.Graph, relPath string) (string, error) {
	// No graph, no identity to look up: minting is the only answer available
	// rather than a preference.
	if g == nil {
		return "", nil
	}
	var id string
	err := g.DoRead(ctx, func(tx *graph.ReadTx) error {
		row := tx.QueryRow(
			`SELECT np.uuid FROM note_paths np
			 JOIN nodes n ON n.id = np.uuid AND n.deleted_at IS NULL
			 WHERE np.path = ?`, relPath)
		switch scanErr := row.Scan(&id); {
		case errors.Is(scanErr, sql.ErrNoRows):
			id = ""
			return nil
		case scanErr != nil:
			return scanErr
		}
		return nil
	})
	if err != nil {
		return "", fmt.Errorf("vault: resolving the id of %q: %w", relPath, err)
	}
	return id, nil
}

// parseNoteTags splits the --tags query value into trimmed tag names. An
// empty string is the clearing signal ('note write --tags ""') and yields no
// tags; anything else is split on commas, each piece trimmed. A piece that
// comes out empty (a stray leading, trailing, or doubled comma) is rejected
// rather than silently dropped. A tag containing a comma is out of scope and
// unreachable by construction: splitting on the comma cannot leave one inside
// a piece, so it needs no check of its own.
func parseNoteTags(raw string) ([]string, error) {
	if raw == "" {
		return []string{}, nil
	}
	parts := strings.Split(raw, ",")
	tags := make([]string, 0, len(parts))
	for _, p := range parts {
		trimmed := strings.TrimSpace(p)
		if trimmed == "" {
			return nil, fmt.Errorf("invalid --tags value %q: each tag must be non-empty - check for a stray comma", raw)
		}
		tags = append(tags, trimmed)
	}
	return tags, nil
}
