package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gabrielassisxyz/houston/notes/internal/graph"
	"github.com/gabrielassisxyz/houston/notes/internal/graph/nodes"
	"github.com/gabrielassisxyz/houston/notes/internal/vault/reconcile"
)

// houOc518SeedNote creates a note with an exact body through the production
// write path and indexes it at path.
func houOc518SeedNote(t *testing.T, g *graph.Graph, title, body, path, kind string, refs, tags []string) string {
	t.Helper()
	ctx := context.Background()
	var id string
	if err := g.DoWrite(ctx, func(tx *graph.WriteTx) error {
		var err error
		id, err = nodes.CreateNote(ctx, tx, nodes.Note{
			Title: title, Body: body, Kind: kind, Refs: refs, Tags: tags,
		}, testAuthor)
		return err
	}); err != nil {
		t.Fatalf("seed note %q: %v", title, err)
	}
	if err := reconcile.Upsert(ctx, g, id, path, "hash-"+id); err != nil {
		t.Fatalf("index note %q: %v", path, err)
	}
	return id
}

func houOc518Get(t *testing.T, d Deps, query string) (int, notesSearchResponse) {
	t.Helper()
	rec := httptest.NewRecorder()
	newTestRouter(t, d).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/search"+query, nil))
	var out notesSearchResponse
	if rec.Code == http.StatusOK {
		if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
			t.Fatalf("decode search %q: %v: %s", query, err, rec.Body.String())
		}
	}
	return rec.Code, out
}

func houOc518IDs(out notesSearchResponse) []string {
	ids := make([]string, len(out.Hits))
	for i, h := range out.Hits {
		ids[i] = h.ID
	}
	return ids
}

// The route answers the pinned shape over live notes only.
// A limit above the cap is answered at the cap, not refused and not obeyed: the
// envelope says which limit produced the page.
func TestHouOc518SearchLimitCappedAt100(t *testing.T) {
	d := newTestDeps(t, "")
	houOc518SeedNote(t, d.Graph, "Rollout", "rollout plans", "notes/r.md", "plano", []string{}, []string{})
	code, out := houOc518Get(t, d, "?q=rollout&limit=500")
	if code != http.StatusOK {
		t.Fatalf("GET search with limit=500 = %d, want 200", code)
	}
	if out.Limit != 100 {
		t.Fatalf("limit = %d, want the cap of 100", out.Limit)
	}
}

func TestHouOc518SearchShape(t *testing.T) {
	d := newTestDeps(t, "")
	id := houOc518SeedNote(t, d.Graph, "Rollout", "rollout plans", "notes/r.md", "plano", []string{"STRY00000001"}, []string{"b", "a"})
	code, out := houOc518Get(t, d, "?q=rollout")
	if code != http.StatusOK {
		t.Fatalf("GET search = %d", code)
	}
	if out.Total != 1 || out.Limit != 20 || out.Offset != 0 {
		t.Fatalf("envelope = %+v, want total 1 limit 20 offset 0", out)
	}
	if len(out.Hits) != 1 {
		t.Fatalf("hits = %v", houOc518IDs(out))
	}
	h := out.Hits[0]
	if h.ID != id || h.Title != "Rollout" || h.Path != "notes/r.md" || h.Kind != "plano" {
		t.Errorf("hit identity = %+v", h)
	}
	if len(h.Tags) != 2 || h.Tags[0] != "a" || h.Tags[1] != "b" {
		t.Errorf("tags = %v, want sorted [a b]", h.Tags)
	}
	if !strings.Contains(strings.ToLower(h.Snippet), "rollout") {
		t.Errorf("snippet must mention the term, got %q", h.Snippet)
	}
}

// Several words match on their own in any order; every word is required.
func TestHouOc518SearchMultiTermAnyOrder(t *testing.T) {
	d := newTestDeps(t, "")
	id := houOc518SeedNote(t, d.Graph, "Deploy", "alpha beta gamma", "notes/d.md", "nota", nil, nil)

	for _, q := range []string{"?q=gamma+alpha", "?q=alpha+gamma"} {
		code, out := houOc518Get(t, d, q)
		if code != http.StatusOK {
			t.Fatalf("%s = %d", q, code)
		}
		if len(out.Hits) != 1 || out.Hits[0].ID != id || out.Total != 1 {
			t.Fatalf("%s: got %v total %d, want [%s]", q, houOc518IDs(out), out.Total, id)
		}
	}

	code, out := houOc518Get(t, d, "?q=alpha+missing")
	if code != http.StatusOK {
		t.Fatalf("unmatched term = %d", code)
	}
	if len(out.Hits) != 0 || out.Total != 0 {
		t.Fatalf("unmatched term must exclude the note, got %v", houOc518IDs(out))
	}
}

// Ranking puts the title match first.
func TestHouOc518SearchRankingTitleFirst(t *testing.T) {
	d := newTestDeps(t, "")
	titleID := houOc518SeedNote(t, d.Graph, "lighthouse keeper", "unrelated words", "notes/a.md", "nota", nil, nil)
	bodyID := houOc518SeedNote(t, d.Graph, "unrelated heading", "lighthouse log", "notes/b.md", "nota", nil, nil)

	code, out := houOc518Get(t, d, "?q=lighthouse")
	if code != http.StatusOK {
		t.Fatalf("GET search = %d", code)
	}
	if len(out.Hits) != 2 || out.Hits[0].ID != titleID || out.Hits[1].ID != bodyID {
		t.Fatalf("title match must rank first, got %v", houOc518IDs(out))
	}
}

// The snippet carries the match markers around the term.
func TestHouOc518SearchSnippetMarkers(t *testing.T) {
	d := newTestDeps(t, "")
	houOc518SeedNote(t, d.Graph, "Deploy", "rollout the release today", "notes/d.md", "nota", nil, nil)

	code, out := houOc518Get(t, d, "?q=rollout")
	if code != http.StatusOK {
		t.Fatalf("GET search = %d", code)
	}
	if len(out.Hits) != 1 || !strings.Contains(out.Hits[0].Snippet, "rollout") {
		t.Fatalf("snippet must mark the term, got %+v", out.Hits)
	}
}

// Each filter narrows: tag, folder and kind.
func TestHouOc518SearchFilters(t *testing.T) {
	d := newTestDeps(t, "")
	want := houOc518SeedNote(t, d.Graph, "Shared", "common body", "ops/a.md", "plano", nil, []string{"alpha"})
	houOc518SeedNote(t, d.Graph, "Shared", "common body", "ops/b.md", "evidencia", nil, []string{"beta"})

	code, out := houOc518Get(t, d, "?q=common&tag=alpha")
	if code != http.StatusOK || len(out.Hits) != 1 || out.Hits[0].ID != want {
		t.Fatalf("tag filter: %d %v", code, houOc518IDs(out))
	}
	code, out = houOc518Get(t, d, "?q=common&kind=plano")
	if code != http.StatusOK || len(out.Hits) != 1 || out.Hits[0].ID != want {
		t.Fatalf("kind filter: %d %v", code, houOc518IDs(out))
	}
	code, out = houOc518Get(t, d, "?q=common&tag=alpha&folder=ops&kind=plano")
	if code != http.StatusOK || len(out.Hits) != 1 || out.Hits[0].ID != want {
		t.Fatalf("combined filters: %d %v", code, houOc518IDs(out))
	}
}

// The folder is a path prefix with a / boundary: ops and ops/ match
// ops/..., never ops-old/.
func TestHouOc518SearchFolderSibling(t *testing.T) {
	d := newTestDeps(t, "")
	want := houOc518SeedNote(t, d.Graph, "Deploy", "common body", "ops/deploy.md", "nota", nil, nil)
	houOc518SeedNote(t, d.Graph, "Deploy", "common body", "ops-old/deploy.md", "nota", nil, nil)

	for _, folder := range []string{"ops", "ops/"} {
		code, out := houOc518Get(t, d, "?q=common&folder="+folder)
		if code != http.StatusOK {
			t.Fatalf("folder %q = %d", folder, code)
		}
		if len(out.Hits) != 1 || out.Hits[0].ID != want {
			t.Fatalf("folder %q: got %v, want [%s]", folder, houOc518IDs(out), want)
		}
	}
}

// An underscore in a folder name is literal.
func TestHouOc518SearchFolderUnderscore(t *testing.T) {
	d := newTestDeps(t, "")
	want := houOc518SeedNote(t, d.Graph, "Plan", "common body", "2026_q4/plan.md", "nota", nil, nil)
	houOc518SeedNote(t, d.Graph, "Plan", "common body", "2026Xq4/plan.md", "nota", nil, nil)

	code, out := houOc518Get(t, d, "?q=common&folder=2026_q4")
	if code != http.StatusOK {
		t.Fatalf("GET search = %d", code)
	}
	if len(out.Hits) != 1 || out.Hits[0].ID != want {
		t.Fatalf("underscore folder: got %v, want [%s]", houOc518IDs(out), want)
	}
}

// A note stored without kind is found by kind=nota.
func TestHouOc518SearchKindNotaMissing(t *testing.T) {
	d := newTestDeps(t, "")
	ctx := context.Background()
	var id string
	if err := d.Graph.DoWrite(ctx, func(tx *graph.WriteTx) error {
		var err error
		id, err = nodes.CreateNote(ctx, tx, nodes.Note{Title: "NoKind", Body: "common body"}, testAuthor)
		return err
	}); err != nil {
		t.Fatalf("create: %v", err)
	}
	if err := d.Graph.DoWrite(ctx, func(tx *graph.WriteTx) error {
		_, err := tx.Exec(`UPDATE nodes SET attrs = json_remove(attrs, '$.kind') WHERE id = ?`, id)
		return err
	}); err != nil {
		t.Fatalf("strip kind: %v", err)
	}
	if err := reconcile.Upsert(ctx, d.Graph, id, "notes/nokind.md", "hash-"+id); err != nil {
		t.Fatalf("upsert: %v", err)
	}

	code, out := houOc518Get(t, d, "?q=common&kind=nota")
	if code != http.StatusOK {
		t.Fatalf("GET search = %d", code)
	}
	if len(out.Hits) != 1 || out.Hits[0].ID != id {
		t.Fatalf("kind=nota must find the note without kind, got %v", houOc518IDs(out))
	}
	if out.Hits[0].Kind != "nota" {
		t.Errorf("kind = %q, want nota", out.Hits[0].Kind)
	}
}

// total counts before paging; limit pages and offset skips.
func TestHouOc518SearchPagingTotal(t *testing.T) {
	d := newTestDeps(t, "")
	for i, p := range []string{"notes/a.md", "notes/b.md", "notes/c.md"} {
		houOc518SeedNote(t, d.Graph, "Paging", "paging body", p, "nota", nil, nil)
		_ = i
	}

	code, out := houOc518Get(t, d, "?q=paging&limit=2")
	if code != http.StatusOK {
		t.Fatalf("GET search = %d", code)
	}
	if len(out.Hits) != 2 || out.Total != 3 || out.Limit != 2 || out.Offset != 0 {
		t.Fatalf("page one must be full with exact total, got %+v", out)
	}
	code, out = houOc518Get(t, d, "?q=paging&limit=2&offset=2")
	if code != http.StatusOK {
		t.Fatalf("GET search = %d", code)
	}
	if len(out.Hits) != 1 || out.Total != 3 || out.Offset != 2 {
		t.Fatalf("page two carries the rest, got %+v", out)
	}
}

// When identifier tokens filter out FTS rows, every page stays full and total
// stays exact: the SQL carries no LIMIT/OFFSET for the merge.
func TestHouOc518SearchPagingWithIdentifierFilter(t *testing.T) {
	d := newTestDeps(t, "")
	for _, p := range []string{"notes/a.md", "notes/b.md", "notes/c.md"} {
		houOc518SeedNote(t, d.Graph, "Release", "release hou-4kz", p, "nota", nil, nil)
	}
	// Matches the FTS phrase but fails the exact substring check.
	houOc518SeedNote(t, d.Graph, "Near", "release hou 4kz", "notes/near.md", "nota", nil, nil)

	code, out := houOc518Get(t, d, "?q=release+hou-4kz&limit=2")
	if code != http.StatusOK {
		t.Fatalf("GET search = %d", code)
	}
	if len(out.Hits) != 2 || out.Total != 3 {
		t.Fatalf("page one must be full with exact total, got %d hits total %d", len(out.Hits), out.Total)
	}
	code, out = houOc518Get(t, d, "?q=release+hou-4kz&limit=2&offset=2")
	if code != http.StatusOK {
		t.Fatalf("GET search = %d", code)
	}
	if len(out.Hits) != 1 || out.Total != 3 {
		t.Fatalf("page two carries the rest, got %d hits total %d", len(out.Hits), out.Total)
	}
}

// An identifier declared only in frontmatter is found, with a body excerpt.
func TestHouOc518SearchIdentifierRefsOnly(t *testing.T) {
	d := newTestDeps(t, "")
	id := houOc518SeedNote(t, d.Graph, "Rollout", "rollout plans for the release", "notes/r.md", "nota", []string{"STRY00000001"}, nil)

	code, out := houOc518Get(t, d, "?q=STRY00000001")
	if code != http.StatusOK {
		t.Fatalf("GET search = %d", code)
	}
	if len(out.Hits) != 1 || out.Hits[0].ID != id {
		t.Fatalf("refs-only identifier: got %v", houOc518IDs(out))
	}
}

// An identifier in a body only is found exactly.
func TestHouOc518SearchIdentifierBodyOnly(t *testing.T) {
	d := newTestDeps(t, "")
	id := houOc518SeedNote(t, d.Graph, "Fix", "the fix for INC00000001 lands today", "notes/f.md", "nota", nil, nil)

	code, out := houOc518Get(t, d, "?q=INC00000001")
	if code != http.StatusOK {
		t.Fatalf("GET search = %d", code)
	}
	if len(out.Hits) != 1 || out.Hits[0].ID != id {
		t.Fatalf("body-only identifier: got %v", houOc518IDs(out))
	}
}

// The near miss must not match.
func TestHouOc518SearchNearMiss(t *testing.T) {
	d := newTestDeps(t, "")
	houOc518SeedNote(t, d.Graph, "Near", "mentions hou 4kz here", "notes/n.md", "nota", nil, nil)

	code, out := houOc518Get(t, d, "?q=hou-4kz")
	if code != http.StatusOK {
		t.Fatalf("GET search = %d", code)
	}
	if len(out.Hits) != 0 || out.Total != 0 {
		t.Fatalf("near miss must not match, got %v", houOc518IDs(out))
	}
}

// implementacao finds implementação.
func TestHouOc518SearchDiacritics(t *testing.T) {
	d := newTestDeps(t, "")
	id := houOc518SeedNote(t, d.Graph, "Nota", "detalhes da implementação", "notes/d.md", "nota", nil, nil)

	code, out := houOc518Get(t, d, "?q=implementacao")
	if code != http.StatusOK {
		t.Fatalf("GET search = %d", code)
	}
	if len(out.Hits) != 1 || out.Hits[0].ID != id {
		t.Fatalf("diacritics: got %v", houOc518IDs(out))
	}
}

// An injected OR and a title: prefix are treated as words.
func TestHouOc518SearchInjectionWords(t *testing.T) {
	d := newTestDeps(t, "")
	houOc518SeedNote(t, d.Graph, "Choice", "choose OR perish", "notes/c.md", "nota", nil, nil)
	houOc518SeedNote(t, d.Graph, "Prefixed", "title:foo is here", "notes/p.md", "nota", nil, nil)

	code, out := houOc518Get(t, d, "?q=OR")
	if code != http.StatusOK || len(out.Hits) != 1 {
		t.Fatalf("OR as a word: %d %v", code, houOc518IDs(out))
	}
	code, out = houOc518Get(t, d, "?q=title%3Afoo")
	if code != http.StatusOK || len(out.Hits) != 1 {
		t.Fatalf("title: as a word: %d %v", code, houOc518IDs(out))
	}
}

// ---, phase 3 - notes and a NUL-holding query answer without error.
func TestHouOc518SearchNoFTSToken(t *testing.T) {
	d := newTestDeps(t, "")
	houOc518SeedNote(t, d.Graph, "Phase", "phase 3 notes on rollout", "notes/p.md", "nota", nil, nil)
	houOc518SeedNote(t, d.Graph, "AB", "ab content", "notes/ab.md", "nota", nil, nil)

	for _, q := range []string{"?q=---", "?q=phase+3+-+notes", "?q=%00", "?q=a%00b"} {
		rec := httptest.NewRecorder()
		newTestRouter(t, d).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/search"+q, nil))
		if rec.Code != http.StatusOK {
			t.Errorf("%s = %d, want 200 without error", q, rec.Code)
		}
	}
	code, out := houOc518Get(t, d, "?q=a%00b")
	if code != http.StatusOK || len(out.Hits) != 1 {
		t.Fatalf("NUL-joined query must find ab, got %d %v", code, houOc518IDs(out))
	}
}

// One token only in refs and one only in the body: found, with the snippet
// of the body token.
func TestHouOc518SearchRefsPlusBody(t *testing.T) {
	d := newTestDeps(t, "")
	id := houOc518SeedNote(t, d.Graph, "Story", "rollout begins", "notes/s.md", "nota", []string{"STRY00000001"}, nil)

	code, out := houOc518Get(t, d, "?q=STRY00000001+rollout")
	if code != http.StatusOK {
		t.Fatalf("GET search = %d", code)
	}
	if len(out.Hits) != 1 || out.Hits[0].ID != id {
		t.Fatalf("refs+body: got %v", houOc518IDs(out))
	}
	if !strings.Contains(out.Hits[0].Snippet, "rollout") {
		t.Errorf("snippet must mark the body token, got %q", out.Hits[0].Snippet)
	}
}

// A body holding STX keeps it out of the snippet.
func TestHouOc518SearchSTXStripped(t *testing.T) {
	d := newTestDeps(t, "")
	houOc518SeedNote(t, d.Graph, "Marks", "alpha\x02beta gamma", "notes/m.md", "nota", nil, nil)

	code, out := houOc518Get(t, d, "?q=alphabeta")
	if code != http.StatusOK {
		t.Fatalf("GET search = %d", code)
	}
	if len(out.Hits) != 1 {
		t.Fatalf("stripped body must match, got %v", houOc518IDs(out))
	}
	if strings.Count(out.Hits[0].Snippet, "\x02") != 1 || strings.Count(out.Hits[0].Snippet, "\x03") != 1 {
		t.Errorf("snippet must hold exactly the match markers, got %q", out.Hits[0].Snippet)
	}
}

// A task node is never returned.
func TestHouOc518SearchExcludesTasks(t *testing.T) {
	d := newTestDeps(t, "")
	ctx := context.Background()
	if err := d.Graph.DoWrite(ctx, func(tx *graph.WriteTx) error {
		_, err := nodes.CreateTask(ctx, tx, nodes.Task{Title: "Task", Description: "uniquesearchterm task body"}, testAuthor)
		return err
	}); err != nil {
		t.Fatalf("create task: %v", err)
	}
	noteID := houOc518SeedNote(t, d.Graph, "Note", "uniquesearchterm note body", "notes/n.md", "nota", nil, nil)

	code, out := houOc518Get(t, d, "?q=uniquesearchterm")
	if code != http.StatusOK {
		t.Fatalf("GET search = %d", code)
	}
	if len(out.Hits) != 1 || out.Hits[0].ID != noteID {
		t.Fatalf("task must never be returned, got %v", houOc518IDs(out))
	}
}

// Every 400 of the Specification: empty q, limit=0, offset=-1, limit=x and
// kind=bogus.
func TestHouOc518SearchEach400(t *testing.T) {
	d := newTestDeps(t, "")
	for _, q := range []string{"", "?q=", "?q=%20", "?q=x&limit=0", "?q=x&offset=-1", "?q=x&limit=x", "?q=x&kind=bogus", "?q=x&limit=1.5", "?q=x&offset=1.5"} {
		rec := httptest.NewRecorder()
		newTestRouter(t, d).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/search"+q, nil))
		if rec.Code != http.StatusBadRequest {
			t.Errorf("query %q = %d, want 400", q, rec.Code)
		}
	}
}

// An empty answer carries [] lists, never null.
func TestHouOc518SearchEmptyListsAsEmpty(t *testing.T) {
	d := newTestDeps(t, "")
	rec := httptest.NewRecorder()
	newTestRouter(t, d).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/search?q=nomatchhere", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET search = %d", rec.Code)
	}
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(rec.Body.Bytes(), &raw); err != nil {
		t.Fatal(err)
	}
	if string(raw["hits"]) != "[]" {
		t.Errorf("hits = %s, want []", string(raw["hits"]))
	}
}
