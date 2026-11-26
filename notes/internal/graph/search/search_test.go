package search_test

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/gabrielassisxyz/houston/notes/internal/graph"
	"github.com/gabrielassisxyz/houston/notes/internal/graph/nodes"
	"github.com/gabrielassisxyz/houston/notes/internal/graph/search"
	"github.com/gabrielassisxyz/houston/notes/internal/graph/testutil"
)

// setupSearchNode creates a node with its FTS index row linked.
func setupSearchNode(t *testing.T, g *graph.Graph, id, nodeType, title, body string, tags []string) {
	t.Helper()
	err := g.DoWrite(context.Background(), func(wtx *graph.WriteTx) error {
		attrs := `{"body":"` + strings.ReplaceAll(body, `"`, `\"`) + `"}`
		_, err := wtx.Exec(
			`INSERT INTO nodes(id, type, title, attrs) VALUES (?, ?, ?, ?)`,
			id, nodeType, title, attrs,
		)
		if err != nil {
			return fmt.Errorf("insert node: %w", err)
		}

		// Mirror production: the FTS attrs column holds body then tags.
		ftsAttrs := body
		if len(tags) > 0 {
			if ftsAttrs != "" {
				ftsAttrs += " "
			}
			ftsAttrs += strings.Join(tags, " ")
		}
		_, err = wtx.Exec(
			`INSERT INTO nodes_fts(title, attrs) VALUES (?, ?)`,
			title, ftsAttrs,
		)
		if err != nil {
			return fmt.Errorf("insert fts: %w", err)
		}

		_, err = wtx.Exec(
			`UPDATE nodes SET fts_rowid = last_insert_rowid() WHERE id = ?`,
			id,
		)
		if err != nil {
			return fmt.Errorf("update fts_rowid: %w", err)
		}

		for _, tag := range tags {
			_, err := wtx.Exec(`INSERT OR IGNORE INTO tags(id, name) VALUES (?, ?)`,
				id+"-"+tag, tag,
			)
			if err != nil {
				return fmt.Errorf("insert tag: %w", err)
			}
			_, err = wtx.Exec(
				`INSERT INTO node_tags(node_id, tag_id) VALUES (?, ?)`,
				id, id+"-"+tag,
			)
			if err != nil {
				return fmt.Errorf("insert node_tags: %w", err)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatalf("setupSearchNode: %v", err)
	}
}

// TestSearchReturnsHit verifies basic search returns a matching hit (bead kernl-7m5w).
func TestSearchReturnsHit(t *testing.T) {
	g := testutil.NewInMemoryTestGraph(t)
	setupSearchNode(t, g, "n1", "note", "Hello World", "some body content", nil)

	var hits []search.Hit
	err := g.DoRead(context.Background(), func(rtx *graph.ReadTx) error {
		var serr error
		hits, serr = search.Search(context.Background(), rtx, "Hello")
		return serr
	})
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if len(hits) != 1 {
		t.Fatalf("expected 1 hit, got %d", len(hits))
	}
	if hits[0].NodeID != "n1" {
		t.Errorf("expected NodeID n1, got %s", hits[0].NodeID)
	}
	if hits[0].Title != "Hello World" {
		t.Errorf("expected Title 'Hello World', got %s", hits[0].Title)
	}
}

// TestSearchWithTagsFilter verifies tag filtering (bead kernl-a7va).
func TestSearchWithTagsFilter(t *testing.T) {
	g := testutil.NewInMemoryTestGraph(t)
	setupSearchNode(t, g, "n1", "note", "Shared Title", "body one", []string{"alpha"})
	setupSearchNode(t, g, "n2", "note", "Shared Title", "body two", []string{"beta"})

	var hits []search.Hit
	err := g.DoRead(context.Background(), func(rtx *graph.ReadTx) error {
		var serr error
		hits, serr = search.Search(context.Background(), rtx, "Shared",
			search.WithTags("alpha"),
		)
		return serr
	})
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if len(hits) != 1 {
		t.Fatalf("expected 1 hit with tag alpha, got %d", len(hits))
	}
	if hits[0].NodeID != "n1" {
		t.Errorf("expected n1, got %s", hits[0].NodeID)
	}
}

// TestSearchWithTypes verifies type filtering (bead kernl-eauq).
func TestSearchWithTypes(t *testing.T) {
	g := testutil.NewInMemoryTestGraph(t)
	setupSearchNode(t, g, "n1", "note", "Common", "body", nil)
	setupSearchNode(t, g, "n2", "task", "Common", "body", nil)

	var hits []search.Hit
	err := g.DoRead(context.Background(), func(rtx *graph.ReadTx) error {
		var serr error
		hits, serr = search.Search(context.Background(), rtx, "Common",
			search.WithTypes("note"),
		)
		return serr
	})
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if len(hits) != 1 {
		t.Fatalf("expected 1 hit with type note, got %d", len(hits))
	}
	if hits[0].NodeID != "n1" {
		t.Errorf("expected n1, got %s", hits[0].NodeID)
	}
}

// TestSearchMalformedQueryReturnsWrappedError verifies FTS5 errors are
// wrapped with graph.ErrFTSQuerySyntax (bead kernl-q8gp).
func TestSearchMalformedQueryReturnsWrappedError(t *testing.T) {
	g := testutil.NewInMemoryTestGraph(t)

	// Pass a query that sanitizes to empty, which FTS5 may reject
	// when passed as an empty quoted string.
	err := g.DoRead(context.Background(), func(rtx *graph.ReadTx) error {
		_, serr := search.Search(context.Background(), rtx, "***")
		return serr
	})
	// Either ErrFTSQuerySyntax directly (if handled before FTS5),
	// or wrapped. The sanitize function strips *, so "***" becomes empty
	// which Search treats as graph.ErrFTSQuerySyntax directly.
	if err == nil {
		t.Fatal("expected error for malformed query, got nil")
	}
	if !errors.Is(err, graph.ErrFTSQuerySyntax) {
		t.Errorf("expected ErrFTSQuerySyntax, got %v", err)
	}

	// Also test isFTS5Error detection through Search by directly
	// constructing a bad query. Pass a query with unbalanced FTS5
	// special column prefix that our sanitize does not strip (e.g.
	// a lone colon which FTS5 interprets as a column specifier).
	// However our sanitize + quote wrapping makes most things safe.
	// We confirm the wrapping path by verifying that a legit query
	// that FTS5 itself rejects gets caught.
	// Construct a very long query that may trigger FTS5 issues.
	longQuery := strings.Repeat("x ", 10000)
	err = g.DoRead(context.Background(), func(rtx *graph.ReadTx) error {
		_, serr := search.Search(context.Background(), rtx, longQuery)
		return serr
	})
	if err != nil {
		// If FTS5 rejects this, ensure it's wrapped correctly.
		if strings.Contains(err.Error(), "fts5") || strings.Contains(err.Error(), "FTS5") {
			if !errors.Is(err, graph.ErrFTSQuerySyntax) {
				t.Errorf("FTS5 error not wrapped: %v", err)
			}
		}
	}
}

// TestFTSSpecialCharsInBody verifies nodes with quotes/asterisks in body
// can be searched without crashing (bead kernl-14fd).
func TestFTSSpecialCharsInBody(t *testing.T) {
	g := testutil.NewInMemoryTestGraph(t)
	setupSearchNode(t, g, "n1", "note", "Special", `this has "quotes" and *asterisks*`, nil)

	var hits []search.Hit
	err := g.DoRead(context.Background(), func(rtx *graph.ReadTx) error {
		var serr error
		hits, serr = search.Search(context.Background(), rtx, "quotes")
		return serr
	})
	if err != nil {
		t.Fatalf("Search should not crash with special chars in body: %v", err)
	}
	if len(hits) == 0 {
		t.Error("expected at least 1 hit for 'quotes'")
	}
}

// TestFTSPortugueseDiacritics verifies that FTS5 with unicode61
// handles Portuguese diacritics - searching for "coracao" finds
// "coração" (bead kernl-atzm).
func TestFTSPortugueseDiacritics(t *testing.T) {
	g := testutil.NewInMemoryTestGraph(t)
	setupSearchNode(t, g, "n1", "note", "Coração", "um texto com coração", nil)

	var hits []search.Hit
	err := g.DoRead(context.Background(), func(rtx *graph.ReadTx) error {
		var serr error
		hits, serr = search.Search(context.Background(), rtx, "coracao")
		return serr
	})
	if err != nil {
		t.Fatalf("Search for 'coracao': %v", err)
	}
	if len(hits) == 0 {
		t.Error("expected hit when searching 'coracao' for node with 'coração'")
	}
}

// TestFTSMaxLengthQuery verifies that a very long query does not crash (bead kernl-cf88).
func TestFTSMaxLengthQuery(t *testing.T) {
	g := testutil.NewInMemoryTestGraph(t)
	setupSearchNode(t, g, "n1", "note", "Normal Title", "normal body", nil)

	longQuery := strings.Repeat("a", 5000)
	err := g.DoRead(context.Background(), func(rtx *graph.ReadTx) error {
		_, serr := search.Search(context.Background(), rtx, longQuery)
		return serr
	})
	if err != nil {
		t.Fatalf("Search with long query should not crash: %v", err)
	}
}

// TestFTSEmptyQuery verifies empty query returns ErrFTSQuerySyntax (bead kernl-ku0v).
func TestFTSEmptyQuery(t *testing.T) {
	g := testutil.NewInMemoryTestGraph(t)
	err := g.DoRead(context.Background(), func(rtx *graph.ReadTx) error {
		_, serr := search.Search(context.Background(), rtx, "")
		return serr
	})
	if err == nil {
		t.Fatal("expected error for empty query, got nil")
	}
	if !errors.Is(err, graph.ErrFTSQuerySyntax) {
		t.Errorf("expected ErrFTSQuerySyntax, got %v", err)
	}
}

// TestFTSMixedEnglishPortuguese verifies mixed-language search (bead kernl-v44a).
func TestFTSMixedEnglishPortuguese(t *testing.T) {
	g := testutil.NewInMemoryTestGraph(t)
	setupSearchNode(t, g, "n1", "note", "Hello mundo bonito", "english and portuguese mixed", nil)

	var hits []search.Hit
	err := g.DoRead(context.Background(), func(rtx *graph.ReadTx) error {
		var serr error
		hits, serr = search.Search(context.Background(), rtx, "Hello")
		return serr
	})
	if err != nil {
		t.Fatalf("Search for 'Hello': %v", err)
	}
	if len(hits) == 0 {
		t.Error("expected hit for English term 'Hello' in mixed-language title")
	}
}

// TestSearchExcludesTombstonedNotes verifies that a note with deleted_at set is
// excluded from search results, while a live note with the same terms still appears.
func TestSearchExcludesTombstonedNotes(t *testing.T) {
	g := testutil.NewInMemoryTestGraph(t)
	setupSearchNode(t, g, "live-note", "note", "Unique Token xyzzy", "live body", nil)
	setupSearchNode(t, g, "dead-note", "note", "Unique Token xyzzy", "dead body", nil)

	// Tombstone dead-note by setting deleted_at
	err := g.DoWrite(context.Background(), func(wtx *graph.WriteTx) error {
		_, err := wtx.Exec(
			`UPDATE nodes SET deleted_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = 'dead-note'`,
		)
		return err
	})
	if err != nil {
		t.Fatalf("set deleted_at: %v", err)
	}

	var hits []search.Hit
	err = g.DoRead(context.Background(), func(rtx *graph.ReadTx) error {
		var serr error
		hits, serr = search.Search(context.Background(), rtx, "xyzzy")
		return serr
	})
	if err != nil {
		t.Fatalf("Search: %v", err)
	}

	for _, h := range hits {
		if h.NodeID == "dead-note" {
			t.Error("tombstoned note 'dead-note' must not appear in search results")
		}
	}

	found := false
	for _, h := range hits {
		if h.NodeID == "live-note" {
			found = true
		}
	}
	if !found {
		t.Error("live note 'live-note' must appear in search results")
	}
}

// TestSearchExcludesTombstoned_NonNoteUnaffected verifies that non-note nodes
// (which always have NULL deleted_at) still appear in search after the global
// filter is added.
func TestSearchExcludesTombstoned_NonNoteUnaffected(t *testing.T) {
	g := testutil.NewInMemoryTestGraph(t)
	setupSearchNode(t, g, "task-node", "task", "Tombstone Filter Task", "task body", nil)

	var hits []search.Hit
	err := g.DoRead(context.Background(), func(rtx *graph.ReadTx) error {
		var serr error
		hits, serr = search.Search(context.Background(), rtx, "Tombstone")
		return serr
	})
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if len(hits) == 0 {
		t.Error("expected non-note node to still appear in search after tombstone filter")
	}
}

// TestSearchWithPrefixMatchesPartialToken verifies that WithPrefix turns the
// last query token into a prefix match, so "lin" matches "Linktree" - the
// behaviour autocomplete-as-you-type depends on.
func TestSearchWithPrefixMatchesPartialToken(t *testing.T) {
	g := testutil.NewInMemoryTestGraph(t)
	setupSearchNode(t, g, "n1", "note", "Linktree", "a tree of links", nil)

	var hits []search.Hit
	err := g.DoRead(context.Background(), func(rtx *graph.ReadTx) error {
		var serr error
		hits, serr = search.Search(context.Background(), rtx, "lin", search.WithPrefix())
		return serr
	})
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if len(hits) != 1 {
		t.Fatalf("expected 1 prefix hit, got %d", len(hits))
	}
	if hits[0].NodeID != "n1" {
		t.Errorf("expected NodeID n1, got %s", hits[0].NodeID)
	}
}

// TestSearchWithoutPrefixDoesNotMatchPartialToken pins the contrast: without
// WithPrefix, a partial token does not match (proving the prefix path is the
// thing doing the work, not a pre-existing behaviour).
func TestSearchWithoutPrefixDoesNotMatchPartialToken(t *testing.T) {
	g := testutil.NewInMemoryTestGraph(t)
	setupSearchNode(t, g, "n1", "note", "Linktree", "a tree of links", nil)

	var hits []search.Hit
	err := g.DoRead(context.Background(), func(rtx *graph.ReadTx) error {
		var serr error
		hits, serr = search.Search(context.Background(), rtx, "lin")
		return serr
	})
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if len(hits) != 0 {
		t.Fatalf("expected 0 hits without prefix, got %d", len(hits))
	}
}

// searchHits runs Search with the given options and returns the hits, failing
// the test on any error.
func searchHits(t *testing.T, g *graph.Graph, query string, opts ...search.Option) []search.Hit {
	t.Helper()
	var hits []search.Hit
	err := g.DoRead(context.Background(), func(rtx *graph.ReadTx) error {
		var serr error
		hits, serr = search.Search(context.Background(), rtx, query, opts...)
		return serr
	})
	if err != nil {
		t.Fatalf("Search(%q): %v", query, err)
	}
	return hits
}

// TestSearchTitleOnlyExcludesBodyMatch proves the title-only option drops a
// node whose term lives in the body only, in both directions: present without
// the option, absent with it. Only the pair proves the option changed the
// outcome, so the fixture must not carry the term in its title.
func TestSearchTitleOnlyExcludesBodyMatch(t *testing.T) {
	g := testutil.NewInMemoryTestGraph(t)
	setupSearchNode(t, g, "n1", "note", "Unrelated Title", "the resticprofile backup runs nightly", nil)

	if got := searchHits(t, g, "resticprofile"); len(got) != 1 || got[0].NodeID != "n1" {
		t.Fatalf("expected body match without title-only, got %+v", got)
	}
	if got := searchHits(t, g, "resticprofile", search.WithTitleOnly()); len(got) != 0 {
		t.Fatalf("expected no hits with title-only, got %+v", got)
	}
}

// TestSearchTitleOnlyExcludesTagMatch proves the title-only option drops a
// node whose term lives in the tag only. The tag shares the FTS attrs column
// with the body, so without this case the option could qualify nothing and
// still pass the body test by accident.
func TestSearchTitleOnlyExcludesTagMatch(t *testing.T) {
	g := testutil.NewInMemoryTestGraph(t)
	setupSearchNode(t, g, "n1", "note", "Unrelated Title", "unrelated body", []string{"resticprofile"})

	if got := searchHits(t, g, "resticprofile"); len(got) != 1 || got[0].NodeID != "n1" {
		t.Fatalf("expected tag match without title-only, got %+v", got)
	}
	if got := searchHits(t, g, "resticprofile", search.WithTitleOnly()); len(got) != 0 {
		t.Fatalf("expected no hits with title-only, got %+v", got)
	}
}

// TestSearchTitleOnlyMatchesTokenAnywhereInTitle pins the per-token contract:
// the match is over title tokens, not the beginning of the title, so a term
// mid-title still surfaces under the option.
func TestSearchTitleOnlyMatchesTokenAnywhereInTitle(t *testing.T) {
	g := testutil.NewInMemoryTestGraph(t)
	setupSearchNode(t, g, "n1", "note", "Escrever um coletor omarchy-agent-usage para os providers que faltam", "unrelated body", nil)

	got := searchHits(t, g, "omarchy", search.WithTitleOnly())
	if len(got) != 1 || got[0].NodeID != "n1" {
		t.Fatalf("expected title token match, got %+v", got)
	}
}

// The ranked notes search (hou-oc5.18) is tested below. Fixtures go through
// the production write path (nodes.CreateNote plus a note_paths row) so the
// STX/ETX stripping in the chokepoint is exercised, not bypassed.

// setupRankedNote creates a live note with a path through the chokepoint.
func setupRankedNote(t *testing.T, g *graph.Graph, title, body, path, kind string, refs, tags []string) string {
	t.Helper()
	ctx := context.Background()
	var id string
	if err := g.DoWrite(ctx, func(tx *graph.WriteTx) error {
		var err error
		id, err = nodes.CreateNote(ctx, tx, nodes.Note{
			Title: title, Body: body, Kind: kind, Refs: refs, Tags: tags,
		}, nodes.Author{Name: "test"})
		if err != nil {
			return err
		}
		_, err = tx.Exec(`INSERT INTO note_paths(uuid, path) VALUES (?, ?)`, id, path)
		return err
	}); err != nil {
		t.Fatalf("setupRankedNote %q: %v", title, err)
	}
	return id
}

// rankedHits runs RankedSearch and returns the hits, failing on any error.
func rankedHits(t *testing.T, g *graph.Graph, query, tag, folder, kind string) []search.RankedHit {
	t.Helper()
	var hits []search.RankedHit
	err := g.DoRead(context.Background(), func(tx *graph.ReadTx) error {
		var err error
		hits, err = search.RankedSearch(context.Background(), tx, query, tag, folder, kind)
		return err
	})
	if err != nil {
		t.Fatalf("RankedSearch(%q): %v", query, err)
	}
	return hits
}

func rankedIDs(hits []search.RankedHit) []string {
	ids := make([]string, len(hits))
	for i, h := range hits {
		ids[i] = h.NodeID
	}
	return ids
}

// Several words match on their own in any order, and every word is required.
func TestRankedMultiTermAnyOrder(t *testing.T) {
	g := testutil.NewInMemoryTestGraph(t)
	id := setupRankedNote(t, g, "Deploy", "alpha beta gamma", "notes/deploy.md", "nota", nil, nil)

	if got := rankedHits(t, g, "gamma alpha", "", "", ""); len(got) != 1 || got[0].NodeID != id {
		t.Fatalf("reordered terms: got %v, want [%s]", rankedIDs(got), id)
	}
	if got := rankedHits(t, g, "alpha gamma", "", "", ""); len(got) != 1 || got[0].NodeID != id {
		t.Fatalf("forward terms: got %v, want [%s]", rankedIDs(got), id)
	}
	if got := rankedHits(t, g, "alpha missing", "", "", ""); len(got) != 0 {
		t.Fatalf("a term that matches nothing must exclude the note, got %v", rankedIDs(got))
	}
}

// Ranking puts the title match first via the bm25 title weight.
func TestRankedTitleMatchFirst(t *testing.T) {
	g := testutil.NewInMemoryTestGraph(t)
	titleID := setupRankedNote(t, g, "lighthouse keeper", "unrelated words", "notes/a.md", "nota", nil, nil)
	bodyID := setupRankedNote(t, g, "unrelated heading", "lighthouse log", "notes/b.md", "nota", nil, nil)

	got := rankedHits(t, g, "lighthouse", "", "", "")
	if len(got) != 2 {
		t.Fatalf("expected 2 hits, got %v", rankedIDs(got))
	}
	if got[0].NodeID != titleID || got[1].NodeID != bodyID {
		t.Fatalf("title match must rank first, got %v want [%s %s]", rankedIDs(got), titleID, bodyID)
	}
}

// The snippet carries the STX/ETX markers around the matched term.
func TestRankedSnippetMarkers(t *testing.T) {
	g := testutil.NewInMemoryTestGraph(t)
	setupRankedNote(t, g, "Deploy", "rollout the release today", "notes/deploy.md", "nota", nil, nil)

	got := rankedHits(t, g, "rollout", "", "", "")
	if len(got) != 1 {
		t.Fatalf("expected 1 hit, got %v", rankedIDs(got))
	}
	if !strings.Contains(got[0].Snippet, "\x02rollout\x03") {
		t.Errorf("snippet must mark the term, got %q", got[0].Snippet)
	}
}

// The tag filter narrows to the tagged note.
func TestRankedTagFilter(t *testing.T) {
	g := testutil.NewInMemoryTestGraph(t)
	want := setupRankedNote(t, g, "Shared", "common body", "notes/a.md", "nota", nil, []string{"alpha"})
	setupRankedNote(t, g, "Shared", "common body", "notes/b.md", "nota", nil, []string{"beta"})

	got := rankedHits(t, g, "common", "alpha", "", "")
	if len(got) != 1 || got[0].NodeID != want {
		t.Fatalf("tag filter: got %v, want [%s]", rankedIDs(got), want)
	}
}

// The folder filter matches a path prefix with a / boundary: ops matches
// ops/... and the trailing slash changes nothing, never ops-old/....
func TestRankedFolderFilter(t *testing.T) {
	g := testutil.NewInMemoryTestGraph(t)
	want := setupRankedNote(t, g, "Deploy", "common body", "ops/deploy.md", "nota", nil, nil)
	setupRankedNote(t, g, "Deploy", "common body", "ops-old/deploy.md", "nota", nil, nil)

	for _, folder := range []string{"ops", "ops/"} {
		got := rankedHits(t, g, "common", "", folder, "")
		if len(got) != 1 || got[0].NodeID != want {
			t.Fatalf("folder %q: got %v, want [%s]", folder, rankedIDs(got), want)
		}
	}
}

// An underscore in a folder name is literal: 2026_q4 never matches 2026Xq4.
func TestRankedFolderUnderscoreLiteral(t *testing.T) {
	g := testutil.NewInMemoryTestGraph(t)
	want := setupRankedNote(t, g, "Plan", "common body", "2026_q4/plan.md", "nota", nil, nil)
	setupRankedNote(t, g, "Plan", "common body", "2026Xq4/plan.md", "nota", nil, nil)

	got := rankedHits(t, g, "common", "", "2026_q4", "")
	if len(got) != 1 || got[0].NodeID != want {
		t.Fatalf("underscore folder: got %v, want [%s]", rankedIDs(got), want)
	}
}

// The kind filter reads the note's kind; a note stored without one answers nota.
func TestRankedKindFilter(t *testing.T) {
	g := testutil.NewInMemoryTestGraph(t)
	planoID := setupRankedNote(t, g, "Plan", "common body", "notes/plan.md", "plano", nil, nil)
	nokindID := setupRankedNote(t, g, "NoKind", "common body", "notes/nokind.md", "nota", nil, nil)
	// Simulate a note indexed before kind existed: strip kind from attrs.
	if err := g.DoWrite(context.Background(), func(tx *graph.WriteTx) error {
		_, err := tx.Exec(`UPDATE nodes SET attrs = json_remove(attrs, '$.kind') WHERE id = ?`, nokindID)
		return err
	}); err != nil {
		t.Fatalf("strip kind: %v", err)
	}

	if got := rankedHits(t, g, "common", "", "", "plano"); len(got) != 1 || got[0].NodeID != planoID {
		t.Fatalf("kind=plano: got %v, want [%s]", rankedIDs(got), planoID)
	}
	got := rankedHits(t, g, "common", "", "", "nota")
	if len(got) != 1 || got[0].NodeID != nokindID {
		t.Fatalf("kind=nota must find the note without kind, got %v", rankedIDs(got))
	}
}

// An identifier declared only in frontmatter is found, with a body excerpt.
func TestRankedIdentifierRefsOnly(t *testing.T) {
	g := testutil.NewInMemoryTestGraph(t)
	id := setupRankedNote(t, g, "Rollout", "rollout plans for the release", "notes/r.md", "nota", []string{"STRY00000001"}, nil)

	got := rankedHits(t, g, "STRY00000001", "", "", "")
	if len(got) != 1 || got[0].NodeID != id {
		t.Fatalf("refs-only identifier: got %v, want [%s]", rankedIDs(got), id)
	}
	if strings.Contains(got[0].Snippet, "\x02") || strings.Contains(got[0].Snippet, "\x03") {
		t.Errorf("refs-only hit gets an excerpt, not markers, got %q", got[0].Snippet)
	}
	if !strings.HasPrefix("rollout plans for the release", got[0].Snippet) {
		t.Errorf("excerpt must come from the body, got %q", got[0].Snippet)
	}
}

// An identifier in a body only is found exactly.
func TestRankedIdentifierBodyOnly(t *testing.T) {
	g := testutil.NewInMemoryTestGraph(t)
	id := setupRankedNote(t, g, "Fix", "the fix for CHG00000001 lands today", "notes/f.md", "nota", nil, nil)

	got := rankedHits(t, g, "CHG00000001", "", "", "")
	if len(got) != 1 || got[0].NodeID != id {
		t.Fatalf("body-only identifier: got %v, want [%s]", rankedIDs(got), id)
	}
}

// The near miss must not match: hou-4kz never matches a note saying hou 4kz.
func TestRankedIdentifierNearMiss(t *testing.T) {
	g := testutil.NewInMemoryTestGraph(t)
	setupRankedNote(t, g, "Near", "mentions hou 4kz here", "notes/n.md", "nota", nil, nil)

	if got := rankedHits(t, g, "hou-4kz", "", "", ""); len(got) != 0 {
		t.Fatalf("near miss must not match, got %v", rankedIDs(got))
	}
}

// Plain words match without regard to diacritics: implementacao finds implementação.
func TestRankedDiacritics(t *testing.T) {
	g := testutil.NewInMemoryTestGraph(t)
	id := setupRankedNote(t, g, "Nota", "detalhes da implementação", "notes/d.md", "nota", nil, nil)

	got := rankedHits(t, g, "implementacao", "", "", "")
	if len(got) != 1 || got[0].NodeID != id {
		t.Fatalf("diacritics: got %v, want [%s]", rankedIDs(got), id)
	}
}

// An injected OR and a title: prefix are treated as words, never operators.
func TestRankedInjectionTreatedAsWords(t *testing.T) {
	g := testutil.NewInMemoryTestGraph(t)
	setupRankedNote(t, g, "Choice", "choose OR perish", "notes/c.md", "nota", nil, nil)
	setupRankedNote(t, g, "Prefixed", "title:foo is here", "notes/p.md", "nota", nil, nil)

	if got := rankedHits(t, g, "OR", "", "", ""); len(got) != 1 {
		t.Fatalf("OR as a word must match once without error, got %v", rankedIDs(got))
	}
	if got := rankedHits(t, g, "title:foo", "", "", ""); len(got) != 1 {
		t.Fatalf("title: as a word must match once without error, got %v", rankedIDs(got))
	}
}

// Queries with no FTS token at all answer without error: ---, phase 3 -
// notes, and a NUL-holding query.
func TestRankedNoFTSTokenAnswersWithoutError(t *testing.T) {
	g := testutil.NewInMemoryTestGraph(t)
	setupRankedNote(t, g, "Phase", "phase 3 notes on rollout", "notes/p.md", "nota", nil, nil)

	if got := rankedHits(t, g, "---", "", "", ""); len(got) != 0 {
		t.Fatalf("--- must answer empty without error, got %v", rankedIDs(got))
	}
	// The lone - is refs-only; nothing cites it, so the answer is empty, not an error.
	_ = rankedHits(t, g, "phase 3 - notes", "", "", "")
	// A NUL is removed before tokenising: a<NUL>b searches ab.
	ab := setupRankedNote(t, g, "AB", "ab content", "notes/ab.md", "nota", nil, nil)
	got := rankedHits(t, g, "a\x00b", "", "", "")
	if len(got) != 1 || got[0].NodeID != ab {
		t.Fatalf("NUL query: got %v, want [%s]", rankedIDs(got), ab)
	}
	// A NUL-only query answers empty, never 500.
	if got := rankedHits(t, g, "\x00", "", "", ""); len(got) != 0 {
		t.Fatalf("NUL-only must answer empty, got %v", rankedIDs(got))
	}
}

// One token only in refs and one only in the body: the note is found and the
// snippet marks the body token.
func TestRankedRefsPlusBodyToken(t *testing.T) {
	g := testutil.NewInMemoryTestGraph(t)
	id := setupRankedNote(t, g, "Story", "rollout begins", "notes/s.md", "nota", []string{"STRY00000001"}, nil)

	got := rankedHits(t, g, "STRY00000001 rollout", "", "", "")
	if len(got) != 1 || got[0].NodeID != id {
		t.Fatalf("refs+body: got %v, want [%s]", rankedIDs(got), id)
	}
	if !strings.Contains(got[0].Snippet, "\x02rollout\x03") {
		t.Errorf("snippet must mark the body token, got %q", got[0].Snippet)
	}
}

// A body holding STX keeps it out of the snippet: on create, after an
// update, and after the note is deleted and revived.
func TestRankedSTXStrippedThroughLifecycle(t *testing.T) {
	g := testutil.NewInMemoryTestGraph(t)
	ctx := context.Background()
	id := setupRankedNote(t, g, "Marks", "alpha\x02beta gamma", "notes/m.md", "nota", nil, nil)

	checkClean := func(stage string) {
		t.Helper()
		got := rankedHits(t, g, "alphabeta", "", "", "")
		if len(got) != 1 || got[0].NodeID != id {
			t.Fatalf("%s: got %v, want [%s]", stage, rankedIDs(got), id)
		}
		if strings.Count(got[0].Snippet, "\x02") != 1 || strings.Count(got[0].Snippet, "\x03") != 1 {
			t.Errorf("%s: snippet must hold exactly the match markers, got %q", stage, got[0].Snippet)
		}
	}
	checkClean("create")

	if err := g.DoWrite(ctx, func(tx *graph.WriteTx) error {
		n, err := nodes.GetNote(ctx, tx.AsReadTx(), id)
		if err != nil {
			return err
		}
		n.Body = "deltaepsilon gamma"
		return nodes.UpdateNote(ctx, tx, *n, nodes.Author{Name: "test"})
	}); err != nil {
		t.Fatalf("update: %v", err)
	}
	got := rankedHits(t, g, "deltaepsilon", "", "", "")
	if len(got) != 1 || got[0].NodeID != id {
		t.Fatalf("update: got %v, want [%s]", rankedIDs(got), id)
	}
	if strings.Count(got[0].Snippet, "\x02") != 1 || strings.Count(got[0].Snippet, "\x03") != 1 {
		t.Errorf("update: snippet must hold exactly the match markers, got %q", got[0].Snippet)
	}

	if err := g.DoWrite(ctx, func(tx *graph.WriteTx) error {
		return nodes.SoftDeleteNoteTx(ctx, tx, id, "m", "Marks", nodes.Author{Name: "test"})
	}); err != nil {
		t.Fatalf("soft delete: %v", err)
	}
	if err := g.DoWrite(ctx, func(tx *graph.WriteTx) error {
		return nodes.ReviveNoteTx(ctx, tx, id, "m", "Marks", nodes.Author{Name: "test"})
	}); err != nil {
		t.Fatalf("revive: %v", err)
	}
	got = rankedHits(t, g, "deltaepsilon", "", "", "")
	if len(got) != 1 || got[0].NodeID != id {
		t.Fatalf("revive: got %v, want [%s]", rankedIDs(got), id)
	}
	if strings.Count(got[0].Snippet, "\x02") != 1 || strings.Count(got[0].Snippet, "\x03") != 1 {
		t.Errorf("revive: snippet must hold exactly the match markers, got %q", got[0].Snippet)
	}
}

// A task node written through the copied nodes package is never returned.
func TestRankedExcludesTaskNodes(t *testing.T) {
	g := testutil.NewInMemoryTestGraph(t)
	ctx := context.Background()
	if err := g.DoWrite(ctx, func(tx *graph.WriteTx) error {
		_, err := nodes.CreateTask(ctx, tx, nodes.Task{Title: "Task", Description: "uniquesearchterm task body"}, nodes.Author{Name: "test"})
		return err
	}); err != nil {
		t.Fatalf("create task: %v", err)
	}
	noteID := setupRankedNote(t, g, "Note", "uniquesearchterm note body", "notes/n.md", "nota", nil, nil)

	got := rankedHits(t, g, "uniquesearchterm", "", "", "")
	if len(got) != 1 || got[0].NodeID != noteID {
		t.Fatalf("task must never be returned, got %v want [%s]", rankedIDs(got), noteID)
	}
}

// The new query keeps the pinned index plan: the nodes lookup resolves each
// hit through idx_nodes_fts_rowid.
func TestRankedUsesFTSRowidIndex(t *testing.T) {
	g := testutil.NewInMemoryTestGraph(t)

	sqlStr, args := search.BuildRankedQuery(`"vault"`, "", "", "")
	var plan []string
	err := g.DoRead(context.Background(), func(tx *graph.ReadTx) error {
		rows, err := tx.Query("EXPLAIN QUERY PLAN "+sqlStr, args...)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var id, parent, notused int
			var detail string
			if err := rows.Scan(&id, &parent, &notused, &detail); err != nil {
				return err
			}
			plan = append(plan, detail)
		}
		return rows.Err()
	})
	if err != nil {
		t.Fatalf("EXPLAIN QUERY PLAN: %v", err)
	}

	for _, step := range plan {
		if strings.HasPrefix(step, "SEARCH n ") && strings.Contains(step, "USING INDEX idx_nodes_fts_rowid (fts_rowid=?)") {
			return
		}
	}
	t.Fatalf("the ranked nodes lookup does not use idx_nodes_fts_rowid; plan:\n%s", strings.Join(plan, "\n"))
}
