package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"testing"

	"github.com/gabrielassisxyz/houston/notes/internal/graph"
	"github.com/gabrielassisxyz/houston/notes/internal/graph/edges"
	"github.com/gabrielassisxyz/houston/notes/internal/graph/nodes"
	"github.com/gabrielassisxyz/houston/notes/internal/vault/reconcile"
)

func houOc517SeedNote(t *testing.T, g *graph.Graph, title, path, kind string, refs, tags []string) string {
	t.Helper()
	ctx := context.Background()
	var id string
	if err := g.DoWrite(ctx, func(tx *graph.WriteTx) error {
		var err error
		id, err = nodes.CreateNote(ctx, tx, nodes.Note{
			Title: title,
			Body:  "body of " + title,
			Kind:  kind,
			Refs:  refs,
			Tags:  tags,
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

func houOc517SeedEdge(t *testing.T, g *graph.Graph, src, dst, label string) {
	t.Helper()
	ctx := context.Background()
	if err := g.DoWrite(ctx, func(tx *graph.WriteTx) error {
		_, err := edges.Create(ctx, tx, edges.Edge{Src: src, Dst: dst, Label: label}, testAuthor)
		return err
	}); err != nil {
		t.Fatalf("seed edge %s->%s: %v", src, dst, err)
	}
}

func houOc517GetRefs(t *testing.T, d Deps, query string) (int, []byte) {
	t.Helper()
	rec := httptest.NewRecorder()
	newTestRouter(t, d).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/notes/refs"+query, nil))
	return rec.Code, rec.Body.Bytes()
}

func houOc517DecodeRefs(t *testing.T, body []byte) notesRefsResponse {
	t.Helper()
	var out notesRefsResponse
	dec := json.NewDecoder(strings.NewReader(string(body)))
	dec.UseNumber()
	if err := dec.Decode(&out); err != nil {
		t.Fatalf("decode refs: %v: %s", err, string(body))
	}
	return out
}

func TestHouOc517RefsMatchingWithoutRegardToCase(t *testing.T) {
	d := newTestDeps(t, "")
	houOc517SeedNote(t, d.Graph, "Epic notes", "notes/epic.md", "plano", []string{"hou-4kz"}, []string{"b", "a"})
	code, body := houOc517GetRefs(t, d, "?ids=HOU-4KZ")
	if code != http.StatusOK {
		t.Fatalf("GET refs = %d, body %s", code, string(body))
	}
	out := houOc517DecodeRefs(t, body)
	if len(out.Notes) != 1 {
		t.Fatalf("notes = %d, want 1: %s", len(out.Notes), string(body))
	}
	if out.Notes[0].Kind != "plano" {
		t.Errorf("kind = %q, want plano", out.Notes[0].Kind)
	}
	if len(out.Notes[0].MatchedRefs) != 1 {
		t.Fatalf("matchedRefs = %v, want 1", out.Notes[0].MatchedRefs)
	}
	if len(out.Notes[0].Tags) != 2 || out.Notes[0].Tags[0] != "a" || out.Notes[0].Tags[1] != "b" {
		t.Errorf("tags = %v, want sorted [a b]", out.Notes[0].Tags)
	}
}

func TestHouOc517RefsIDsDedupedCaseInsensitive(t *testing.T) {
	d := newTestDeps(t, "")
	houOc517SeedNote(t, d.Graph, "N", "notes/n.md", "nota", []string{"hou-4kz"}, nil)
	code, body := houOc517GetRefs(t, d, "?ids=hou-4kz,HOU-4KZ")
	if code != http.StatusOK {
		t.Fatalf("deduped ids should succeed, got %d: %s", code, string(body))
	}
	out := houOc517DecodeRefs(t, body)
	if len(out.Notes) != 1 {
		t.Fatalf("notes = %d, want 1", len(out.Notes))
	}
}

func TestHouOc517RefsKindFilterAppliesToNotesNotLinked(t *testing.T) {
	d := newTestDeps(t, "")
	direct := houOc517SeedNote(t, d.Graph, "Direct", "notes/direct.md", "plano", []string{"hou-1"}, nil)
	linkedID := houOc517SeedNote(t, d.Graph, "Linked", "notes/linked.md", "evidencia", nil, nil)
	houOc517SeedEdge(t, d.Graph, direct, linkedID, "links_to")

	code, body := houOc517GetRefs(t, d, "?ids=hou-1&kind=evidencia&hop=1")
	if code != http.StatusOK {
		t.Fatalf("GET refs = %d: %s", code, string(body))
	}
	out := houOc517DecodeRefs(t, body)
	if len(out.Notes) != 0 {
		t.Fatalf("kind filter should exclude plano direct from evidencia notes, got %d", len(out.Notes))
	}

	code, body = houOc517GetRefs(t, d, "?ids=hou-1&kind=plano&hop=1")
	if code != http.StatusOK {
		t.Fatalf("GET refs = %d: %s", code, string(body))
	}
	out = houOc517DecodeRefs(t, body)
	if len(out.Notes) != 1 {
		t.Fatalf("notes = %d, want 1", len(out.Notes))
	}
	if len(out.Linked) != 1 || out.Linked[0].ID != linkedID {
		t.Fatalf("linked should hold evidencia neighbour despite kind=plano, got %+v", out.Linked)
	}
	if out.Linked[0].Kind != "evidencia" {
		t.Errorf("linked kind = %q, want evidencia", out.Linked[0].Kind)
	}
}

func TestHouOc517RefsHopAndEdgeLabel(t *testing.T) {
	d := newTestDeps(t, "")
	direct := houOc517SeedNote(t, d.Graph, "Direct", "notes/direct.md", "nota", []string{"hou-2"}, nil)
	viaLinks := houOc517SeedNote(t, d.Graph, "ViaLinks", "notes/via-links.md", "nota", nil, nil)
	viaDescribes := houOc517SeedNote(t, d.Graph, "ViaDescribes", "notes/via-describes.md", "nota", nil, nil)
	houOc517SeedEdge(t, d.Graph, direct, viaLinks, "links_to")
	houOc517SeedEdge(t, d.Graph, direct, viaDescribes, "describes")

	// hop=0 (default) returns no linked.
	code, body := houOc517GetRefs(t, d, "?ids=hou-2")
	if code != http.StatusOK {
		t.Fatalf("GET refs = %d: %s", code, string(body))
	}
	out := houOc517DecodeRefs(t, body)
	if len(out.Linked) != 0 || out.LinkedOmitted != 0 {
		t.Fatalf("hop=0 should have no linked, got %+v", out)
	}

	code, body = houOc517GetRefs(t, d, "?ids=hou-2&hop=1")
	if code != http.StatusOK {
		t.Fatalf("GET refs hop=1 = %d: %s", code, string(body))
	}
	out = houOc517DecodeRefs(t, body)
	if len(out.Linked) != 1 || out.Linked[0].ID != viaLinks {
		t.Fatalf("linked should hold only links_to neighbour, got %+v", out.Linked)
	}
}

func TestHouOc517RefsNeighbourListedOnce(t *testing.T) {
	d := newTestDeps(t, "")
	a := houOc517SeedNote(t, d.Graph, "A", "notes/a.md", "nota", []string{"hou-3"}, nil)
	b := houOc517SeedNote(t, d.Graph, "B", "notes/b.md", "nota", []string{"hou-3"}, nil)
	shared := houOc517SeedNote(t, d.Graph, "Shared", "notes/shared.md", "nota", nil, nil)
	houOc517SeedEdge(t, d.Graph, a, shared, "links_to")
	houOc517SeedEdge(t, d.Graph, b, shared, "links_to")

	code, body := houOc517GetRefs(t, d, "?ids=hou-3&hop=1")
	if code != http.StatusOK {
		t.Fatalf("GET refs = %d: %s", code, string(body))
	}
	out := houOc517DecodeRefs(t, body)
	if len(out.Notes) != 2 {
		t.Fatalf("notes = %d, want 2", len(out.Notes))
	}
	if len(out.Linked) != 1 || out.Linked[0].ID != shared {
		t.Fatalf("shared neighbour must appear once, got %+v", out.Linked)
	}
	// Reverse direction also links.
	houOc517SeedEdge(t, d.Graph, shared, a, "links_to")
	code, body = houOc517GetRefs(t, d, "?ids=hou-3&hop=1")
	if code != http.StatusOK {
		t.Fatalf("GET refs = %d", code)
	}
	out = houOc517DecodeRefs(t, body)
	if len(out.Linked) != 1 {
		t.Fatalf("reverse edge must not duplicate, got %+v", out.Linked)
	}
}

func TestHouOc517RefsCapAndCount(t *testing.T) {
	d := newTestDeps(t, "")
	direct := houOc517SeedNote(t, d.Graph, "Direct", "notes/direct.md", "nota", []string{"hou-cap"}, nil)
	for i := 0; i < 25; i++ {
		path := "notes/n-" + pad2(i) + ".md"
		id := houOc517SeedNote(t, d.Graph, "N", path, "nota", nil, nil)
		houOc517SeedEdge(t, d.Graph, direct, id, "links_to")
	}
	code, body := houOc517GetRefs(t, d, "?ids=hou-cap&hop=1")
	if code != http.StatusOK {
		t.Fatalf("GET refs = %d: %s", code, string(body))
	}
	out := houOc517DecodeRefs(t, body)
	if len(out.Linked) != 20 {
		t.Fatalf("linked = %d, want first 20", len(out.Linked))
	}
	if out.LinkedOmitted != 5 {
		t.Errorf("linkedOmitted = %d, want 5", out.LinkedOmitted)
	}
	if !sort.StringsAreSorted(linkedPaths(out)) {
		t.Errorf("linked not ordered by path: %v", linkedPaths(out))
	}
}

func pad2(i int) string {
	if i < 10 {
		return "0" + string(rune('0'+i))
	}
	return string(rune('0'+i/10)) + string(rune('0'+i%10))
}

func linkedPaths(out notesRefsResponse) []string {
	var paths []string
	for _, ln := range out.Linked {
		paths = append(paths, ln.Path)
	}
	return paths
}

func TestHouOc517RefsOrdering(t *testing.T) {
	d := newTestDeps(t, "")
	houOc517SeedNote(t, d.Graph, "B", "notes/b.md", "nota", []string{"hou-ord"}, nil)
	houOc517SeedNote(t, d.Graph, "A", "notes/a.md", "nota", []string{"hou-ord"}, nil)
	code, body := houOc517GetRefs(t, d, "?ids=hou-ord")
	if code != http.StatusOK {
		t.Fatalf("GET refs = %d", code)
	}
	out := houOc517DecodeRefs(t, body)
	if len(out.Notes) != 2 || out.Notes[0].Path != "notes/a.md" || out.Notes[1].Path != "notes/b.md" {
		t.Fatalf("notes not ordered by path: %+v", out.Notes)
	}
}

func TestHouOc517RefsEmptyListsAsEmpty(t *testing.T) {
	d := newTestDeps(t, "")
	code, body := houOc517GetRefs(t, d, "?ids=hou-missing")
	if code != http.StatusOK {
		t.Fatalf("GET refs = %d: %s", code, string(body))
	}
	if strings.Contains(string(body), "null") {
		t.Logf("body contains null (check lists): %s", string(body))
	}
	out := houOc517DecodeRefs(t, body)
	if out.Notes == nil || out.Linked == nil {
		t.Fatalf("lists must be [] not null: %+v", out)
	}
	if len(out.Notes) != 0 || len(out.Linked) != 0 || out.LinkedOmitted != 0 {
		t.Fatalf("empty answer = %+v, want empty lists", out)
	}
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(body, &raw); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"notes", "linked"} {
		if string(raw[key]) != "[]" {
			t.Errorf("%s = %s, want []", key, string(raw[key]))
		}
	}
}

func TestHouOc517RefsEach400(t *testing.T) {
	d := newTestDeps(t, "")
	for _, q := range []string{"", "?ids=", "?ids=%20,%20", "?ids=hou-1&kind=bogus", "?ids=hou-1&hop=2", "?ids=hou-1&hop=bogus"} {
		code, _ := houOc517GetRefs(t, d, q)
		if code != http.StatusBadRequest {
			t.Errorf("query %q = %d, want 400", q, code)
		}
	}
	many := make([]string, 201)
	for i := range many {
		many[i] = "hou-" + strings.Repeat("a", 3) + string(rune('0'+i%10)) + string(rune('0'+(i/10)%10)) + string(rune('0'+(i/100)%10))
	}
	code, _ := houOc517GetRefs(t, d, "?ids="+strings.Join(many, ","))
	if code != http.StatusBadRequest {
		t.Errorf("201 ids = %d, want 400", code)
	}
}

func TestHouOc517RefsDeletedNeverReturned(t *testing.T) {
	d := newTestDeps(t, "")
	ctx := context.Background()
	id := houOc517SeedNote(t, d.Graph, "Gone", "notes/gone.md", "nota", []string{"hou-del"}, nil)
	if err := d.Graph.DoWrite(ctx, func(tx *graph.WriteTx) error {
		return nodes.SoftDeleteNoteTx(ctx, tx, id, "gone", "Gone", testAuthor)
	}); err != nil {
		t.Fatalf("soft delete: %v", err)
	}
	code, body := houOc517GetRefs(t, d, "?ids=hou-del")
	if code != http.StatusOK {
		t.Fatalf("GET refs = %d", code)
	}
	out := houOc517DecodeRefs(t, body)
	if len(out.Notes) != 0 {
		t.Fatalf("deleted note must never be returned, got %+v", out.Notes)
	}
}

func TestHouOc517RefsNoteWithoutKindAnswersNota(t *testing.T) {
	d := newTestDeps(t, "")
	ctx := context.Background()
	var id string
	if err := d.Graph.DoWrite(ctx, func(tx *graph.WriteTx) error {
		var err error
		id, err = nodes.CreateNote(ctx, tx, nodes.Note{Title: "NoKind", Body: "b", Refs: []string{"hou-kind"}}, testAuthor)
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
	code, body := houOc517GetRefs(t, d, "?ids=hou-kind")
	if code != http.StatusOK {
		t.Fatalf("GET refs = %d: %s", code, string(body))
	}
	out := houOc517DecodeRefs(t, body)
	if len(out.Notes) != 1 {
		t.Fatalf("notes = %d, want 1", len(out.Notes))
	}
	if out.Notes[0].Kind != "nota" {
		t.Errorf("kind = %q, want nota", out.Notes[0].Kind)
	}
	code, body = houOc517GetRefs(t, d, "?ids=hou-kind&kind=nota")
	if code != http.StatusOK {
		t.Fatalf("GET refs kind=nota = %d", code)
	}
	out = houOc517DecodeRefs(t, body)
	if len(out.Notes) != 1 {
		t.Fatalf("note without kind must match kind=nota, got %d", len(out.Notes))
	}
}

func TestHouOc517RefsMatchedRefsSorted(t *testing.T) {
	d := newTestDeps(t, "")
	houOc517SeedNote(t, d.Graph, "M", "notes/m.md", "nota", []string{"hou-z", "hou-a", "hou-m"}, []string{"z", "a"})
	code, body := houOc517GetRefs(t, d, "?ids=hou-m,hou-a,hou-z")
	if code != http.StatusOK {
		t.Fatalf("GET refs = %d", code)
	}
	out := houOc517DecodeRefs(t, body)
	if len(out.Notes) != 1 {
		t.Fatalf("notes = %d", len(out.Notes))
	}
	if !sort.StringsAreSorted(out.Notes[0].MatchedRefs) {
		t.Errorf("matchedRefs not sorted: %v", out.Notes[0].MatchedRefs)
	}
	if !sort.StringsAreSorted(out.Notes[0].Tags) {
		t.Errorf("tags not sorted: %v", out.Notes[0].Tags)
	}
}
