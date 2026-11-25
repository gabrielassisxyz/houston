package nodes

import (
	"context"
	"os"
	"testing"

	"github.com/gabrielassisxyz/houston/notes/internal/graph"
	"github.com/gabrielassisxyz/houston/notes/internal/graph/internal/migrate"
	"github.com/gabrielassisxyz/houston/notes/internal/graph/internal/sqlite"
	"github.com/gabrielassisxyz/houston/notes/internal/graph/schema"
	"github.com/gabrielassisxyz/houston/notes/internal/graph/testutil"
)

func houOc517CreateNote(t *testing.T, g *graph.Graph, n Note) string {
	t.Helper()
	ctx := context.Background()
	var id string
	if err := g.DoWrite(ctx, func(tx *graph.WriteTx) error {
		var err error
		id, err = CreateNote(ctx, tx, n, Author{Name: "test"})
		return err
	}); err != nil {
		t.Fatalf("CreateNote: %v", err)
	}
	return id
}

func houOc517GetNote(t *testing.T, g *graph.Graph, id string) *Note {
	t.Helper()
	ctx := context.Background()
	var got *Note
	if err := g.DoRead(ctx, func(tx *graph.ReadTx) error {
		var err error
		got, err = GetNote(ctx, tx, id)
		return err
	}); err != nil {
		t.Fatalf("GetNote %q: %v", id, err)
	}
	return got
}

func houOc517CountRefs(t *testing.T, g *graph.Graph, id string) int {
	t.Helper()
	ctx := context.Background()
	var count int
	if err := g.DoRead(ctx, func(tx *graph.ReadTx) error {
		return tx.QueryRow(`SELECT COUNT(*) FROM note_refs WHERE node_id = ?`, id).Scan(&count)
	}); err != nil {
		t.Fatalf("count refs: %v", err)
	}
	return count
}

func TestHouOc517NoteKindRefsRoundtrip(t *testing.T) {
	g := testutil.NewInMemoryTestGraph(t)
	id := houOc517CreateNote(t, g, Note{
		Title: "Kind Refs",
		Body:  "b",
		Kind:  "plano",
		Refs:  []string{"hou-4kz", "STRY00000001"},
		Tags:  []string{"t"},
	})
	got := houOc517GetNote(t, g, id)
	if got.Kind != "plano" {
		t.Errorf("kind = %q, want plano", got.Kind)
	}
	if len(got.Refs) != 2 {
		t.Fatalf("refs = %v, want 2", got.Refs)
	}
}

func TestHouOc517NoteRefsCaseDedup(t *testing.T) {
	g := testutil.NewInMemoryTestGraph(t)
	id := houOc517CreateNote(t, g, Note{
		Title: "Case",
		Body:  "b",
		Refs:  []string{"hou-4kz", "HOU-4KZ"},
	})
	if got := houOc517CountRefs(t, g, id); got != 1 {
		t.Fatalf("refs rows = %d, want 1 for case-duplicate", got)
	}
	got := houOc517GetNote(t, g, id)
	if len(got.Refs) != 1 {
		t.Fatalf("refs = %v, want 1 row", got.Refs)
	}

	// A case-only edit keeps one row.
	ctx := context.Background()
	if err := g.DoWrite(ctx, func(tx *graph.WriteTx) error {
		n, err := GetNote(ctx, tx.AsReadTx(), id)
		if err != nil {
			return err
		}
		n.Refs = []string{"HOU-4KZ"}
		return UpdateNote(ctx, tx, *n, Author{Name: "test"})
	}); err != nil {
		t.Fatalf("UpdateNote case-only: %v", err)
	}
	if got := houOc517CountRefs(t, g, id); got != 1 {
		t.Errorf("refs rows after case-only edit = %d, want 1", got)
	}
}

func TestHouOc517NoteRefsThroughLifecycle(t *testing.T) {
	g := testutil.NewInMemoryTestGraph(t)
	ctx := context.Background()
	id := houOc517CreateNote(t, g, Note{Title: "Life", Body: "b", Refs: []string{"INC00000001"}})
	if got := houOc517CountRefs(t, g, id); got != 1 {
		t.Fatalf("create refs = %d, want 1", got)
	}

	// Update adds a ref.
	if err := g.DoWrite(ctx, func(tx *graph.WriteTx) error {
		n, err := GetNote(ctx, tx.AsReadTx(), id)
		if err != nil {
			return err
		}
		n.Refs = []string{"INC00000001", "CHG00000001"}
		return UpdateNote(ctx, tx, *n, Author{Name: "test"})
	}); err != nil {
		t.Fatalf("UpdateNote: %v", err)
	}
	if got := houOc517CountRefs(t, g, id); got != 2 {
		t.Fatalf("update refs = %d, want 2", got)
	}

	// Soft delete keeps rows but hides the note.
	if err := g.DoWrite(ctx, func(tx *graph.WriteTx) error {
		return SoftDeleteNoteTx(ctx, tx, id, "life", "Life", Author{Name: "test"})
	}); err != nil {
		t.Fatalf("SoftDelete: %v", err)
	}
	if err := g.DoRead(ctx, func(tx *graph.ReadTx) error {
		_, err := GetNote(ctx, tx, id)
		if err == nil {
			t.Errorf("GetNote on deleted note should fail")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	var rawCount int
	if err := g.DoRead(ctx, func(tx *graph.ReadTx) error {
		return tx.QueryRow(`SELECT COUNT(*) FROM note_refs WHERE node_id = ?`, id).Scan(&rawCount)
	}); err != nil {
		t.Fatal(err)
	}
	if rawCount != 2 {
		t.Fatalf("refs rows after soft delete = %d, want 2 to survive", rawCount)
	}

	// Revive brings the note back whole.
	if err := g.DoWrite(ctx, func(tx *graph.WriteTx) error {
		return ReviveNoteTx(ctx, tx, id, "life", "Life", Author{Name: "test"})
	}); err != nil {
		t.Fatalf("Revive: %v", err)
	}
	got := houOc517GetNote(t, g, id)
	if len(got.Refs) != 2 {
		t.Fatalf("refs after revive = %v, want 2", got.Refs)
	}

	// Hard delete removes refs rows via cascade.
	if err := g.DoWrite(ctx, func(tx *graph.WriteTx) error {
		return DeleteNote(ctx, tx, id, Author{Name: "test"})
	}); err != nil {
		t.Fatalf("DeleteNote: %v", err)
	}
	if got := houOc517CountRefs(t, g, id); got != 0 {
		t.Errorf("refs after hard delete = %d, want 0", got)
	}
}

func TestHouOc517NoteDeletedNeverReturned(t *testing.T) {
	g := testutil.NewInMemoryTestGraph(t)
	ctx := context.Background()
	id := houOc517CreateNote(t, g, Note{Title: "Gone", Body: "b", Refs: []string{"hou-9zz"}})
	if err := g.DoWrite(ctx, func(tx *graph.WriteTx) error {
		return SoftDeleteNoteTx(ctx, tx, id, "gone", "Gone", Author{Name: "test"})
	}); err != nil {
		t.Fatalf("SoftDelete: %v", err)
	}
	if err := g.DoRead(ctx, func(tx *graph.ReadTx) error {
		items, err := ListNotes(ctx, tx, NoteFilter{})
		if err != nil {
			return err
		}
		for _, n := range items {
			if n.ID == id {
				t.Errorf("deleted note %q listed", id)
			}
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func TestHouOc517NoteKindSurvivesUpdate(t *testing.T) {
	g := testutil.NewInMemoryTestGraph(t)
	ctx := context.Background()
	id := houOc517CreateNote(t, g, Note{Title: "K", Body: "before", Kind: "plano"})
	if err := g.DoWrite(ctx, func(tx *graph.WriteTx) error {
		n, err := GetNote(ctx, tx.AsReadTx(), id)
		if err != nil {
			return err
		}
		n.Body = "after"
		return UpdateNote(ctx, tx, *n, Author{Name: "test"})
	}); err != nil {
		t.Fatalf("UpdateNote: %v", err)
	}
	got := houOc517GetNote(t, g, id)
	if got.Kind != "plano" {
		t.Errorf("kind after update = %q, want plano", got.Kind)
	}
	if err := g.DoRead(ctx, func(tx *graph.ReadTx) error {
		items, err := ListNotes(ctx, tx, NoteFilter{})
		if err != nil {
			return err
		}
		for _, n := range items {
			if n.ID == id && n.Kind != "plano" {
				t.Errorf("ListNotes kind = %q, want plano", n.Kind)
			}
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func TestHouOc517NoteWithoutKindAnswersNota(t *testing.T) {
	g := testutil.NewInMemoryTestGraph(t)
	ctx := context.Background()
	var id string
	if err := g.DoWrite(ctx, func(tx *graph.WriteTx) error {
		var err error
		id, err = CreateNote(ctx, tx, Note{Title: "NoKind", Body: "b"}, Author{Name: "test"})
		return err
	}); err != nil {
		t.Fatalf("CreateNote: %v", err)
	}
	// Simulate a note indexed before this step: strip kind from attrs.
	if err := g.DoWrite(ctx, func(tx *graph.WriteTx) error {
		_, err := tx.Exec(`UPDATE nodes SET attrs = json_remove(attrs, '$.kind') WHERE id = ?`, id)
		return err
	}); err != nil {
		t.Fatalf("strip kind: %v", err)
	}
	got := houOc517GetNote(t, g, id)
	if got.Kind != "nota" {
		t.Errorf("kind = %q, want nota for note without kind", got.Kind)
	}
	if got.Kind == "" {
		t.Errorf("kind must never be empty")
	}
}

func TestHouOc517NormalizeNoteKind(t *testing.T) {
	if got := NormalizeNoteKind("Plano"); got != "plano" {
		t.Errorf("got %q, want plano", got)
	}
	if got := NormalizeNoteKind(""); got != "nota" {
		t.Errorf("empty got %q, want nota", got)
	}
	if got := NormalizeNoteKind("bogus"); got != "nota" {
		t.Errorf("bogus got %q, want nota", got)
	}
}

func houOc517OpenSchemaDB(t *testing.T) (*migrate.Runner, func()) {
	t.Helper()
	f, err := os.CreateTemp("", "hou-oc5.17-schema-*.db")
	if err != nil {
		t.Fatalf("CreateTemp: %v", err)
	}
	f.Close()
	pool, err := sqlite.Open(sqlite.Config{Path: f.Name()})
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	r, err := migrate.New(pool.Write, schema.FS)
	if err != nil {
		t.Fatalf("migrate.New: %v", err)
	}
	return r, func() {
		_ = pool.Close()
		_ = os.Remove(f.Name())
	}
}

func TestHouOc517Migration0009AppliesFreshAndFrom0008(t *testing.T) {
	r, cleanup := houOc517OpenSchemaDB(t)
	defer cleanup()
	ctx := context.Background()

	// Fresh: Up applies 0009.
	if err := r.Up(ctx); err != nil {
		t.Fatalf("Up fresh: %v", err)
	}
	ver, dirty, err := r.Current(ctx)
	if err != nil {
		t.Fatalf("Current: %v", err)
	}
	if dirty || ver < 9 {
		t.Fatalf("version = %d dirty=%v, want >=9 clean", ver, dirty)
	}
	if _, err := schema.FS.ReadFile("0009_note_refs.up.sql"); err != nil {
		t.Fatalf("up file missing: %v", err)
	}
	if _, err := schema.FS.ReadFile("0009_note_refs.down.sql"); err != nil {
		t.Fatalf("down file missing beside its up file: %v", err)
	}

	// From 0008: Down once (9->8), then Up again.
	if err := r.Down(ctx); err != nil {
		t.Fatalf("Down from head: %v", err)
	}
	ver, _, err = r.Current(ctx)
	if err != nil {
		t.Fatalf("Current after Down: %v", err)
	}
	if ver != 8 {
		t.Fatalf("version after Down = %d, want 8", ver)
	}
	if err := r.Up(ctx); err != nil {
		t.Fatalf("Up from 8: %v", err)
	}
	ver, dirty, err = r.Current(ctx)
	if err != nil {
		t.Fatalf("Current: %v", err)
	}
	if dirty || ver < 9 {
		t.Fatalf("version = %d dirty=%v, want >=9 clean after re-Up", ver, dirty)
	}
}
