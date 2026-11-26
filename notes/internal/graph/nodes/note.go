package nodes

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/gabrielassisxyz/houston/notes/internal/graph"
)

// Diff constants for Note body revision storage.
// A line diff is stored when both old and new bodies are ≤ MaxDiffBytes,
// the change ratio (|old-new| / max(old,new,1)) ≤ MaxChangeRatio, and the
// line counts multiply to at most MaxDiffCells.
// Otherwise a full snapshot is stored tagged with kind="snapshot".
const (
	MaxDiffBytes   = 256 * 1024 // 256 KiB
	MaxChangeRatio = 0.5        // 50% of the larger body
	// MaxDiffCells caps the LCS table lineDiff builds, one int per cell: four
	// million cells is about 32 MB. A body of five thousand short lines fits
	// under MaxDiffBytes and would need 25 million cells, about 200 MB, on
	// every edit.
	MaxDiffCells = 4_000_000
)

// Origin says where a note CAME FROM. It is a separate axis from author, which says
// who wrote the text, and the two answer different questions: a note made from a
// capture originates in the inbox and is written by the user, so it carries an origin
// and no author at all.
//
// The values are named after the pipeline that produced the note, not after who ran it.
// OriginPrep was spelled "da" until 2026-08-19, which read as an author and made the two
// axes look like one field said twice.
const (
	// OriginPrep is a briefing the DA writes before a capture is triaged. It is the flag
	// that keeps the DA's own output out of the knowledge it retrieves: a briefing is a
	// derivative of the user's captures, never a source of truth about what the user knows.
	OriginPrep = "prep"
	// OriginIngest is a note built from an ingested document.
	OriginIngest = "ingest"
	// OriginCapture is a note made from a capture. The body is the user's own words,
	// carried through untouched, so a capture-origin note has no author: the DA filed it
	// and did not write it.
	OriginCapture = "capture"

	// originPrepLegacy is what OriginPrep was called before 2026-08-19.
	originPrepLegacy = "da"
)

// NormalizeOrigin maps a legacy origin value onto its current name.
//
// It exists so a file written before the rename cannot switch the retrieval filter off by
// being read: frontmatter is the source of truth for a note, so a vault file still saying
// "da" would put "da" straight back into the node the moment it was reconciled, and the
// filter compares against "prep". Normalising on the way in makes the old spelling
// self-healing and removes any ordering hazard between the code, the database and the files.
func NormalizeOrigin(origin string) string {
	if origin == originPrepLegacy {
		return OriginPrep
	}
	return origin
}

// LinkCandidate is one note offered as a link target when a note was written.
// It is machine bookkeeping - which links were once offered to a writer - not
// something the note declares about itself, so it lives in attrs rather than
// frontmatter. The snippet is the same truncation planning.ContextNote uses,
// so a consumer that swaps BuildContext for the link-suggestion mechanism keeps
// its prompt byte-identical.
type LinkCandidate struct {
	ID      string  `json:"id"`
	Title   string  `json:"title"`
	Path    *string `json:"path"`
	Snippet string  `json:"snippet"`
}

// Note kinds. A note indexed before kind existed has no kind in its
// attributes until its file changes; every read takes a missing or empty
// kind as KindNota.
const (
	NoteKindPlano         = "plano"
	NoteKindImplementacao = "implementacao"
	NoteKindEvidencia     = "evidencia"
	NoteKindNota          = "nota"
)

// NormalizeNoteKind trims and lower-cases s and maps it onto the four kinds.
// Anything else, including the empty string, counts as nota.
func NormalizeNoteKind(s string) string {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case NoteKindPlano:
		return NoteKindPlano
	case NoteKindImplementacao:
		return NoteKindImplementacao
	case NoteKindEvidencia:
		return NoteKindEvidencia
	case NoteKindNota:
		return NoteKindNota
	default:
		return NoteKindNota
	}
}

// nodeRefs returns the refs rows a spec carries, or nil when it implements
// no NodeRefs. It keeps the chokepoint free of a type switch on every node.
func nodeRefs(spec NodeSpec) []string {
	if r, ok := spec.(NodeRefser); ok {
		return r.NodeRefs()
	}
	return nil
}

// dedupRefs de-duplicates refs by their case-folded text, preserving the
// first occurrence's trimmed casing and dropping blanks. Tags de-duplicate
// exactly (dedupStrings); refs cannot, because under COLLATE NOCASE
// [hou-4kz, HOU-4KZ] would otherwise fail the primary key.
func dedupRefs(in []string) []string {
	seen := make(map[string]struct{}, len(in))
	var out []string
	for _, r := range in {
		t := strings.TrimSpace(r)
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

// diffRefs computes which refs to add and remove when transitioning from prev
// to next, comparing by case-folded text. A case-only edit is no change, so
// it keeps its single row.
func diffRefs(prev, next []string) (add, remove []string) {
	prevMap := make(map[string]string, len(prev))
	for _, r := range prev {
		t := strings.TrimSpace(r)
		if t == "" {
			continue
		}
		k := strings.ToLower(t)
		if _, ok := prevMap[k]; !ok {
			prevMap[k] = t
		}
	}
	nextMap := make(map[string]string, len(next))
	for _, r := range next {
		t := strings.TrimSpace(r)
		if t == "" {
			continue
		}
		k := strings.ToLower(t)
		if _, ok := nextMap[k]; !ok {
			nextMap[k] = t
		}
	}
	for k, v := range nextMap {
		if _, ok := prevMap[k]; !ok {
			add = append(add, v)
		}
	}
	for k, v := range prevMap {
		if _, ok := nextMap[k]; !ok {
			remove = append(remove, v)
		}
	}
	return
}

// selectRefsForNode reads all refs for a node, ordered case-insensitively.
// Every query against note_refs joins live nodes only, so revived notes come
// back whole and deleted notes are never returned through it.
func selectRefsForNode(q tagQuerier, nodeID string) ([]string, error) {
	rows, err := q.Query(
		`SELECT nr.ref FROM note_refs nr JOIN nodes n ON n.id = nr.node_id AND n.deleted_at IS NULL WHERE nr.node_id = ? ORDER BY nr.ref COLLATE NOCASE ASC`,
		nodeID,
	)
	if err != nil {
		return nil, fmt.Errorf("selectRefsForNode: %w", err)
	}
	defer rows.Close()
	var refs []string
	for rows.Next() {
		var ref string
		if err := rows.Scan(&ref); err != nil {
			return nil, fmt.Errorf("selectRefsForNode: scan: %w", err)
		}
		refs = append(refs, ref)
	}
	return refs, rows.Err()
}

// Note represents a vault note node - all notes share type "note".
// The user-vs-generated distinction is read from frontmatter author/origin,
// not folders (KTD-1, R20).
type Note struct {
	ID        string
	CreatedAt time.Time
	UpdatedAt time.Time
	Origin    string // frontmatter origin, empty for user notes
	Author    string // frontmatter author, empty for user notes
	Title     string // from frontmatter title or filename stem
	Body      string // re-derivable cache stored in attrs (FTS source)
	Kind      string // frontmatter kind, one of plano/implementacao/evidencia/nota
	Refs      []string
	Tags      []string
	// Permission is the note's frontmatter permission override, carried raw
	// from the file. The effective permission - the explicit value when present,
	// otherwise the default derived from author - is resolved by
	// reconcile.ResolvePermission at the surface, mirroring how Author is
	// resolved. It is an honour-system signal, not enforcement: the assistant
	// obeys it by instruction, and the revision log remains the safety net.
	Permission string
	// Channel records where the write that produced this note came from
	// ("cli", "api", "ui", or empty when unknown). It is observed, not
	// declared: the author says who created the file, the channel says where
	// the request came from, and the two are deliberately separate axes.
	Channel string
	// LinkSuggestions are the link targets offered to the writer when the note
	// was written. Machine bookkeeping, kept in attrs so it survives reconcile.
	LinkSuggestions []LinkCandidate
	// NoLinksReason is why the writer declined link suggestions, set only by
	// the CLI's --no-links-reason flag and never defaulted.
	NoLinksReason string
}

// Meta returns the common metadata for this node.
func (n Note) Meta() *Meta {
	return &Meta{ID: n.ID, CreatedAt: n.CreatedAt, UpdatedAt: n.UpdatedAt}
}

// NodeAttrs marshals type-specific fields for the nodes.attrs column.
func (n Note) NodeAttrs() []byte {
	attrs := map[string]any{
		"body":       n.Body,
		"origin":     n.Origin,
		"author":     n.Author,
		"permission": n.Permission,
		"kind":       NormalizeNoteKind(n.Kind),
	}
	if n.Channel != "" {
		attrs["channel"] = n.Channel
	}
	if len(n.LinkSuggestions) > 0 {
		attrs["linkSuggestions"] = n.LinkSuggestions
	}
	if n.NoLinksReason != "" {
		attrs["noLinksReason"] = n.NoLinksReason
	}
	data, _ := json.Marshal(attrs)
	return data
}

// NodeTags returns the tag slice (NodeSpec requirement).
func (n Note) NodeTags() []string { return n.Tags }

// NodeRefs returns the refs slice (optional NodeRefser interface).
func (n Note) NodeRefs() []string { return n.Refs }

// FTSFields returns full-text-searchable content.
func (n Note) FTSFields() FTSFields {
	return FTSFields{Title: n.Title, Body: n.Body, Tags: strings.Join(n.Tags, " ")}
}

// NoteFilter narrows ListNotes results.
type NoteFilter struct {
	Origin         string
	Author         string
	Tags           []string
	Limit          int
	IncludeDeleted bool // opt-in to include tombstoned notes
}

// CreateNote inserts a new note node and returns its ID.
func CreateNote(ctx context.Context, tx *graph.WriteTx, n Note, author Author) (string, error) {
	return createNode(ctx, tx, "note", n, author)
}

// GetNote fetches a single note by ID.
func GetNote(ctx context.Context, tx *graph.ReadTx, id string) (*Note, error) {
	var title, attrsRaw sql.NullString
	var createdAt, updatedAt sql.NullString

	err := tx.QueryRow(
		`SELECT title, attrs, created_at, updated_at FROM nodes WHERE id = ? AND type = 'note' AND deleted_at IS NULL`,
		id,
	).Scan(&title, &attrsRaw, &createdAt, &updatedAt)
	if err == sql.ErrNoRows {
		return nil, graph.ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("GetNote: %w", err)
	}

	var attrs struct {
		Body            string          `json:"body"`
		Origin          string          `json:"origin"`
		Author          string          `json:"author"`
		Permission      string          `json:"permission"`
		Kind            string          `json:"kind"`
		Channel         string          `json:"channel"`
		LinkSuggestions []LinkCandidate `json:"linkSuggestions"`
		NoLinksReason   string          `json:"noLinksReason"`
	}
	if attrsRaw.Valid && attrsRaw.String != "" {
		if err := json.Unmarshal([]byte(attrsRaw.String), &attrs); err != nil {
			return nil, fmt.Errorf("GetNote: unmarshal attrs: %w", err)
		}
	}

	tags, err := selectTagsForNode(tx, id)
	if err != nil {
		return nil, err
	}

	refs, err := selectRefsForNode(tx, id)
	if err != nil {
		return nil, err
	}

	return &Note{
		ID:              id,
		CreatedAt:       tryParseTime(createdAt.String),
		UpdatedAt:       tryParseTime(updatedAt.String),
		Origin:          attrs.Origin,
		Author:          attrs.Author,
		Title:           title.String,
		Body:            attrs.Body,
		Kind:            NormalizeNoteKind(attrs.Kind),
		Refs:            refs,
		Tags:            tags,
		Permission:      attrs.Permission,
		Channel:         attrs.Channel,
		LinkSuggestions: attrs.LinkSuggestions,
		NoLinksReason:   attrs.NoLinksReason,
	}, nil
}

// UpdateNote modifies an existing note.
func UpdateNote(ctx context.Context, tx *graph.WriteTx, n Note, author Author) error {
	return updateNode(ctx, tx, n, author)
}

// DeleteNote hard-deletes a note (non-note-safe path), preserving a tombstone revision.
func DeleteNote(ctx context.Context, tx *graph.WriteTx, id string, author Author) error {
	return deleteNode(ctx, tx, id, author)
}

// SoftDeleteNoteTx tombstones a note in the caller's transaction.
// The node row is kept; deleted_at is set; the FTS row is removed; incoming
// links_to edges are degraded to dangling_links rows; and a tombstone revision
// is appended to the history.
// stem is the filename stem (without extension); title is the display title.
func SoftDeleteNoteTx(ctx context.Context, tx *graph.WriteTx, id, stem, title string, author Author) error {
	return softDeleteNote(ctx, tx, id, stem, title, author)
}

// ReviveNoteTx reverses a soft-delete in the caller's transaction.
// deleted_at is cleared; the FTS row is re-inserted; a revival revision is
// appended; and dangling links matching stem/title are re-promoted to edges.
func ReviveNoteTx(ctx context.Context, tx *graph.WriteTx, id, stem, title string, author Author) error {
	return reviveNote(ctx, tx, id, stem, title, author)
}

// rowQuerier is satisfied by both *graph.ReadTx and *graph.WriteTx.
type rowQuerier interface {
	QueryRow(string, ...any) *sql.Row
}

// IsNoteTombstoned reports whether the note with the given ID has been soft-deleted.
// Accepts both *graph.ReadTx and *graph.WriteTx.
// Returns false, nil when the node does not exist.
func IsNoteTombstoned(_ context.Context, tx rowQuerier, id string) (bool, error) {
	var deletedAt sql.NullString
	err := tx.QueryRow(
		`SELECT deleted_at FROM nodes WHERE id = ? AND type = 'note'`,
		id,
	).Scan(&deletedAt)
	if err == sql.ErrNoRows {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("IsNoteTombstoned: %w", err)
	}
	return deletedAt.Valid, nil
}

// ListNotes returns notes matching the filter.
// Tombstoned notes (deleted_at IS NOT NULL) are excluded by default.
func ListNotes(ctx context.Context, tx *graph.ReadTx, f NoteFilter) ([]*Note, error) {
	query := `SELECT id, title, attrs, created_at, updated_at FROM nodes WHERE type = 'note'`
	var args []any

	if !f.IncludeDeleted {
		query += ` AND deleted_at IS NULL`
	}

	if f.Origin != "" {
		query += ` AND json_extract(attrs, '$.origin') = ?`
		args = append(args, f.Origin)
	}

	if f.Author != "" {
		query += ` AND json_extract(attrs, '$.author') = ?`
		args = append(args, f.Author)
	}

	if len(f.Tags) > 0 {
		query += fmt.Sprintf(
			` AND id IN (SELECT nt.node_id FROM node_tags nt JOIN tags t ON t.id = nt.tag_id WHERE t.name IN (%s))`,
			placeholders(len(f.Tags)),
		)
		for _, tag := range f.Tags {
			args = append(args, tag)
		}
	}

	query += ` ORDER BY created_at DESC`
	if f.Limit > 0 {
		query += ` LIMIT ?`
		args = append(args, f.Limit)
	}

	rows, err := tx.Query(query, args...)
	if err != nil {
		return nil, fmt.Errorf("ListNotes: %w", err)
	}
	defer rows.Close()

	var out []*Note
	for rows.Next() {
		var id string
		var title, attrsRaw sql.NullString
		var createdAt, updatedAt sql.NullString
		if err := rows.Scan(&id, &title, &attrsRaw, &createdAt, &updatedAt); err != nil {
			return nil, fmt.Errorf("ListNotes: scan: %w", err)
		}

		var attrs struct {
			Body            string          `json:"body"`
			Origin          string          `json:"origin"`
			Author          string          `json:"author"`
			Permission      string          `json:"permission"`
			Kind            string          `json:"kind"`
			Channel         string          `json:"channel"`
			LinkSuggestions []LinkCandidate `json:"linkSuggestions"`
			NoLinksReason   string          `json:"noLinksReason"`
		}
		if attrsRaw.Valid && attrsRaw.String != "" {
			if err := json.Unmarshal([]byte(attrsRaw.String), &attrs); err != nil {
				return nil, fmt.Errorf("ListNotes: unmarshal: %w", err)
			}
		}

		tags, err := selectTagsForNode(tx, id)
		if err != nil {
			return nil, err
		}

		refs, err := selectRefsForNode(tx, id)
		if err != nil {
			return nil, err
		}

		out = append(out, &Note{
			ID:              id,
			CreatedAt:       tryParseTime(createdAt.String),
			UpdatedAt:       tryParseTime(updatedAt.String),
			Origin:          attrs.Origin,
			Author:          attrs.Author,
			Title:           title.String,
			Body:            attrs.Body,
			Kind:            NormalizeNoteKind(attrs.Kind),
			Refs:            refs,
			Tags:            tags,
			Permission:      attrs.Permission,
			Channel:         attrs.Channel,
			LinkSuggestions: attrs.LinkSuggestions,
			NoLinksReason:   attrs.NoLinksReason,
		})
	}
	return out, rows.Err()
}

// DiffBody implements DiffableNode for Note, producing a self-describing
// revision payload. For small text bodies it returns a line-oriented forward
// diff; for large/binary bodies or high change ratios it falls back to a
// full snapshot tagged with kind="snapshot".
func (n Note) DiffBody(prev NodeSpec) []byte {
	p, ok := prev.(Note)
	if !ok {
		// Unknown prev type - fall back to snapshot.
		return n.snapshotDiff()
	}

	// Detect binary / threshold exceeded.
	if isBinaryBody(n.Body) || isBinaryBody(p.Body) ||
		len(n.Body) > MaxDiffBytes || len(p.Body) > MaxDiffBytes {
		return n.snapshotDiff()
	}

	// Only apply the change-ratio heuristic when both bodies are non-empty.
	// Empty↔nonempty transitions always have a ratio of 1.0, but the diff is
	// trivially compact (a handful of insert/delete ops), so skip the check.
	if p.Body != "" && n.Body != "" {
		maxLen := len(p.Body)
		if len(n.Body) > maxLen {
			maxLen = len(n.Body)
		}

		delta := len(n.Body) - len(p.Body)
		if delta < 0 {
			delta = -delta
		}
		if float64(delta)/float64(maxLen) > MaxChangeRatio {
			return n.snapshotDiff()
		}
	}

	if int64(len(splitLines(p.Body)))*int64(len(splitLines(n.Body))) > MaxDiffCells {
		return n.snapshotDiff()
	}

	// Line-oriented forward diff. A diff with no operation is stored as
	// {"ops":null}, which reconstruction reads as a snapshot of an empty
	// body, so an unchanged body is answered with a snapshot instead.
	ops := lineDiff(p.Body, n.Body)
	if len(ops) == 0 {
		return n.snapshotDiff()
	}
	payload := diffLinePayload{Ops: ops}
	data, _ := json.Marshal(payload)
	return data
}

// snapshotDiff returns a full-snapshot payload tagged with kind="snapshot".
func (n Note) snapshotDiff() []byte {
	payload := diffSnapshotPayload{
		Title: n.Title,
		Attrs: string(n.NodeAttrs()),
		Tags:  n.Tags,
	}
	data, _ := json.Marshal(payload)
	return data
}

// isBinaryBody returns true if data contains a NUL byte (binary indicator).
func isBinaryBody(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] == 0 {
			return true
		}
	}
	return false
}

// lineDiffOp represents a single operation in a line-based forward diff.
type lineDiffOp struct {
	Op   string `json:"op"` // "+" or "-"
	Line int    `json:"ln"` // 0-based line index
	Text string `json:"t"`  // line content
}

// diffLinePayload is the self-describing diff payload stored in revisions.
// kind is implicitly "line-diff" when Ops is non-nil; absence of kind
// in legacy payloads is interpreted as snapshot.
type diffLinePayload struct {
	Ops []lineDiffOp `json:"ops"`
}

// diffSnapshotPayload is the snapshot payload stored in revisions.
type diffSnapshotPayload struct {
	Title string   `json:"title"`
	Attrs string   `json:"attrs"`
	Tags  []string `json:"tags"`
}

// lineDiff computes a minimal line-oriented forward diff from old to new.
// Uses a simple LCS-based approach that produces "+" and "-" operations.
func lineDiff(oldBody, newBody string) []lineDiffOp {
	oldLines := splitLines(oldBody)
	newLines := splitLines(newBody)

	// Compute LCS table.
	m, n := len(oldLines), len(newLines)
	lcs := make([][]int, m+1)
	for i := range lcs {
		lcs[i] = make([]int, n+1)
	}
	for i := 1; i <= m; i++ {
		for j := 1; j <= n; j++ {
			if oldLines[i-1] == newLines[j-1] {
				lcs[i][j] = lcs[i-1][j-1] + 1
			} else {
				if lcs[i-1][j] >= lcs[i][j-1] {
					lcs[i][j] = lcs[i-1][j]
				} else {
					lcs[i][j] = lcs[i][j-1]
				}
			}
		}
	}

	// Backtrack to produce the diff ops.
	var ops []lineDiffOp
	i, j := m, n
	for i > 0 || j > 0 {
		if i > 0 && j > 0 && oldLines[i-1] == newLines[j-1] {
			i--
			j--
		} else if j > 0 && (i == 0 || lcs[i][j-1] >= lcs[i-1][j]) {
			ops = append(ops, lineDiffOp{Op: "+", Line: j - 1, Text: newLines[j-1]})
			j--
		} else if i > 0 {
			ops = append(ops, lineDiffOp{Op: "-", Line: i - 1, Text: oldLines[i-1]})
			i--
		}
	}
	return ops
}

// splitLines splits s into lines, handling the empty-string case.
func splitLines(s string) []string {
	if s == "" {
		return nil
	}
	lines := strings.Split(s, "\n")
	return lines
}
