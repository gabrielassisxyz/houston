package api

import (
	"net/http"
	"sort"
	"strings"

	"github.com/gabrielassisxyz/houston/notes/internal/graph"
)

// notesRefsNote is one direct hit: a live note whose refs cite an identifier.
type notesRefsNote struct {
	ID          string   `json:"id"`
	Title       string   `json:"title"`
	Path        string   `json:"path"`
	Kind        string   `json:"kind"`
	Tags        []string `json:"tags"`
	MatchedRefs []string `json:"matchedRefs"`
}

// notesRefsLinked is a one-hop neighbour of a direct hit, of any kind.
type notesRefsLinked struct {
	ID    string   `json:"id"`
	Title string   `json:"title"`
	Path  string   `json:"path"`
	Kind  string   `json:"kind"`
	Tags  []string `json:"tags"`
}

// notesRefsResponse is the pinned answer shape the hub is built against.
// Every list is [] when empty, never null.
type notesRefsResponse struct {
	Notes         []notesRefsNote   `json:"notes"`
	Linked        []notesRefsLinked `json:"linked"`
	LinkedOmitted int               `json:"linkedOmitted"`
}

func registerNotesRefsRoutes(mux *http.ServeMux, d Deps) {
	mux.HandleFunc("GET /api/notes/refs", func(w http.ResponseWriter, r *http.Request) {
		ids := parseRefsIDs(r.URL.Query().Get("ids"))
		if len(ids) == 0 {
			writeError(w, http.StatusBadRequest, "ids must hold at least one identifier")
			return
		}
		if len(ids) > 200 {
			writeError(w, http.StatusBadRequest, "ids holds too many identifiers: at most 200")
			return
		}

		var kindFilter string
		if raw := r.URL.Query().Get("kind"); strings.TrimSpace(raw) != "" {
			kindFilter = strings.ToLower(strings.TrimSpace(raw))
			switch kindFilter {
			case "plano", "implementacao", "evidencia", "nota":
			default:
				writeError(w, http.StatusBadRequest, "kind must be one of plano, implementacao, evidencia, nota")
				return
			}
		}

		hop := 0
		if raw := r.URL.Query().Get("hop"); strings.TrimSpace(raw) != "" {
			switch strings.TrimSpace(raw) {
			case "0":
				hop = 0
			case "1":
				hop = 1
			default:
				writeError(w, http.StatusBadRequest, "hop must be 0 or 1")
				return
			}
		}

		out := notesRefsResponse{Notes: []notesRefsNote{}, Linked: []notesRefsLinked{}, LinkedOmitted: 0}
		err := d.Graph.DoRead(r.Context(), func(tx *graph.ReadTx) error {
			direct, err := queryRefsNotes(tx, ids, kindFilter)
			if err != nil {
				return err
			}
			for _, dn := range direct {
				out.Notes = append(out.Notes, dn)
			}
			if hop == 1 && len(direct) > 0 {
				linked, omitted, err := queryRefsLinked(tx, directIDs(direct))
				if err != nil {
					return err
				}
				for _, ln := range linked {
					out.Linked = append(out.Linked, ln)
				}
				out.LinkedOmitted = omitted
			}
			return nil
		})
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to read refs: "+err.Error())
			return
		}
		writeJSON(w, out)
	})
}

// parseRefsIDs trims, drops blanks and de-duplicates without regard to case
// before counting. It keeps the first occurrence's trimmed casing.
func parseRefsIDs(raw string) []string {
	seen := make(map[string]struct{})
	var out []string
	for _, part := range strings.Split(raw, ",") {
		t := strings.TrimSpace(part)
		if t == "" {
			continue
		}
		k := strings.ToLower(t)
		if _, ok := seen[k]; !ok {
			seen[k] = struct{}{}
			out = append(out, t)
		}
	}
	return out
}

func directIDs(notes []notesRefsNote) []string {
	ids := make([]string, 0, len(notes))
	for _, n := range notes {
		ids = append(ids, n.ID)
	}
	return ids
}

func placeholdersFor(n int) string {
	ph := make([]string, n)
	for i := range ph {
		ph[i] = "?"
	}
	return strings.Join(ph, ",")
}

// queryRefsNotes returns live note nodes with a note_paths row whose refs
// contain any identifier, of one kind when kindFilter is given, ordered by
// path. Tags and matchedRefs are sorted.
func queryRefsNotes(tx *graph.ReadTx, ids []string, kindFilter string) ([]notesRefsNote, error) {
	inRefs := placeholdersFor(len(ids))
	args := make([]any, 0, len(ids)+1)
	for _, id := range ids {
		args = append(args, id)
	}
	query := `SELECT DISTINCT n.id, n.title, np.path, COALESCE(NULLIF(json_extract(n.attrs, '$.kind'), ''), 'nota') AS kind
		FROM nodes n
		JOIN note_paths np ON np.uuid = n.id
		JOIN note_refs nr ON nr.node_id = n.id
		JOIN nodes n2 ON n2.id = nr.node_id AND n2.deleted_at IS NULL
		WHERE n.type = 'note' AND n.deleted_at IS NULL
		AND nr.ref COLLATE NOCASE IN (` + inRefs + `)`
	if kindFilter != "" {
		query += ` AND COALESCE(NULLIF(json_extract(n.attrs, '$.kind'), ''), 'nota') = ?`
		args = append(args, kindFilter)
	}
	query += ` ORDER BY np.path ASC`
	rows, err := tx.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var notes []notesRefsNote
	for rows.Next() {
		var n notesRefsNote
		n.Tags = []string{}
		n.MatchedRefs = []string{}
		if err := rows.Scan(&n.ID, &n.Title, &n.Path, &n.Kind); err != nil {
			return nil, err
		}
		notes = append(notes, n)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(notes) == 0 {
		return []notesRefsNote{}, nil
	}
	byID := make(map[string]*notesRefsNote, len(notes))
	var noteIDs []string
	for i := range notes {
		byID[notes[i].ID] = &notes[i]
		noteIDs = append(noteIDs, notes[i].ID)
	}
	if err := attachRefsTags(tx, byID, noteIDs); err != nil {
		return nil, err
	}
	if err := attachRefsMatched(tx, byID, noteIDs, ids); err != nil {
		return nil, err
	}
	return notes, nil
}

// attachRefsTags fills tags for refs notes in one pass, sorted per note.
func attachRefsTags(tx *graph.ReadTx, byID map[string]*notesRefsNote, noteIDs []string) error {
	rows, err := tx.Query(
		`SELECT nt.node_id, tg.name FROM node_tags nt
		 JOIN tags tg ON tg.id = nt.tag_id
		 WHERE nt.node_id IN (`+placeholdersFor(len(noteIDs))+`)
		 ORDER BY tg.name ASC`,
		stringSliceToAny(noteIDs)...,
	)
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

// attachRefsMatched fills matchedRefs: the note's stored refs that match any
// queried identifier, compared without regard to case, sorted.
func attachRefsMatched(tx *graph.ReadTx, byID map[string]*notesRefsNote, noteIDs, ids []string) error {
	rows, err := tx.Query(
		`SELECT nr.node_id, nr.ref FROM note_refs nr
		 JOIN nodes n ON n.id = nr.node_id AND n.deleted_at IS NULL
		 WHERE nr.node_id IN (`+placeholdersFor(len(noteIDs))+`)
		 AND nr.ref COLLATE NOCASE IN (`+placeholdersFor(len(ids))+`)
		 ORDER BY nr.ref COLLATE NOCASE ASC`,
		append(stringSliceToAny(noteIDs), stringSliceToAny(ids)...)...,
	)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var nodeID, ref string
		if err := rows.Scan(&nodeID, &ref); err != nil {
			return err
		}
		if entry, ok := byID[nodeID]; ok {
			entry.MatchedRefs = append(entry.MatchedRefs, ref)
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	for _, entry := range byID {
		sort.Strings(entry.Tags)
		sort.Strings(entry.MatchedRefs)
		if entry.Tags == nil {
			entry.Tags = []string{}
		}
		if entry.MatchedRefs == nil {
			entry.MatchedRefs = []string{}
		}
	}
	return nil
}

// queryRefsLinked returns live notes of any kind with a path joined to the
// direct notes by a links_to edge in either direction (never describes), not
// already in direct, each once, ordered by path, first 20 with the rest
// counted as omitted.
func queryRefsLinked(tx *graph.ReadTx, direct []string) ([]notesRefsLinked, int, error) {
	if len(direct) == 0 {
		return []notesRefsLinked{}, 0, nil
	}
	inDirect := placeholdersFor(len(direct))
	directArgs := stringSliceToAny(direct)
	rows, err := tx.Query(
		`SELECT DISTINCT n.id, n.title, np.path, COALESCE(NULLIF(json_extract(n.attrs, '$.kind'), ''), 'nota') AS kind
		 FROM nodes n
		 JOIN note_paths np ON np.uuid = n.id
		 JOIN edges e ON e.label = 'links_to' AND ((e.src IN (`+inDirect+`) AND e.dst = n.id) OR (e.dst IN (`+inDirect+`) AND e.src = n.id))
		 WHERE n.type = 'note' AND n.deleted_at IS NULL
		 AND n.id NOT IN (`+inDirect+`)
		 ORDER BY np.path ASC`,
		append(append(append([]any{}, directArgs...), directArgs...), directArgs...)...,
	)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	var all []notesRefsLinked
	for rows.Next() {
		var ln notesRefsLinked
		ln.Tags = []string{}
		if err := rows.Scan(&ln.ID, &ln.Title, &ln.Path, &ln.Kind); err != nil {
			return nil, 0, err
		}
		all = append(all, ln)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, err
	}
	if len(all) == 0 {
		return []notesRefsLinked{}, 0, nil
	}
	byID := make(map[string]*notesRefsLinked, len(all))
	var allIDs []string
	for i := range all {
		byID[all[i].ID] = &all[i]
		allIDs = append(allIDs, all[i].ID)
	}
	tagRows, err := tx.Query(
		`SELECT nt.node_id, tg.name FROM node_tags nt
		 JOIN tags tg ON tg.id = nt.tag_id
		 WHERE nt.node_id IN (`+placeholdersFor(len(allIDs))+`)
		 ORDER BY tg.name ASC`,
		stringSliceToAny(allIDs)...,
	)
	if err != nil {
		return nil, 0, err
	}
	defer tagRows.Close()
	for tagRows.Next() {
		var nodeID, name string
		if err := tagRows.Scan(&nodeID, &name); err != nil {
			return nil, 0, err
		}
		if entry, ok := byID[nodeID]; ok {
			entry.Tags = append(entry.Tags, name)
		}
	}
	if err := tagRows.Err(); err != nil {
		return nil, 0, err
	}
	for _, entry := range byID {
		sort.Strings(entry.Tags)
		if entry.Tags == nil {
			entry.Tags = []string{}
		}
	}
	if len(all) > 20 {
		return all[:20], len(all) - 20, nil
	}
	return all, 0, nil
}

func stringSliceToAny(in []string) []any {
	out := make([]any, len(in))
	for i, s := range in {
		out[i] = s
	}
	return out
}
