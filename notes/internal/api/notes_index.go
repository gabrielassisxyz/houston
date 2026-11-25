package api

import (
	"encoding/json"
	"net/http"

	"github.com/gabrielassisxyz/houston/notes/internal/graph"
	"github.com/gabrielassisxyz/houston/notes/internal/graph/tags"
	"github.com/gabrielassisxyz/houston/notes/internal/vault/reconcile"
)

// describesEdgeLabel links a companion note to the entity it describes. kernl
// reads it from its companion package, which is not copied; the label is the
// stored data's, so it stays the same string.
const describesEdgeLabel = "describes"

// noteIndexEntry is one row of the vault index: a note file, everything the
// list needs to sort, group, filter and label it, and nothing else. The body
// stays out - the index paints 700+ rows and the editor fetches the one file it
// opens.
type noteIndexEntry struct {
	ID       string   `json:"id"`
	Path     string   `json:"path"`
	Title    string   `json:"title"`
	Category string   `json:"category"`
	Tags     []string `json:"tags"`
	// Author is resolved through reconcile.ResolveAuthor, so it reads "human",
	// "agent:da" or a human identifier - never the raw frontmatter string. A
	// client tells "not mine" by the "agent:" prefix rather than by knowing
	// which spellings mean the DA.
	Author string `json:"author"`
	// Permission is the effective permission for the note, resolved through
	// reconcile.ResolvePermission: the explicit frontmatter value when present,
	// otherwise the default derived from author ("edit" for the DA's notes,
	// "ask" for the user's). It is an honour-system signal, not enforcement.
	Permission string `json:"permission"`
	// Pinned is read as stored. This service ports no pin route, so nothing
	// here changes it from the column's default.
	Pinned    bool   `json:"pinned"`
	CreatedAt string `json:"createdAt"`
	UpdatedAt string `json:"updatedAt"`
}

// noteIndexResponse carries the pinned tags alongside the notes because both
// tabs of the vault panel are drawn from one payload: the Files tab lists the
// notes, and the Tags tab derives its whole tree from the same rows' tags. Two
// requests would mean the tree and the rows could disagree about what the vault
// holds for as long as one of them is in flight.
type noteIndexResponse struct {
	Notes      []noteIndexEntry `json:"notes"`
	PinnedTags []string         `json:"pinnedTags"`
}

func registerNotesIndexRoutes(mux *http.ServeMux, d Deps) {
	mux.HandleFunc("GET /api/notes", func(w http.ResponseWriter, r *http.Request) {
		out := noteIndexResponse{Notes: []noteIndexEntry{}, PinnedTags: []string{}}

		err := d.Graph.DoRead(r.Context(), func(tx *graph.ReadTx) error {
			ordered, byID, err := readNoteIndexRows(tx)
			if err != nil {
				return err
			}
			if err := attachNoteTags(tx, byID); err != nil {
				return err
			}
			for _, entry := range ordered {
				out.Notes = append(out.Notes, *entry)
			}
			out.PinnedTags, err = tags.PinnedNames(r.Context(), tx)
			return err
		})
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to read the vault index: "+err.Error())
			return
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(out)
	})
}

// readNoteIndexRows returns the index rows newest first, plus the same entries
// keyed by node id so tags can be attached in a second pass without losing that
// order.
//
// The category comes from the entity the note describes, not from the note's
// own type: every file in the vault is a "note" node, and a project's or task's
// companion is a separate note joined to it by a describes edge. Reading
// nodes.type here would label all of them "note".
//
// It is a correlated subquery rather than a join because an entity can carry
// more than one describes edge - the backfill sweep documents exactly that
// case, an entity whose first companion died - and a join would then emit the
// same note twice.
func readNoteIndexRows(tx *graph.ReadTx) ([]*noteIndexEntry, map[string]*noteIndexEntry, error) {
	rows, err := tx.Query(`
		SELECT np.uuid, np.path, np.pinned, n.title, n.created_at, n.updated_at,
		       COALESCE(json_extract(n.attrs, '$.author'), '') AS author,
		       COALESCE(json_extract(n.attrs, '$.permission'), '') AS permission,
		       COALESCE((
		           SELECT e_target.type FROM edges e
		           JOIN nodes e_target ON e_target.id = e.dst AND e_target.deleted_at IS NULL
		           WHERE e.src = np.uuid AND e.label = ?
		           LIMIT 1
		       ), 'note') AS category
		FROM note_paths np
		JOIN nodes n ON n.id = np.uuid AND n.deleted_at IS NULL
		ORDER BY n.updated_at DESC`, describesEdgeLabel)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()

	ordered := []*noteIndexEntry{}
	byID := map[string]*noteIndexEntry{}
	for rows.Next() {
		entry := &noteIndexEntry{Tags: []string{}}
		var pinned int
		var rawAuthor, rawPermission string
		if err := rows.Scan(&entry.ID, &entry.Path, &pinned, &entry.Title,
			&entry.CreatedAt, &entry.UpdatedAt, &rawAuthor, &rawPermission, &entry.Category); err != nil {
			return nil, nil, err
		}
		entry.Pinned = pinned != 0
		entry.Author = reconcile.ResolveAuthor(rawAuthor).Name
		perm, err := reconcile.ResolvePermission(rawPermission, rawAuthor)
		if err != nil {
			return nil, nil, err
		}
		entry.Permission = perm
		ordered = append(ordered, entry)
		byID[entry.ID] = entry
	}
	return ordered, byID, rows.Err()
}

// attachNoteTags fills in each entry's tags in one pass over node_tags, so an
// index of 700 notes costs one query rather than 700.
func attachNoteTags(tx *graph.ReadTx, byID map[string]*noteIndexEntry) error {
	rows, err := tx.Query(`
		SELECT nt.node_id, tg.name
		FROM node_tags nt
		JOIN tags tg ON tg.id = nt.tag_id
		ORDER BY tg.name ASC`)
	if err != nil {
		return err
	}
	defer rows.Close()

	for rows.Next() {
		var nodeID, name string
		if err := rows.Scan(&nodeID, &name); err != nil {
			return err
		}
		if entry, ok := byID[nodeID]; ok {
			entry.Tags = append(entry.Tags, name)
		}
	}
	return rows.Err()
}
