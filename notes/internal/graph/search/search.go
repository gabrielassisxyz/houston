// Package search provides full-text search over graph nodes via SQLite FTS5.
package search

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"unicode"

	"github.com/gabrielassisxyz/houston/notes/internal/graph"
)

// Hit represents a single search result.
type Hit struct {
	NodeID string
	Title  string
	Rank   float64
}

// options holds optional filters for a search query.
type options struct {
	tags      []string
	types     []string
	prefix    bool
	titleOnly bool
}

// Option modifies search behaviour.
type Option func(*options)

// WithPrefix turns the final query token into a prefix match, so a partial
// token like "lin" matches "Linktree". This enables autocomplete-as-you-type
// without affecting the default exact-phrase behaviour.
func WithPrefix() Option {
	return func(o *options) {
		o.prefix = true
	}
}

// WithTitleOnly restricts the FTS5 match to the title column, dropping body
// and tag matches. The editor's wikilink autocomplete uses this: a completion
// list is scanned by title, so a body match cannot be scanned.
func WithTitleOnly() Option {
	return func(o *options) {
		o.titleOnly = true
	}
}

// WithTags filters results to nodes that have ALL of the given tags.
func WithTags(tags ...string) Option {
	return func(o *options) {
		o.tags = tags
	}
}

// WithTypes filters results to nodes whose type is in the given list.
func WithTypes(types ...string) Option {
	return func(o *options) {
		o.types = types
	}
}

// Search executes a full-text search against the nodes_fts virtual table.
//
// The query string is cleaned of FTS5 special characters before being
// wrapped in double-quotes to perform a phrase search.  An empty query
// returns graph.ErrFTSQuerySyntax.
//
// Errors containing the substring "fts5" in their message (as returned
// by the SQLite FTS5 extension) are wrapped with graph.ErrFTSQuerySyntax.
func Search(ctx context.Context, tx *graph.ReadTx, query string, opts ...Option) ([]Hit, error) {
	query = strings.TrimSpace(query)
	if query == "" {
		return nil, graph.ErrFTSQuerySyntax
	}

	var o options
	for _, opt := range opts {
		opt(&o)
	}

	cleaned := sanitizeFTSQuery(query)
	if cleaned == "" {
		return nil, graph.ErrFTSQuerySyntax
	}

	sqlStr, sqlArgs := buildQuery(cleaned, o)

	rows, err := tx.Query(sqlStr, sqlArgs...)
	if err != nil {
		if isFTS5Error(err) {
			return nil, fmt.Errorf("search: %w", graph.ErrFTSQuerySyntax)
		}
		return nil, fmt.Errorf("search: query: %w", err)
	}
	defer rows.Close()

	var hits []Hit
	for rows.Next() {
		var id string
		var title string
		var rank float64
		if err := rows.Scan(&id, &title, &rank); err != nil {
			return nil, fmt.Errorf("search: scan: %w", err)
		}
		hits = append(hits, Hit{NodeID: id, Title: title, Rank: rank})
	}
	if err := rows.Err(); err != nil {
		if isFTS5Error(err) {
			return nil, fmt.Errorf("search: %w", graph.ErrFTSQuerySyntax)
		}
		return nil, fmt.Errorf("search: rows: %w", err)
	}
	if rows.Err() != nil {
		return nil, fmt.Errorf("search: rows: %w", rows.Err())
	}

	return hits, nil
}

// sanitizeFTSQuery strips characters that have special meaning in the
// FTS5 query syntax.  It also collapses internal double-quote usage to
// prevent the user from injecting syntax.  The result is a plain string
// safe for wrapping in double-quotes for phrase matching.
func sanitizeFTSQuery(raw string) string {
	// Remove or replace FTS5 special characters.
	replacer := strings.NewReplacer(
		`"`, " ",
		`""`, " ",
		`*`, " ",
		`^`, " ",
		`(`, " ",
		`)`, " ",
		`-`, " ",
		`+`, " ",
	)
	s := replacer.Replace(raw)

	// Collapse multiple spaces and trim.
	fields := strings.Fields(s)
	if len(fields) == 0 {
		return ""
	}
	return strings.Join(fields, " ")
}

// buildQuery constructs the parameterized SQL and argument slice.
func buildQuery(cleaned string, o options) (string, []any) {
	var b strings.Builder
	args := make([]any, 0, 1+len(o.tags)+len(o.types))

	b.WriteString(`SELECT n.id, n.title, rank`)
	b.WriteString(` FROM nodes_fts(?) ft`)
	args = append(args, buildMatchExpr(cleaned, o.prefix, o.titleOnly))

	b.WriteString(` JOIN nodes n ON n.fts_rowid = ft.rowid`)

	if len(o.tags) > 0 {
		b.WriteString(` JOIN node_tags nt ON nt.node_id = n.id`)
		b.WriteString(` JOIN tags t ON t.id = nt.tag_id`)
	}

	// WHERE clause: always exclude tombstoned nodes (deleted_at IS NULL).
	// Non-note rows always have NULL deleted_at so this is a no-op for them.
	whereClauses := make([]string, 0, 3)
	whereClauses = append(whereClauses, "n.deleted_at IS NULL")

	if len(o.tags) > 0 {
		placeholders := make([]string, len(o.tags))
		for i := range o.tags {
			placeholders[i] = "?"
		}
		whereClauses = append(whereClauses,
			fmt.Sprintf("t.name IN (%s)", strings.Join(placeholders, ", ")))
		for _, tag := range o.tags {
			args = append(args, tag)
		}
	}

	if len(o.types) > 0 {
		placeholders := make([]string, len(o.types))
		for i := range o.types {
			placeholders[i] = "?"
		}
		whereClauses = append(whereClauses,
			fmt.Sprintf("n.type IN (%s)", strings.Join(placeholders, ", ")))
		for _, typ := range o.types {
			args = append(args, typ)
		}
	}

	if len(whereClauses) > 0 {
		b.WriteString(` WHERE `)
		b.WriteString(strings.Join(whereClauses, ` AND `))
	}

	if len(o.tags) > 0 {
		b.WriteString(` GROUP BY n.id HAVING COUNT(DISTINCT t.name) = `)
		fmt.Fprintf(&b, "%d", len(o.tags))
	}

	b.WriteString(` ORDER BY rank ASC`)

	return b.String(), args
}

// buildMatchExpr builds the FTS5 MATCH expression from the sanitized query.
//
// Without prefix it wraps the whole query in double-quotes for a phrase match,
// preserving the original behaviour. With prefix it quotes each token and
// appends '*' to the final token (FTS5 prefix syntax), so the last word the
// user is still typing matches by prefix while earlier words match exactly.
// The '*' is added here, after sanitizeFTSQuery has already stripped any
// user-supplied '*', so it cannot be injected.
//
// When titleOnly is set, every token is qualified to the title column, so the
// match never reaches the attrs column (body and tags).
func buildMatchExpr(cleaned string, prefix, titleOnly bool) string {
	qualifier := ""
	if titleOnly {
		qualifier = "title : "
	}
	if !prefix {
		return qualifier + `"` + cleaned + `"`
	}
	tokens := strings.Fields(cleaned)
	parts := make([]string, len(tokens))
	for i, tok := range tokens {
		parts[i] = qualifier + `"` + tok + `"`
		if i == len(tokens)-1 {
			parts[i] += "*"
		}
	}
	return strings.Join(parts, " ")
}

// isFTS5Error checks whether an error returned by the SQLite driver
// originates from the FTS5 extension.
func isFTS5Error(err error) bool {
	if err == nil {
		return false
	}
	msg := err.Error()
	if strings.Contains(msg, "fts5") || strings.Contains(msg, "FTS5") {
		return true
	}
	if strings.Contains(msg, "malformed") && strings.Contains(msg, "match") {
		return true
	}

	// Also check for fts5-like errors in wrapped errors.
	var unwrapped = err
	for {
		if strings.Contains(unwrapped.Error(), "fts5") {
			return true
		}
		unwrapped = errors.Unwrap(unwrapped)
		if unwrapped == nil {
			break
		}
	}

	return false
}

// RankedHit is one ranked notes search result over live notes with a path.
type RankedHit struct {
	NodeID string
	Title  string
	Path   string
	Kind   string
	Tags   []string
	// Snippet is the FTS snippet with STX/ETX match markers, or the
	// 160-character body excerpt when every token matched through refs.
	Snippet string
	Rank    float64
}

// rankedSnippetMarkers holds the snippet() call arguments: STX and ETX as the
// match markers, "…" as the ellipsis, 24 tokens. The markers are control
// characters so they cannot collide with Markdown.
const rankedSnippetSelect = `snippet(nodes_fts, -1, '` + "\x02" + `', '` + "\x03" + `', '…', 24)`

// stripQueryControls removes control characters, NUL included, from a query.
func stripQueryControls(s string) string {
	return strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, s)
}

// hasLetterOrDigit reports whether s holds at least one letter or digit.
func hasLetterOrDigit(s string) bool {
	for _, r := range s {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			return true
		}
	}
	return false
}

// isIdentifierToken reports whether a token is identifier-shaped: it holds
// -, _, / or ., so the tokenizer splits it and it must be checked as an
// exact substring after the FTS phrase match.
func isIdentifierToken(s string) bool {
	return strings.ContainsAny(s, "-_/.")
}

// quoteFTSToken quotes one token for the FTS5 MATCH expression. The token is
// already stripped of `"`, so quoting neutralises FTS5 operators (AND, OR,
// NOT, NEAR, `:` and braces): they become plain words inside quotes.
func quoteFTSToken(s string) string {
	return `"` + s + `"`
}

// escapeLikeFold escapes the LIKE wildcards `%`, `_` and the escape itself.
// escapeLikeFold escapes the LIKE wildcards `%`, `_` and the escape itself.
func escapeLikeFold(s string) string {
	s = strings.ReplaceAll(s, `\`, `\\`)
	s = strings.ReplaceAll(s, `%`, `\%`)
	return strings.ReplaceAll(s, `_`, `\_`)
}

// normalizeRankedFolder trims spaces and leading/trailing slashes. An empty
// result means no folder filter.
func normalizeRankedFolder(folder string) string {
	f := strings.TrimSpace(folder)
	return strings.Trim(f, "/")
}

// rankedFilters builds the filter fragment shared by the ranked FTS and refs
// queries: tag and folder as EXISTS sub-queries, kind as a COALESCE predicate
// (a missing kind reads as nota). The GROUP BY/HAVING shape of the old tag
// filter is not used, so the FTS5 auxiliary functions stay available.
func rankedFilters(tag, folder, kind string, args []any) (string, []any) {
	var b strings.Builder
	if t := strings.TrimSpace(tag); t != "" {
		b.WriteString(` AND EXISTS (SELECT 1 FROM node_tags nt JOIN tags tg ON tg.id = nt.tag_id WHERE nt.node_id = n.id AND tg.name = ?)`)
		args = append(args, t)
	}
	if f := normalizeRankedFolder(folder); f != "" {
		b.WriteString(` AND EXISTS (SELECT 1 FROM note_paths np2 WHERE np2.uuid = n.id AND (np2.path = ? OR np2.path LIKE ? ESCAPE '\'))`)
		args = append(args, f, escapeLikeFold(f)+"/%")
	}
	if k := strings.ToLower(strings.TrimSpace(kind)); k != "" {
		b.WriteString(` AND COALESCE(NULLIF(json_extract(n.attrs, '$.kind'), ''), 'nota') = ?`)
		args = append(args, k)
	}
	return b.String(), args
}

// BuildRankedQuery builds the ranked FTS query for one MATCH expression over
// live notes with a path, ordered by bm25 ascending (more negative is
// better), title weighted above the body. The FROM shape mirrors buildQuery
// so the same idx_nodes_fts_rowid plan applies; bm25 and snippet name the
// table (nodes_fts), never the alias, which the bundled SQLite requires. The
// joins are CROSS JOINs, which stop the planner from starting at nodes via
// idx_nodes_type and scanning the FTS table once a note_paths join is added;
// the match must drive through fts_rowid, the scaling the pinned plan guards.
func BuildRankedQuery(matchExpr, tag, folder, kind string) (string, []any) {
	args := []any{matchExpr}
	var b strings.Builder
	b.WriteString(`SELECT n.id, n.title, json_extract(n.attrs, '$.body') AS body, np.path, `)
	b.WriteString(`COALESCE(NULLIF(json_extract(n.attrs, '$.kind'), ''), 'nota') AS kind, `)
	b.WriteString(`bm25(nodes_fts, 10.0, 1.0) AS rank, `)
	b.WriteString(rankedSnippetSelect)
	b.WriteString(` AS snippet FROM nodes_fts(?) ft`)
	b.WriteString(` CROSS JOIN nodes n ON n.fts_rowid = ft.rowid`)
	b.WriteString(` CROSS JOIN note_paths np ON np.uuid = n.id`)
	b.WriteString(` WHERE n.type = 'note' AND n.deleted_at IS NULL`)
	frag, next := rankedFilters(tag, folder, kind, args)
	b.WriteString(frag)
	args = next
	b.WriteString(` ORDER BY rank ASC`)
	return b.String(), args
}

// RankedSearch answers the ranked notes search over live notes with a path.
// Each token must match via FTS (with the exact-substring check for
// identifier-shaped ones) or via note_refs; refs-matching notes come first
// ordered by path, the rest follow ordered by bm25. It returns every match
// ordered; paging is applied by the caller so total stays exact.
func RankedSearch(ctx context.Context, tx *graph.ReadTx, query, tag, folder, kind string) ([]RankedHit, error) {
	if strings.TrimSpace(query) == "" {
		return nil, graph.ErrFTSQuerySyntax
	}
	cleaned := strings.TrimSpace(stripQueryControls(query))
	if cleaned == "" {
		return []RankedHit{}, nil
	}
	rawTokens := strings.Fields(cleaned)
	var tokens []string
	for _, raw := range rawTokens {
		t := strings.ReplaceAll(raw, `"`, "")
		if strings.TrimSpace(t) == "" {
			continue
		}
		tokens = append(tokens, t)
	}
	if len(tokens) == 0 {
		return []RankedHit{}, nil
	}
	var ftsTokens []string
	for _, t := range tokens {
		if hasLetterOrDigit(t) {
			ftsTokens = append(ftsTokens, t)
		}
	}

	// Per-token FTS matches (with the identifier substring check) and per-token
	// refs matches, each already filtered by tag/folder/kind.
	ftsSets := make(map[string]map[string]struct{}, len(ftsTokens))
	for _, tok := range ftsTokens {
		ids, err := rankedFTSTokenMatches(tx, tok, tag, folder, kind)
		if err != nil {
			return nil, err
		}
		ftsSets[tok] = ids
	}
	refsSets := make(map[string]map[string]struct{}, len(tokens))
	for _, tok := range tokens {
		ids, err := rankedRefsTokenMatches(tx, tok, tag, folder, kind)
		if err != nil {
			return nil, err
		}
		refsSets[tok] = ids
	}

	// Union per token, intersect across tokens.
	var final []string
	seen := make(map[string]int, 64)
	for _, tok := range tokens {
		union := make(map[string]struct{})
		for id := range ftsSets[tok] {
			union[id] = struct{}{}
		}
		for id := range refsSets[tok] {
			union[id] = struct{}{}
		}
		if len(union) == 0 {
			return []RankedHit{}, nil
		}
		for id := range union {
			seen[id]++
		}
	}
	for id, n := range seen {
		if n == len(tokens) {
			final = append(final, id)
		}
	}
	if len(final) == 0 {
		return []RankedHit{}, nil
	}

	// Details for every finalist.
	details, err := rankedFetchDetails(tx, final)
	if err != nil {
		return nil, err
	}
	if err := rankedAttachTags(tx, details); err != nil {
		return nil, err
	}

	// Split refs-involved (any token matched via refs) first, the rest by rank.
	type scored struct {
		hit   RankedHit
		body  string
		refs  bool
		ftsOK []string
	}
	var refsGroup, ftsGroup []scored
	for _, id := range final {
		d, ok := details[id]
		if !ok {
			continue
		}
		refsMatched := false
		var ftsMatched []string
		for _, tok := range tokens {
			if _, ok := refsSets[tok][id]; ok {
				refsMatched = true
			}
		}
		for _, tok := range ftsTokens {
			if _, ok := ftsSets[tok][id]; ok {
				ftsMatched = append(ftsMatched, tok)
			}
		}
		hit := RankedHit{NodeID: id, Title: d.title, Path: d.path, Kind: d.kind, Tags: d.tags}
		if refsMatched {
			refsGroup = append(refsGroup, scored{hit: hit, body: d.body, refs: true, ftsOK: ftsMatched})
		} else {
			ftsGroup = append(ftsGroup, scored{hit: hit, body: d.body, ftsOK: ftsMatched})
		}
	}

	// FTS-only group: rank and snippet from the full expression.
	if len(ftsGroup) > 0 && len(ftsTokens) > 0 {
		expr := make([]string, len(ftsTokens))
		for i, tok := range ftsTokens {
			expr[i] = quoteFTSToken(tok)
		}
		sqlStr, args := BuildRankedQuery(strings.Join(expr, " "), tag, folder, kind)
		rows, err := tx.Query(sqlStr, args...)
		if err != nil {
			if isFTS5Error(err) {
				return nil, fmt.Errorf("ranked search: %w", graph.ErrFTSQuerySyntax)
			}
			return nil, fmt.Errorf("ranked search: query: %w", err)
		}
		ranks := make(map[string]float64, len(ftsGroup))
		snips := make(map[string]string, len(ftsGroup))
		for rows.Next() {
			var id, title, body, path, kindVal, snip string
			var rank float64
			if err := rows.Scan(&id, &title, &body, &path, &kindVal, &rank, &snip); err != nil {
				rows.Close()
				return nil, fmt.Errorf("ranked search: scan: %w", err)
			}
			// The full expression cannot apply the identifier substring
			// check; keep only rows that passed every per-token check.
			keep := true
			for _, tok := range ftsTokens {
				if _, ok := ftsSets[tok][id]; !ok {
					keep = false
					break
				}
			}
			if keep {
				ranks[id] = rank
				snips[id] = snip
			}
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return nil, fmt.Errorf("ranked search: rows: %w", err)
		}
		var kept []scored
		for _, s := range ftsGroup {
			rank, ok := ranks[s.hit.NodeID]
			if !ok {
				continue
			}
			s.hit.Rank = rank
			s.hit.Snippet = snips[s.hit.NodeID]
			kept = append(kept, s)
		}
		ftsGroup = kept
		sort.Slice(ftsGroup, func(i, j int) bool {
			if ftsGroup[i].hit.Rank == ftsGroup[j].hit.Rank {
				return ftsGroup[i].hit.Path < ftsGroup[j].hit.Path
			}
			return ftsGroup[i].hit.Rank < ftsGroup[j].hit.Rank
		})
	}

	// Refs group: snippet from the FTS-matched tokens, excerpt otherwise.
	sort.Slice(refsGroup, func(i, j int) bool { return refsGroup[i].hit.Path < refsGroup[j].hit.Path })
	for i := range refsGroup {
		s := &refsGroup[i]
		if len(s.ftsOK) == 0 {
			s.hit.Snippet = rankedExcerpt(s.body)
			continue
		}
		expr := make([]string, len(s.ftsOK))
		for j, tok := range s.ftsOK {
			expr[j] = quoteFTSToken(tok)
		}
		snip, rank, err := rankedSnippetForNote(tx, strings.Join(expr, " "), s.hit.NodeID)
		if err != nil {
			return nil, err
		}
		s.hit.Snippet = snip
		s.hit.Rank = rank
	}

	out := make([]RankedHit, 0, len(refsGroup)+len(ftsGroup))
	for _, s := range refsGroup {
		out = append(out, s.hit)
	}
	for _, s := range ftsGroup {
		out = append(out, s.hit)
	}
	return out, nil
}

// rankedFTSTokenMatches returns the live notes with a path matching one FTS
// token, filtered by tag/folder/kind. Identifier-shaped tokens are queried as
// a phrase and kept only on an exact case-insensitive substring of the title
// or body, so hou-4kz never matches a note that says hou 4kz.
func rankedFTSTokenMatches(tx *graph.ReadTx, tok, tag, folder, kind string) (map[string]struct{}, error) {
	sqlStr, args := BuildRankedQuery(quoteFTSToken(tok), tag, folder, kind)
	rows, err := tx.Query(sqlStr, args...)
	if err != nil {
		if isFTS5Error(err) {
			return nil, fmt.Errorf("ranked search: %w", graph.ErrFTSQuerySyntax)
		}
		return nil, fmt.Errorf("ranked search: query: %w", err)
	}
	defer rows.Close()
	out := make(map[string]struct{})
	ident := isIdentifierToken(tok)
	lower := strings.ToLower(tok)
	for rows.Next() {
		var id, title, body, path, kindVal, snip string
		var rank float64
		if err := rows.Scan(&id, &title, &body, &path, &kindVal, &rank, &snip); err != nil {
			return nil, fmt.Errorf("ranked search: scan: %w", err)
		}
		if ident {
			if !strings.Contains(strings.ToLower(title), lower) && !strings.Contains(strings.ToLower(body), lower) {
				continue
			}
		}
		out[id] = struct{}{}
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("ranked search: rows: %w", err)
	}
	return out, nil
}

// rankedRefsTokenMatches returns the live notes with a path whose note_refs
// hold one token (compared without regard to case), filtered by
// tag/folder/kind.
func rankedRefsTokenMatches(tx *graph.ReadTx, tok, tag, folder, kind string) (map[string]struct{}, error) {
	var b strings.Builder
	args := []any{tok}
	b.WriteString(`SELECT DISTINCT n.id FROM nodes n`)
	b.WriteString(` JOIN note_paths np ON np.uuid = n.id`)
	b.WriteString(` JOIN note_refs nr ON nr.node_id = n.id`)
	b.WriteString(` WHERE n.type = 'note' AND n.deleted_at IS NULL`)
	b.WriteString(` AND nr.ref COLLATE NOCASE = ?`)
	if t := strings.TrimSpace(tag); t != "" {
		b.WriteString(` AND EXISTS (SELECT 1 FROM node_tags nt JOIN tags tg ON tg.id = nt.tag_id WHERE nt.node_id = n.id AND tg.name = ?)`)
		args = append(args, t)
	}
	if f := normalizeRankedFolder(folder); f != "" {
		b.WriteString(` AND (np.path = ? OR np.path LIKE ? ESCAPE '\')`)
		args = append(args, f, escapeLikeFold(f)+"/%")
	}
	if k := strings.ToLower(strings.TrimSpace(kind)); k != "" {
		b.WriteString(` AND COALESCE(NULLIF(json_extract(n.attrs, '$.kind'), ''), 'nota') = ?`)
		args = append(args, k)
	}
	rows, err := tx.Query(b.String(), args...)
	if err != nil {
		return nil, fmt.Errorf("ranked search: refs query: %w", err)
	}
	defer rows.Close()
	out := make(map[string]struct{})
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("ranked search: refs scan: %w", err)
		}
		out[id] = struct{}{}
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("ranked search: refs rows: %w", err)
	}
	return out, nil
}

type rankedDetails struct {
	title string
	body  string
	path  string
	kind  string
	tags  []string
}

// rankedFetchDetails reads title, body, path and kind for the finalists.
func rankedFetchDetails(tx *graph.ReadTx, ids []string) (map[string]*rankedDetails, error) {
	ph := make([]string, len(ids))
	args := make([]any, len(ids))
	for i, id := range ids {
		ph[i] = "?"
		args[i] = id
	}
	rows, err := tx.Query(
		`SELECT n.id, n.title, COALESCE(json_extract(n.attrs, '$.body'), ''), np.path, COALESCE(NULLIF(json_extract(n.attrs, '$.kind'), ''), 'nota') FROM nodes n JOIN note_paths np ON np.uuid = n.id WHERE n.id IN (`+strings.Join(ph, ",")+`) AND n.type = 'note' AND n.deleted_at IS NULL`,
		args...,
	)
	if err != nil {
		return nil, fmt.Errorf("ranked search: details query: %w", err)
	}
	defer rows.Close()
	out := make(map[string]*rankedDetails, len(ids))
	for rows.Next() {
		var id, title, body, path, kind string
		if err := rows.Scan(&id, &title, &body, &path, &kind); err != nil {
			return nil, fmt.Errorf("ranked search: details scan: %w", err)
		}
		out[id] = &rankedDetails{title: title, body: body, path: path, kind: kind, tags: []string{}}
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("ranked search: details rows: %w", err)
	}
	return out, nil
}

// rankedAttachTags fills sorted tags for the finalists in one pass.
func rankedAttachTags(tx *graph.ReadTx, byID map[string]*rankedDetails) error {
	if len(byID) == 0 {
		return nil
	}
	ids := make([]string, 0, len(byID))
	for id := range byID {
		ids = append(ids, id)
	}
	ph := make([]string, len(ids))
	args := make([]any, len(ids))
	for i, id := range ids {
		ph[i] = "?"
		args[i] = id
	}
	rows, err := tx.Query(
		`SELECT nt.node_id, tg.name FROM node_tags nt JOIN tags tg ON tg.id = nt.tag_id WHERE nt.node_id IN (`+strings.Join(ph, ",")+`) ORDER BY tg.name ASC`,
		args...,
	)
	if err != nil {
		return fmt.Errorf("ranked search: tags query: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var nodeID, name string
		if err := rows.Scan(&nodeID, &name); err != nil {
			return fmt.Errorf("ranked search: tags scan: %w", err)
		}
		if d, ok := byID[nodeID]; ok {
			d.tags = append(d.tags, name)
		}
	}
	return rows.Err()
}

// rankedSnippetForNote returns the snippet and rank for one note under one
// MATCH expression.
func rankedSnippetForNote(tx *graph.ReadTx, matchExpr, nodeID string) (string, float64, error) {
	var snip string
	var rank float64
	err := tx.QueryRow(
		`SELECT `+rankedSnippetSelect+`, bm25(nodes_fts, 10.0, 1.0) FROM nodes_fts(?) ft JOIN nodes n ON n.fts_rowid = ft.rowid WHERE n.id = ? AND n.type = 'note' AND n.deleted_at IS NULL`,
		matchExpr, nodeID,
	).Scan(&snip, &rank)
	if err != nil {
		return "", 0, fmt.Errorf("ranked search: snippet query: %w", err)
	}
	return snip, rank, nil
}

// rankedExcerpt returns the first 160 characters of a body with the snippet
// markers removed, for hits found only through refs.
func rankedExcerpt(body string) string {
	body = strings.ReplaceAll(body, "\x02", "")
	body = strings.ReplaceAll(body, "\x03", "")
	runes := []rune(body)
	if len(runes) > 160 {
		return string(runes[:160])
	}
	return body
}
