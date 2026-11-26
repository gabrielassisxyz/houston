package nodes

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/gabrielassisxyz/houston/notes/internal/graph"
	"github.com/gabrielassisxyz/houston/notes/internal/graph/revisions"
	"github.com/gabrielassisxyz/houston/notes/internal/graph/testutil"
)

// latestRevision returns the id and diff of the newest revision of nodeID, in
// the order updateNode itself uses to pick a parent.
func latestRevision(t *testing.T, g *graph.Graph, nodeID string) (string, string) {
	t.Helper()
	var id, diff string
	if err := g.DoRead(context.Background(), func(tx *graph.ReadTx) error {
		return tx.QueryRow(
			`SELECT id, diff FROM revisions WHERE node_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
			nodeID,
		).Scan(&id, &diff)
	}); err != nil {
		t.Fatalf("latest revision of %s: %v", nodeID, err)
	}
	return id, diff
}

func revisionCount(t *testing.T, g *graph.Graph, nodeID string) int {
	t.Helper()
	var n int
	if err := g.DoRead(context.Background(), func(tx *graph.ReadTx) error {
		return tx.QueryRow(`SELECT COUNT(*) FROM revisions WHERE node_id = ?`, nodeID).Scan(&n)
	}); err != nil {
		t.Fatalf("revision count of %s: %v", nodeID, err)
	}
	return n
}

// diffOps returns how many line operations a stored diff carries; zero means
// the payload is a snapshot.
func diffOps(t *testing.T, diff string) int {
	t.Helper()
	var payload struct {
		Ops []json.RawMessage `json:"ops"`
	}
	if err := json.Unmarshal([]byte(diff), &payload); err != nil {
		t.Fatalf("revision diff is not JSON: %v: %s", err, diff)
	}
	return len(payload.Ops)
}

// isSnapshotDiff reports whether a stored diff is a full snapshot: a title and
// attrs payload, not {"ops":null}, which reconstruction would read as a
// snapshot of an empty body.
func isSnapshotDiff(t *testing.T, diff string) bool {
	t.Helper()
	var payload map[string]json.RawMessage
	if err := json.Unmarshal([]byte(diff), &payload); err != nil {
		t.Fatalf("revision diff is not JSON: %v: %s", err, diff)
	}
	_, hasAttrs := payload["attrs"]
	_, hasOps := payload["ops"]
	return hasAttrs && !hasOps
}

func reconstruct(t *testing.T, g *graph.Graph, nodeID, revID string) string {
	t.Helper()
	var body string
	if err := g.DoRead(context.Background(), func(tx *graph.ReadTx) error {
		var err error
		body, err = revisions.ReconstructBody(context.Background(), tx, nodeID, revID)
		return err
	}); err != nil {
		t.Fatalf("ReconstructBody(%s): %v", revID, err)
	}
	return body
}

func createTestNote(t *testing.T, g *graph.Graph, n Note) string {
	t.Helper()
	var id string
	if err := g.DoWrite(context.Background(), func(tx *graph.WriteTx) error {
		var err error
		id, err = CreateNote(context.Background(), tx, n, Author{Name: "human"})
		return err
	}); err != nil {
		t.Fatalf("CreateNote: %v", err)
	}
	return id
}

func updateTestNote(t *testing.T, g *graph.Graph, n Note) {
	t.Helper()
	if err := g.DoWrite(context.Background(), func(tx *graph.WriteTx) error {
		return UpdateNote(context.Background(), tx, n, Author{Name: "human"})
	}); err != nil {
		t.Fatalf("UpdateNote: %v", err)
	}
}

func numberedLines(count int, edited int) string {
	lines := make([]string, count)
	for i := range lines {
		lines[i] = fmt.Sprintf("line %04d", i)
	}
	if edited >= 0 {
		lines[edited] = "edited line"
	}
	return strings.Join(lines, "\n")
}

// A note of five thousand short lines is under MaxDiffBytes and changes by one
// line, so only the cell cap keeps lineDiff from building a 25-million-cell
// table; the revision is stored as a snapshot and still reconstructs.
func TestNoteDiffCapStoresSnapshotForLargeNote(t *testing.T) {
	g := testutil.NewInMemoryTestGraph(t)
	before := numberedLines(5000, -1)
	if len(before) > MaxDiffBytes {
		t.Fatalf("fixture is %d bytes, over MaxDiffBytes; the cap would not be what decides", len(before))
	}
	id := createTestNote(t, g, Note{Title: "Large", Body: before})

	after := numberedLines(5000, 2500)
	updateTestNote(t, g, Note{ID: id, Title: "Large", Body: after})

	revID, diff := latestRevision(t, g, id)
	if !isSnapshotDiff(t, diff) {
		t.Fatalf("edit of a 5,000-line note stored a line diff (%d ops), want a snapshot", diffOps(t, diff))
	}
	if got := reconstruct(t, g, id, revID); got != after {
		t.Errorf("snapshot reconstructs to %d bytes, want the edited body of %d bytes", len(got), len(after))
	}
}

func TestNoteDiffCapKeepsLineDiffForSmallNote(t *testing.T) {
	g := testutil.NewInMemoryTestGraph(t)
	id := createTestNote(t, g, Note{Title: "Small", Body: numberedLines(20, -1)})

	after := numberedLines(20, 10)
	updateTestNote(t, g, Note{ID: id, Title: "Small", Body: after})

	_, diff := latestRevision(t, g, id)
	if n := diffOps(t, diff); n == 0 {
		t.Fatalf("edit of a small note stored no line operation: %s", diff)
	}
}

// The cap is on the product of the line counts, the size of the table.
func TestNoteDiffBodyCapIsOnCells(t *testing.T) {
	under := numberedLines(2000, -1) // 2,000 x 2,000 = 4,000,000 cells, at the cap
	if diff := (Note{Body: numberedLines(2000, 7)}).DiffBody(Note{Body: under}); diffOps(t, string(diff)) == 0 {
		t.Errorf("a 2,000-line edit is at the cap and must still be a line diff: %s", diff)
	}
	over := numberedLines(2001, -1)
	if diff := (Note{Body: numberedLines(2001, 7)}).DiffBody(Note{Body: over}); !isSnapshotDiff(t, string(diff)) {
		t.Errorf("a 2,001-line edit is over the cap and must be a snapshot, got %d ops", diffOps(t, string(diff)))
	}
}

// DiffBody of an unchanged body has no operation to store, so it answers a
// snapshot: {"ops":null} would be read back as an empty body.
func TestNoteDiffBodyWithoutOperationIsSnapshot(t *testing.T) {
	n := Note{Title: "Same", Body: "one\ntwo"}
	diff := n.DiffBody(Note{Title: "Same", Body: "one\ntwo"})
	if !isSnapshotDiff(t, string(diff)) {
		t.Fatalf("DiffBody of an unchanged body = %s, want a snapshot", diff)
	}
}

func TestUpdateUnchangedNoteAddsNoRevision(t *testing.T) {
	g := testutil.NewInMemoryTestGraph(t)
	n := Note{Title: "Steady", Body: "body", Tags: []string{"alpha", "beta"}, Refs: []string{"STRY00000001"}}
	id := createTestNote(t, g, n)
	n.ID = id

	updateTestNote(t, g, n)
	updateTestNote(t, g, n)

	if got := revisionCount(t, g, id); got != 1 {
		t.Errorf("two unchanged updates left %d revisions, want the creation's 1", got)
	}
}

func TestUpdateSameTagsInAnotherOrderAddsNoRevision(t *testing.T) {
	g := testutil.NewInMemoryTestGraph(t)
	id := createTestNote(t, g, Note{Title: "Order", Body: "body", Tags: []string{"alpha", "beta", "gamma"}})

	updateTestNote(t, g, Note{ID: id, Title: "Order", Body: "body", Tags: []string{"gamma", "alpha", "beta"}})

	if got := revisionCount(t, g, id); got != 1 {
		t.Errorf("reordered tags left %d revisions, want 1", got)
	}
}

// A tags-only change keeps its history as a snapshot whose body is the note's,
// not the empty body {"ops":null} reconstructs to.
func TestUpdateTagsOnlyAddsSnapshotThatReconstructs(t *testing.T) {
	g := testutil.NewInMemoryTestGraph(t)
	body := "first line\nsecond line"
	id := createTestNote(t, g, Note{Title: "Tagged", Body: body, Tags: []string{"alpha"}})

	updateTestNote(t, g, Note{ID: id, Title: "Tagged", Body: body, Tags: []string{"alpha", "beta"}})

	if got := revisionCount(t, g, id); got != 2 {
		t.Fatalf("tags-only change left %d revisions, want 2", got)
	}
	revID, diff := latestRevision(t, g, id)
	if !isSnapshotDiff(t, diff) {
		t.Fatalf("tags-only change stored %s, want a snapshot", diff)
	}
	if got := reconstruct(t, g, id, revID); got != body {
		t.Errorf("tags-only revision reconstructs to %q, want %q", got, body)
	}
}

func TestUpdateRefsOnlyAddsSnapshot(t *testing.T) {
	g := testutil.NewInMemoryTestGraph(t)
	body := "cites a story"
	id := createTestNote(t, g, Note{Title: "Refs", Body: body, Refs: []string{"STRY00000001"}})

	updateTestNote(t, g, Note{ID: id, Title: "Refs", Body: body, Refs: []string{"STRY00000001", "INC00000001"}})

	if got := revisionCount(t, g, id); got != 2 {
		t.Fatalf("refs-only change left %d revisions, want 2", got)
	}
	revID, diff := latestRevision(t, g, id)
	if !isSnapshotDiff(t, diff) {
		t.Fatalf("refs-only change stored %s, want a snapshot", diff)
	}
	if got := reconstruct(t, g, id, revID); got != body {
		t.Errorf("refs-only revision reconstructs to %q, want %q", got, body)
	}
}

func TestUpdateTitleOnlyAddsSnapshot(t *testing.T) {
	g := testutil.NewInMemoryTestGraph(t)
	body := "kept"
	id := createTestNote(t, g, Note{Title: "Before", Body: body})

	updateTestNote(t, g, Note{ID: id, Title: "After", Body: body})

	revID, diff := latestRevision(t, g, id)
	if !isSnapshotDiff(t, diff) {
		t.Fatalf("title-only change stored %s, want a snapshot", diff)
	}
	if got := reconstruct(t, g, id, revID); got != body {
		t.Errorf("title-only revision reconstructs to %q, want %q", got, body)
	}
}
