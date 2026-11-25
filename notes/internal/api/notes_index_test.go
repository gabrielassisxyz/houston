package api

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gabrielassisxyz/houston/notes/internal/graph"
	"github.com/gabrielassisxyz/houston/notes/internal/graph/edges"
	"github.com/gabrielassisxyz/houston/notes/internal/graph/nodes"
	"github.com/gabrielassisxyz/houston/notes/internal/vault/reconcile"
)

var testAuthor = nodes.Author{Name: "test"}

// seedVaultNote creates a note node, indexes it at path, and tags it. When
// describes is non-empty the note becomes that entity's companion, which is how
// a note acquires a category other than "note".
func seedVaultNote(t *testing.T, g *graph.Graph, title, path, fmAuthor, describes string, noteTags ...string) string {
	t.Helper()
	ctx := context.Background()
	var id string
	err := g.DoWrite(ctx, func(tx *graph.WriteTx) error {
		var err error
		id, err = nodes.CreateNote(ctx, tx, nodes.Note{
			Title:  title,
			Body:   "body of " + title,
			Author: fmAuthor,
			Tags:   noteTags,
		}, testAuthor)
		if err != nil {
			return err
		}
		// The label is spelled out rather than read from the handler's constant:
		// it is the string the stored edges carry, so a constant changed in the
		// handler alone has to fail here.
		if describes != "" {
			if _, err := edges.Create(ctx, tx, edges.Edge{
				Src: id, Dst: describes, Label: "describes",
			}, testAuthor); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		t.Fatalf("seed note %q: %v", title, err)
	}
	if err := reconcile.Upsert(ctx, g, id, path, "hash-"+id); err != nil {
		t.Fatalf("index note %q: %v", title, err)
	}
	return id
}

func getNoteIndex(t *testing.T, d Deps) noteIndexResponse {
	t.Helper()
	rec := httptest.NewRecorder()
	newTestRouter(t, d).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/notes", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /api/notes = %d, body %s", rec.Code, rec.Body.String())
	}
	var out noteIndexResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode index: %v", err)
	}
	return out
}

func entryByPath(t *testing.T, index noteIndexResponse, path string) noteIndexEntry {
	t.Helper()
	for _, e := range index.Notes {
		if e.Path == path {
			return e
		}
	}
	t.Fatalf("no index entry for %q; got %d entries", path, len(index.Notes))
	return noteIndexEntry{}
}

// TestNoteIndexCategoryComesFromTheDescribedEntity is the point of the whole
// endpoint. Every file in the vault is a "note" node - a project's companion is
// a separate note joined to it by a describes edge - so reading nodes.type
// would label every row "note", which is exactly the defect the old list had.
func TestNoteIndexCategoryComesFromTheDescribedEntity(t *testing.T) {
	d := newTestDeps(t, "")
	ctx := context.Background()

	var projectID string
	if err := d.Graph.DoWrite(ctx, func(tx *graph.WriteTx) error {
		var err error
		projectID, err = nodes.CreateProject(ctx, tx, nodes.Project{Title: "atlas"}, testAuthor)
		return err
	}); err != nil {
		t.Fatalf("create project: %v", err)
	}

	seedVaultNote(t, d.Graph, "atlas", "projects/atlas.md", "", projectID)
	seedVaultNote(t, d.Graph, "a plain thought", "notes/thought.md", "", "")

	index := getNoteIndex(t, d)
	if got := entryByPath(t, index, "projects/atlas.md").Category; got != "project" {
		t.Errorf("companion note category = %q, want %q", got, "project")
	}
	if got := entryByPath(t, index, "notes/thought.md").Category; got != "note" {
		t.Errorf("plain note category = %q, want %q", got, "note")
	}
}

// A note describing an entity that was deleted falls back to "note" rather than
// vanishing from the index or reporting an empty category.
func TestNoteIndexCategoryFallsBackWhenTheEntityIsGone(t *testing.T) {
	d := newTestDeps(t, "")
	ctx := context.Background()

	var projectID string
	if err := d.Graph.DoWrite(ctx, func(tx *graph.WriteTx) error {
		var err error
		projectID, err = nodes.CreateProject(ctx, tx, nodes.Project{Title: "retired"}, testAuthor)
		return err
	}); err != nil {
		t.Fatalf("create project: %v", err)
	}
	seedVaultNote(t, d.Graph, "retired", "projects/retired.md", "", projectID)

	if err := d.Graph.DoWrite(ctx, func(tx *graph.WriteTx) error {
		return nodes.DeleteProject(ctx, tx, projectID, testAuthor)
	}); err != nil {
		t.Fatalf("delete project: %v", err)
	}

	index := getNoteIndex(t, d)
	if got := entryByPath(t, index, "projects/retired.md").Category; got != "note" {
		t.Errorf("orphaned companion category = %q, want %q", got, "note")
	}
}

// The badge that says "this one is not yours" hangs off this mapping, so the
// endpoint has to resolve authorship the same way the reconciler wrote it -
// notably "da" becoming "agent:da" and an absent value becoming "human".
func TestNoteIndexResolvesAuthorship(t *testing.T) {
	d := newTestDeps(t, "")

	seedVaultNote(t, d.Graph, "mine", "notes/mine.md", "", "")
	seedVaultNote(t, d.Graph, "the DA's", "notes/da.md", "da", "")
	seedVaultNote(t, d.Graph, "named human", "notes/named.md", "user", "")

	index := getNoteIndex(t, d)
	for path, want := range map[string]string{
		"notes/mine.md":  "human",
		"notes/da.md":    "agent:da",
		"notes/named.md": "user",
	} {
		if got := entryByPath(t, index, path).Author; got != want {
			t.Errorf("%s author = %q, want %q", path, got, want)
		}
	}
}

func TestNoteIndexCarriesTagsAndTimestamps(t *testing.T) {
	d := newTestDeps(t, "")

	seedVaultNote(t, d.Graph, "tagged", "notes/tagged.md", "", "", "zulu", "alpha")
	seedVaultNote(t, d.Graph, "bare", "notes/bare.md", "", "")

	index := getNoteIndex(t, d)

	tagged := entryByPath(t, index, "notes/tagged.md")
	if len(tagged.Tags) != 2 || tagged.Tags[0] != "alpha" || tagged.Tags[1] != "zulu" {
		t.Errorf("tags = %v, want [alpha zulu] in name order", tagged.Tags)
	}
	if tagged.CreatedAt == "" || tagged.UpdatedAt == "" {
		t.Errorf("timestamps missing: created %q, updated %q", tagged.CreatedAt, tagged.UpdatedAt)
	}

	// An untagged note reports an empty list, never null: the client iterates
	// it without a guard.
	bare := entryByPath(t, index, "notes/bare.md")
	if bare.Tags == nil {
		t.Error("an untagged note should carry [] rather than null")
	}
}

// The permission badge answers "may the assistant modify this note?" from the
// same rule the reconciler validated the file with: an explicit override wins,
// and absent one the default falls out of author.
func TestNoteIndexSurfacesPermission(t *testing.T) {
	d := newTestDeps(t, "")
	ctx := context.Background()

	seed := func(title, path, fmAuthor, fmPermission string) {
		t.Helper()
		var id string
		if err := d.Graph.DoWrite(ctx, func(tx *graph.WriteTx) error {
			var err error
			id, err = nodes.CreateNote(ctx, tx, nodes.Note{
				Title:      title,
				Body:       "body of " + title,
				Author:     fmAuthor,
				Permission: fmPermission,
			}, testAuthor)
			return err
		}); err != nil {
			t.Fatalf("seed note %q: %v", title, err)
		}
		if err := reconcile.Upsert(ctx, d.Graph, id, path, "hash-"+id); err != nil {
			t.Fatalf("index note %q: %v", title, err)
		}
	}

	seed("mine", "notes/mine.md", "", "")
	seed("the DA's", "notes/da.md", "da", "")
	seed("explicit ask on DA", "notes/da-ask.md", "da", "ask")
	seed("explicit edit on mine", "notes/mine-edit.md", "", "edit")

	index := getNoteIndex(t, d)
	for path, want := range map[string]string{
		"notes/mine.md":      "ask",
		"notes/da.md":        "edit",
		"notes/da-ask.md":    "ask",
		"notes/mine-edit.md": "edit",
	} {
		if got := entryByPath(t, index, path).Permission; got != want {
			t.Errorf("%s permission = %q, want %q", path, got, want)
		}
	}
}

// A node with no vault file has no business in a list of vault files, and a
// tombstoned note has to leave it.
func TestNoteIndexHoldsOnlyLiveVaultFiles(t *testing.T) {
	d := newTestDeps(t, "")
	ctx := context.Background()

	if err := d.Graph.DoWrite(ctx, func(tx *graph.WriteTx) error {
		_, err := nodes.CreateProject(ctx, tx, nodes.Project{Title: "no companion"}, testAuthor)
		return err
	}); err != nil {
		t.Fatalf("create project: %v", err)
	}
	doomed := seedVaultNote(t, d.Graph, "doomed", "notes/doomed.md", "", "")
	seedVaultNote(t, d.Graph, "alive", "notes/alive.md", "", "")

	if err := d.Graph.DoWrite(ctx, func(tx *graph.WriteTx) error {
		return nodes.DeleteNote(ctx, tx, doomed, testAuthor)
	}); err != nil {
		t.Fatalf("delete note: %v", err)
	}

	index := getNoteIndex(t, d)
	if len(index.Notes) != 1 {
		t.Fatalf("index holds %d entries, want 1", len(index.Notes))
	}
	if index.Notes[0].Path != "notes/alive.md" {
		t.Errorf("index kept %q, want notes/alive.md", index.Notes[0].Path)
	}
}

func TestNoteIndexIsEmptyNotNull(t *testing.T) {
	d := newTestDeps(t, "")

	rec := httptest.NewRecorder()
	newTestRouter(t, d).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/notes", nil))
	if body := rec.Body.String(); !bytes.Contains([]byte(body), []byte(`"notes":[]`)) ||
		!bytes.Contains([]byte(body), []byte(`"pinnedTags":[]`)) {
		t.Errorf("an empty vault should answer with empty arrays, got %s", body)
	}
}
