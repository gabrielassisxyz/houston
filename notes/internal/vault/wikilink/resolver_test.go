package wikilink

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/gabrielassisxyz/houston/notes/internal/graph"
	"github.com/gabrielassisxyz/houston/notes/internal/graph/edges"
	"github.com/gabrielassisxyz/houston/notes/internal/graph/nodes"
	"github.com/gabrielassisxyz/houston/notes/internal/graph/testutil"
)

// author is the test author used for node creation.
var testAuthor = nodes.Author{Name: "test"}

// createTestNote inserts a note node and returns its ID.
func createTestNote(t *testing.T, g *graph.Graph, ctx context.Context, title, body string) string {
	t.Helper()
	var id string
	err := g.DoWrite(ctx, func(tx *graph.WriteTx) error {
		var err error
		id, err = nodes.CreateNote(ctx, tx, nodes.Note{Title: title, Body: body}, testAuthor)
		return err
	})
	if err != nil {
		t.Fatalf("createTestNote(%q): %v", title, err)
	}
	return id
}

// insertNotePath inserts a row into note_paths linking a node UUID to a path.
func insertNotePath(t *testing.T, g *graph.Graph, ctx context.Context, nodeID, path string) {
	t.Helper()
	err := g.DoWrite(ctx, func(tx *graph.WriteTx) error {
		_, err := tx.Exec(
			`INSERT INTO note_paths (uuid, path) VALUES (?, ?)`,
			nodeID, path,
		)
		return err
	})
	if err != nil {
		t.Fatalf("insertNotePath(%q, %q): %v", nodeID, path, err)
	}
}

// countDanglingForSrc returns how many dangling_links rows exist for a given source.
func countDanglingForSrc(t *testing.T, g *graph.Graph, ctx context.Context, srcID string) int {
	t.Helper()
	var count int
	if err := g.DoRead(ctx, func(tx *graph.ReadTx) error {
		return tx.QueryRow(`SELECT COUNT(*) FROM dangling_links WHERE src_node_id = ?`, srcID).Scan(&count)
	}); err != nil {
		t.Fatalf("countDanglingForSrc: %v", err)
	}
	return count
}

// countEdgesWithLabel returns how many edges with a given label exist between src and dst.
func countEdgesWithLabel(t *testing.T, g *graph.Graph, ctx context.Context, srcID, dstID, label string) int {
	t.Helper()
	var count int
	if err := g.DoRead(ctx, func(tx *graph.ReadTx) error {
		return tx.QueryRow(
			`SELECT COUNT(*) FROM edges WHERE src = ? AND dst = ? AND label = ?`,
			srcID, dstID, label,
		).Scan(&count)
	}); err != nil {
		t.Fatalf("countEdgesWithLabel: %v", err)
	}
	return count
}

// ---------------------------------------------------------------------------
// Resolve tests
// ---------------------------------------------------------------------------

// TestResolveIsIdempotent verifies that re-indexing the same body does not
// accumulate duplicate links_to edges (regression for the edge-duplication bug
// where every note edit inserted a fresh edge without clearing the old one).
func TestResolveIsIdempotent(t *testing.T) {
	ctx := context.Background()
	g := testutil.NewInMemoryTestGraph(t)

	srcID := createTestNote(t, g, ctx, "Source", "body")
	dstID := createTestNote(t, g, ctx, "Destination", "body")

	r := &Resolver{}
	body := "See [[" + dstID + "|Dest]]."
	for i := 0; i < 3; i++ {
		if _, err := r.Resolve(ctx, g, srcID, body); err != nil {
			t.Fatalf("Resolve (pass %d): %v", i, err)
		}
	}

	if n := countEdgesWithLabel(t, g, ctx, srcID, dstID, "links_to"); n != 1 {
		t.Errorf("expected exactly 1 links_to edge after 3 re-indexes, got %d", n)
	}
}

// TestResolveClearsEdgesWhenLinksRemoved verifies that re-indexing a body with
// no wikilinks removes the source's previously resolved edges (and dangling rows).
func TestResolveClearsEdgesWhenLinksRemoved(t *testing.T) {
	ctx := context.Background()
	g := testutil.NewInMemoryTestGraph(t)

	srcID := createTestNote(t, g, ctx, "Source", "body")
	dstID := createTestNote(t, g, ctx, "Destination", "body")

	r := &Resolver{}
	if _, err := r.Resolve(ctx, g, srcID, "See [["+dstID+"|Dest]]."); err != nil {
		t.Fatalf("Resolve (with link): %v", err)
	}
	if n := countEdgesWithLabel(t, g, ctx, srcID, dstID, "links_to"); n != 1 {
		t.Fatalf("setup: expected 1 edge, got %d", n)
	}

	// Re-index with the link removed.
	if _, err := r.Resolve(ctx, g, srcID, "no links here anymore"); err != nil {
		t.Fatalf("Resolve (links removed): %v", err)
	}
	if n := countEdgesWithLabel(t, g, ctx, srcID, dstID, "links_to"); n != 0 {
		t.Errorf("expected 0 links_to edges after removing the link, got %d", n)
	}
}

// TestResolveUUIDTarget verifies that a UUID wikilink target resolves directly to an edge.
func TestResolveUUIDTarget(t *testing.T) {
	ctx := context.Background()
	g := testutil.NewInMemoryTestGraph(t)

	srcID := createTestNote(t, g, ctx, "Source", "body")
	dstID := createTestNote(t, g, ctx, "Destination", "body")

	r := &Resolver{}
	outcomes, err := r.Resolve(ctx, g, srcID, "See [["+dstID+"|Dest]].")
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}

	if len(outcomes) != 1 {
		t.Fatalf("expected 1 outcome, got %d", len(outcomes))
	}
	if !outcomes[0].Resolved {
		t.Error("expected Resolved=true for UUID target")
	}
	if outcomes[0].ResolvedBy != "uuid" {
		t.Errorf("expected ResolvedBy='uuid', got %q", outcomes[0].ResolvedBy)
	}
	if outcomes[0].EdgeID == "" {
		t.Error("expected non-empty EdgeID")
	}
	if n := countEdgesWithLabel(t, g, ctx, srcID, dstID, "links_to"); n != 1 {
		t.Errorf("expected 1 links_to edge, got %d", n)
	}
}

// TestResolveStemViaNotePaths verifies stem resolution via the note_paths table.
func TestResolveStemViaNotePaths(t *testing.T) {
	ctx := context.Background()
	g := testutil.NewInMemoryTestGraph(t)

	srcID := createTestNote(t, g, ctx, "Source", "body")
	dstID := createTestNote(t, g, ctx, "Roadmap", "body")
	insertNotePath(t, g, ctx, dstID, "Roadmap.md")

	r := &Resolver{}
	outcomes, err := r.Resolve(ctx, g, srcID, "See [[Roadmap]].")
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}

	if len(outcomes) != 1 {
		t.Fatalf("expected 1 outcome, got %d", len(outcomes))
	}
	if !outcomes[0].Resolved {
		t.Error("expected Resolved=true")
	}
	if outcomes[0].ResolvedBy != "stem" {
		t.Errorf("expected ResolvedBy='stem', got %q", outcomes[0].ResolvedBy)
	}
	if n := countEdgesWithLabel(t, g, ctx, srcID, dstID, "links_to"); n != 1 {
		t.Errorf("expected 1 links_to edge, got %d", n)
	}
}

// TestResolveTitleFallback verifies stem→title fallback when note_paths has no match.
func TestResolveTitleFallback(t *testing.T) {
	ctx := context.Background()
	g := testutil.NewInMemoryTestGraph(t)

	srcID := createTestNote(t, g, ctx, "Source", "body")
	// Note with title "Roadmap" but NOT in note_paths.
	dstID := createTestNote(t, g, ctx, "Roadmap", "body")

	r := &Resolver{}
	outcomes, err := r.Resolve(ctx, g, srcID, "See [[Roadmap]].")
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}

	if len(outcomes) != 1 {
		t.Fatalf("expected 1 outcome, got %d", len(outcomes))
	}
	if !outcomes[0].Resolved {
		t.Error("expected Resolved=true via title fallback")
	}
	if outcomes[0].ResolvedBy != "title" {
		t.Errorf("expected ResolvedBy='title', got %q", outcomes[0].ResolvedBy)
	}
	if n := countEdgesWithLabel(t, g, ctx, srcID, dstID, "links_to"); n != 1 {
		t.Errorf("expected 1 links_to edge, got %d", n)
	}
}

// TestResolveUnresolved_AE3 verifies that an unresolved link creates exactly one
// dangling_links row and no node or edge (AE3).
func TestResolveUnresolved_AE3(t *testing.T) {
	ctx := context.Background()
	g := testutil.NewInMemoryTestGraph(t)

	srcID := createTestNote(t, g, ctx, "Source", "body")

	r := &Resolver{}
	outcomes, err := r.Resolve(ctx, g, srcID, "See [[Roadmap]].")
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}

	if len(outcomes) != 1 {
		t.Fatalf("expected 1 outcome, got %d", len(outcomes))
	}
	if outcomes[0].Resolved {
		t.Error("expected Resolved=false for unresolved target")
	}

	// Exactly one dangling row, no edges, no phantom node.
	if n := countDanglingForSrc(t, g, ctx, srcID); n != 1 {
		t.Errorf("expected 1 dangling row, got %d", n)
	}

	// No edge created.
	var edgeCount int
	if err := g.DoRead(ctx, func(tx *graph.ReadTx) error {
		return tx.QueryRow(`SELECT COUNT(*) FROM edges WHERE src = ?`, srcID).Scan(&edgeCount)
	}); err != nil {
		t.Fatalf("count edges: %v", err)
	}
	if edgeCount != 0 {
		t.Errorf("expected 0 edges, got %d", edgeCount)
	}

	// No phantom node named "Roadmap" (besides source).
	var nodeCount int
	if err := g.DoRead(ctx, func(tx *graph.ReadTx) error {
		return tx.QueryRow(
			`SELECT COUNT(*) FROM nodes WHERE title = 'Roadmap'`,
		).Scan(&nodeCount)
	}); err != nil {
		t.Fatalf("count nodes: %v", err)
	}
	if nodeCount != 0 {
		t.Errorf("expected 0 phantom 'Roadmap' nodes, got %d", nodeCount)
	}
}

// TestResolveSelfLink verifies that a self-referencing link produces no edge.
func TestResolveSelfLink(t *testing.T) {
	ctx := context.Background()
	g := testutil.NewInMemoryTestGraph(t)

	// Create a note and an entry in note_paths so the UUID-less self-link resolves.
	srcID := createTestNote(t, g, ctx, "Source", "body")
	insertNotePath(t, g, ctx, srcID, "Source.md")

	r := &Resolver{}
	outcomes, err := r.Resolve(ctx, g, srcID, "Self-ref [[Source]].")
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}

	if len(outcomes) != 1 {
		t.Fatalf("expected 1 outcome, got %d", len(outcomes))
	}
	// Self-link is "resolved" (target found) but no edge created.
	if !outcomes[0].Resolved {
		t.Error("expected Resolved=true for self-link (target exists)")
	}
	if outcomes[0].EdgeID != "" {
		t.Errorf("expected no EdgeID for self-link, got %q", outcomes[0].EdgeID)
	}

	var edgeCount int
	if err := g.DoRead(ctx, func(tx *graph.ReadTx) error {
		return tx.QueryRow(`SELECT COUNT(*) FROM edges WHERE src = ?`, srcID).Scan(&edgeCount)
	}); err != nil {
		t.Fatalf("count edges: %v", err)
	}
	if edgeCount != 0 {
		t.Errorf("expected 0 edges for self-link, got %d", edgeCount)
	}
}

// TestResolveEdgeHasProvenance verifies that a resolved edge carries provenance attrs.
func TestResolveEdgeHasProvenance(t *testing.T) {
	ctx := context.Background()
	g := testutil.NewInMemoryTestGraph(t)

	srcID := createTestNote(t, g, ctx, "Source", "body")
	dstID := createTestNote(t, g, ctx, "Roadmap", "body")
	insertNotePath(t, g, ctx, dstID, "Roadmap.md")

	r := &Resolver{}
	outcomes, err := r.Resolve(ctx, g, srcID, "[[Roadmap]]")
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if len(outcomes) != 1 || !outcomes[0].Resolved {
		t.Fatalf("expected resolved outcome, got %+v", outcomes)
	}

	// Check edge attrs contain target_text and resolved_by.
	if err := g.DoRead(ctx, func(tx *graph.ReadTx) error {
		var attrsStr string
		if err := tx.QueryRow(`SELECT attrs FROM edges WHERE id = ?`, outcomes[0].EdgeID).Scan(&attrsStr); err != nil {
			return err
		}
		var attrs map[string]interface{}
		if err := json.Unmarshal([]byte(attrsStr), &attrs); err != nil {
			return err
		}
		if attrs["target_text"] != "Roadmap" {
			t.Errorf("expected target_text='Roadmap', got %v", attrs["target_text"])
		}
		if attrs["resolved_by"] != "stem" {
			t.Errorf("expected resolved_by='stem', got %v", attrs["resolved_by"])
		}
		return nil
	}); err != nil {
		t.Fatalf("read edge attrs: %v", err)
	}
}

// TestResolveReindexClearsDangling verifies that calling Resolve twice for the same
// source results in exactly one dangling row (re-indexing clears old rows first).
func TestResolveReindexClearsDangling(t *testing.T) {
	ctx := context.Background()
	g := testutil.NewInMemoryTestGraph(t)

	srcID := createTestNote(t, g, ctx, "Source", "body")

	r := &Resolver{}
	// First call - creates one dangling row.
	if _, err := r.Resolve(ctx, g, srcID, "[[Unresolved]]"); err != nil {
		t.Fatalf("first Resolve: %v", err)
	}
	// Second call - should delete the old row and insert a fresh one.
	if _, err := r.Resolve(ctx, g, srcID, "[[Unresolved]]"); err != nil {
		t.Fatalf("second Resolve: %v", err)
	}

	if n := countDanglingForSrc(t, g, ctx, srcID); n != 1 {
		t.Errorf("expected exactly 1 dangling row after re-index, got %d", n)
	}
}

// TestResolveMultipleUnresolved verifies multiple unresolved links each get a row.
func TestResolveMultipleUnresolved(t *testing.T) {
	ctx := context.Background()
	g := testutil.NewInMemoryTestGraph(t)

	srcID := createTestNote(t, g, ctx, "Source", "body")

	r := &Resolver{}
	outcomes, err := r.Resolve(ctx, g, srcID, "[[Alpha]] and [[Beta]] and [[Gamma]].")
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if len(outcomes) != 3 {
		t.Fatalf("expected 3 outcomes, got %d", len(outcomes))
	}
	for _, o := range outcomes {
		if o.Resolved {
			t.Errorf("expected Resolved=false for %q", o.Link.Target)
		}
	}
	if n := countDanglingForSrc(t, g, ctx, srcID); n != 3 {
		t.Errorf("expected 3 dangling rows, got %d", n)
	}
}

// ---------------------------------------------------------------------------
// PromoteDangling tests
// ---------------------------------------------------------------------------

// TestPromoteDangling_AE4 verifies that a dangling link is promoted to a real edge
// when the target note appears (AE4).
func TestPromoteDangling_AE4(t *testing.T) {
	ctx := context.Background()
	g := testutil.NewInMemoryTestGraph(t)

	srcID := createTestNote(t, g, ctx, "Source", "body")

	r := &Resolver{}
	// Insert dangling row for "Roadmap".
	if _, err := r.Resolve(ctx, g, srcID, "[[Roadmap]]"); err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if n := countDanglingForSrc(t, g, ctx, srcID); n != 1 {
		t.Fatalf("expected 1 dangling row before promote, got %d", n)
	}

	// Now "create" the Roadmap note.
	dstID := createTestNote(t, g, ctx, "Roadmap", "body")
	insertNotePath(t, g, ctx, dstID, "Roadmap.md")

	// Promote - stem match.
	promoted, err := PromoteDangling(ctx, g, dstID, PromoteKey{Key: "Roadmap"})
	if err != nil {
		t.Fatalf("PromoteDangling: %v", err)
	}
	if promoted != 1 {
		t.Errorf("expected promoted=1, got %d", promoted)
	}

	// Dangling row gone.
	if n := countDanglingForSrc(t, g, ctx, srcID); n != 0 {
		t.Errorf("expected 0 dangling rows after promote, got %d", n)
	}
	// Real edge exists.
	if n := countEdgesWithLabel(t, g, ctx, srcID, dstID, "links_to"); n != 1 {
		t.Errorf("expected 1 links_to edge after promote, got %d", n)
	}
}

// TestPromoteDangling_EdgeLabel verifies promoted edge has label "links_to".
func TestPromoteDangling_EdgeLabel(t *testing.T) {
	ctx := context.Background()
	g := testutil.NewInMemoryTestGraph(t)

	srcID := createTestNote(t, g, ctx, "Source", "body")
	r := &Resolver{}
	if _, err := r.Resolve(ctx, g, srcID, "[[Target]]"); err != nil {
		t.Fatalf("Resolve: %v", err)
	}

	dstID := createTestNote(t, g, ctx, "Target", "body")
	if _, err := PromoteDangling(ctx, g, dstID, PromoteKey{Key: "Target"}); err != nil {
		t.Fatalf("PromoteDangling: %v", err)
	}

	if err := g.DoRead(ctx, func(tx *graph.ReadTx) error {
		outgoing, err := edges.Outgoing(ctx, tx, srcID, edges.WithType(edges.EdgeTypeLinksTo))
		if err != nil {
			return err
		}
		if len(outgoing) != 1 {
			t.Errorf("expected 1 links_to edge, got %d", len(outgoing))
			return nil
		}
		if outgoing[0].Label != string(edges.EdgeTypeLinksTo) {
			t.Errorf("expected label 'links_to', got %q", outgoing[0].Label)
		}
		return nil
	}); err != nil {
		t.Fatalf("read edges: %v", err)
	}
}

// TestPromoteDangling_ProvenanceAttrs verifies promoted edge carries provenance attrs.
func TestPromoteDangling_ProvenanceAttrs(t *testing.T) {
	ctx := context.Background()
	g := testutil.NewInMemoryTestGraph(t)

	srcID := createTestNote(t, g, ctx, "Source", "body")
	r := &Resolver{}
	if _, err := r.Resolve(ctx, g, srcID, "[[Target]]"); err != nil {
		t.Fatalf("Resolve: %v", err)
	}

	dstID := createTestNote(t, g, ctx, "Target", "body")
	if _, err := PromoteDangling(ctx, g, dstID, PromoteKey{Key: "Target"}); err != nil {
		t.Fatalf("PromoteDangling: %v", err)
	}

	if err := g.DoRead(ctx, func(tx *graph.ReadTx) error {
		var attrsStr string
		return tx.QueryRow(`SELECT attrs FROM edges WHERE src = ? AND dst = ? AND label = 'links_to'`,
			srcID, dstID).Scan(&attrsStr)
	}); err != nil {
		t.Fatalf("read edge attrs: %v", err)
	}
}

// TestPromoteDangling_Idempotent verifies that calling PromoteDangling twice
// does not create duplicate edges (idempotency).
func TestPromoteDangling_Idempotent(t *testing.T) {
	ctx := context.Background()
	g := testutil.NewInMemoryTestGraph(t)

	srcID := createTestNote(t, g, ctx, "Source", "body")
	r := &Resolver{}
	if _, err := r.Resolve(ctx, g, srcID, "[[Target]]"); err != nil {
		t.Fatalf("Resolve: %v", err)
	}

	dstID := createTestNote(t, g, ctx, "Target", "body")
	if _, err := PromoteDangling(ctx, g, dstID, PromoteKey{Key: "Target"}); err != nil {
		t.Fatalf("first PromoteDangling: %v", err)
	}

	// Second call - dangling row already deleted, so nothing to promote.
	n, err := PromoteDangling(ctx, g, dstID, PromoteKey{Key: "Target"})
	if err != nil {
		t.Fatalf("second PromoteDangling: %v", err)
	}
	if n != 0 {
		t.Errorf("expected 0 promoted on second call, got %d", n)
	}

	// Still exactly one edge.
	if c := countEdgesWithLabel(t, g, ctx, srcID, dstID, "links_to"); c != 1 {
		t.Errorf("expected 1 edge after idempotent promote, got %d", c)
	}
}

// TestPromoteDangling_SelfLinkCleanedUp verifies that a self-link dangling row
// is removed without creating an edge.
func TestPromoteDangling_SelfLinkCleanedUp(t *testing.T) {
	ctx := context.Background()
	g := testutil.NewInMemoryTestGraph(t)

	// Create note. The note links to itself by title but no note_paths entry
	// exists yet, so the link is stored as dangling.
	noteID := createTestNote(t, g, ctx, "Self", "body")

	// Manually insert a dangling row (stored normalized) that points back to the same note.
	err := g.DoWrite(ctx, func(tx *graph.WriteTx) error {
		_, err := tx.Exec(
			`INSERT INTO dangling_links (id, src_node_id, target_key, target_kind) VALUES (?, ?, ?, ?)`,
			"dl-self-test", noteID, "self", "stem",
		)
		return err
	})
	if err != nil {
		t.Fatalf("insert self-dangling: %v", err)
	}

	// PromoteDangling is called for the note itself - self-link should be cleared.
	promoted, err := PromoteDangling(ctx, g, noteID, PromoteKey{Key: "Self"})
	if err != nil {
		t.Fatalf("PromoteDangling: %v", err)
	}
	if promoted != 0 {
		t.Errorf("expected 0 promoted edges for self-link, got %d", promoted)
	}

	// Dangling row should be gone.
	var count int
	if err := g.DoRead(ctx, func(tx *graph.ReadTx) error {
		return tx.QueryRow(`SELECT COUNT(*) FROM dangling_links WHERE id = 'dl-self-test'`).Scan(&count)
	}); err != nil {
		t.Fatalf("count dangling: %v", err)
	}
	if count != 0 {
		t.Errorf("expected self-dangling row to be deleted, got %d rows", count)
	}

	// No self-edge created.
	if n := countEdgesWithLabel(t, g, ctx, noteID, noteID, "links_to"); n != 0 {
		t.Errorf("expected no self-edge, got %d", n)
	}
}

// TestResolveIDCollisionStress verifies that inserting many dangling links in one
// transaction does not produce PRIMARY KEY collisions (guards against the
// time.Now().UnixNano() ID generator colliding in tight loops).
func TestResolveIDCollisionStress(t *testing.T) {
	ctx := context.Background()
	g := testutil.NewInMemoryTestGraph(t)

	srcID := createTestNote(t, g, ctx, "StressSource", "body")

	// 50 distinct unresolved targets in one body - all go into a single transaction.
	var linkParts []string
	for i := 0; i < 50; i++ {
		linkParts = append(linkParts, fmt.Sprintf("[[StressTarget%02d]]", i))
	}
	body := strings.Join(linkParts, " ")

	r := &Resolver{}
	for iter := 0; iter < 5; iter++ {
		outcomes, err := r.Resolve(ctx, g, srcID, body)
		if err != nil {
			t.Fatalf("iteration %d: Resolve failed: %v", iter, err)
		}
		if len(outcomes) != 50 {
			t.Fatalf("iteration %d: expected 50 outcomes, got %d", iter, len(outcomes))
		}
	}

	// After 5 re-indexes each producing 50 rows, only the last 50 should remain.
	if n := countDanglingForSrc(t, g, ctx, srcID); n != 50 {
		t.Errorf("expected 50 dangling rows, got %d", n)
	}
}

// TestStemCollisionTiebreak verifies deterministic tiebreak when two notes share the same stem.
// Per spec: oldest node id (lexicographic ascending) wins.
func TestStemCollisionTiebreak(t *testing.T) {
	ctx := context.Background()
	g := testutil.NewInMemoryTestGraph(t)

	srcID := createTestNote(t, g, ctx, "Source", "body")

	// Create two notes with the same title "Roadmap" but different IDs.
	// The resolver uses ORDER BY id ASC so the note with the smallest ID wins.
	dstID1 := createTestNote(t, g, ctx, "Roadmap", "first")
	dstID2 := createTestNote(t, g, ctx, "Roadmap", "second")

	// Neither has a note_paths entry - fallback to title lookup, which uses ORDER BY id ASC.
	r := &Resolver{}
	outcomes, err := r.Resolve(ctx, g, srcID, "[[Roadmap]]")
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if len(outcomes) != 1 {
		t.Fatalf("expected 1 outcome, got %d", len(outcomes))
	}
	if !outcomes[0].Resolved {
		t.Fatal("expected Resolved=true (title match)")
	}

	// Determine which ID is lexicographically smaller - that's the expected winner.
	expectedDst := dstID1
	if dstID2 < dstID1 {
		expectedDst = dstID2
	}

	if n := countEdgesWithLabel(t, g, ctx, srcID, expectedDst, "links_to"); n != 1 {
		t.Errorf("expected edge to lexicographically-first dst (%s), got none; outcomes: %+v", expectedDst, outcomes)
	}
}

// TestResolveUUIDTargetToNonNoteNode confirms that a [[<uuid>|Alias]] link
// resolves to a NON-note node (here a bookmark) through the KindUUID path, and
// that the alias does not interfere with resolution. This is the editor's
// "link to any entity by uuid" contract.
func TestResolveUUIDTargetToNonNoteNode(t *testing.T) {
	ctx := context.Background()
	g := testutil.NewInMemoryTestGraph(t)

	srcID := createTestNote(t, g, ctx, "Source", "body")

	var bookmarkID string
	if err := g.DoWrite(ctx, func(tx *graph.WriteTx) error {
		var err error
		bookmarkID, err = nodes.CreateBookmark(ctx, tx, nodes.Bookmark{
			URL:   "https://example.com",
			Title: "My Bookmark",
		}, testAuthor)
		return err
	}); err != nil {
		t.Fatalf("CreateBookmark: %v", err)
	}

	r := &Resolver{}
	outcomes, err := r.Resolve(ctx, g, srcID, "See [["+bookmarkID+"|My Bookmark]].")
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}

	if len(outcomes) != 1 {
		t.Fatalf("expected 1 outcome, got %d", len(outcomes))
	}
	if !outcomes[0].Resolved {
		t.Fatalf("expected Resolved=true for uuid link to bookmark, got %+v", outcomes[0])
	}
	if outcomes[0].ResolvedBy != "uuid" {
		t.Errorf("expected ResolvedBy='uuid', got %q", outcomes[0].ResolvedBy)
	}
	if n := countEdgesWithLabel(t, g, ctx, srcID, bookmarkID, "links_to"); n != 1 {
		t.Errorf("expected 1 links_to edge note->bookmark, got %d", n)
	}
}

// ---------------------------------------------------------------------------
// Obsidian resolution rules tests (hou-oc5.19)
// ---------------------------------------------------------------------------

// TestResolveNestedTwoFoldersDeep verifies a bare [[Name]] resolves to a note
// stored two folders down, without regard to case.
func TestResolveNestedTwoFoldersDeep(t *testing.T) {
	ctx := context.Background()
	g := testutil.NewInMemoryTestGraph(t)

	srcID := createTestNote(t, g, ctx, "Source", "body")
	dstID := createTestNote(t, g, ctx, "Different Title", "body")
	insertNotePath(t, g, ctx, dstID, "area/project/DeepNote.md")

	r := &Resolver{}
	outcomes, err := r.Resolve(ctx, g, srcID, "See [[deepnote]].")
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if len(outcomes) != 1 || !outcomes[0].Resolved || outcomes[0].ResolvedBy != "stem" {
		t.Fatalf("expected stem resolution, got %+v", outcomes)
	}
	if n := countEdgesWithLabel(t, g, ctx, srcID, dstID, "links_to"); n != 1 {
		t.Errorf("expected 1 edge to nested note, got %d", n)
	}
}

// TestResolveCandidateTiebreak_ShorterThenAlphabetical verifies that when
// multiple files share a basename, the shortest relative path wins and ties
// of equal path length are broken alphabetically.
func TestResolveCandidateTiebreak_ShorterThenAlphabetical(t *testing.T) {
	ctx := context.Background()
	g := testutil.NewInMemoryTestGraph(t)

	srcID := createTestNote(t, g, ctx, "Source", "body")
	deepID := createTestNote(t, g, ctx, "Deep", "body")
	shortID := createTestNote(t, g, ctx, "Short", "body")
	insertNotePath(t, g, ctx, deepID, "alpha/beta/Shared.md")
	insertNotePath(t, g, ctx, shortID, "z/Shared.md")

	r := &Resolver{}
	if _, err := r.Resolve(ctx, g, srcID, "See [[Shared]]."); err != nil {
		t.Fatalf("Resolve (shorter): %v", err)
	}
	if n := countEdgesWithLabel(t, g, ctx, srcID, shortID, "links_to"); n != 1 {
		t.Errorf("expected shorter path z/Shared.md to win, got edges=%d", n)
	}
	if n := countEdgesWithLabel(t, g, ctx, srcID, deepID, "links_to"); n != 0 {
		t.Errorf("expected deeper path alpha/beta/Shared.md to lose, got edges=%d", n)
	}

	// Equal-length paths: alphabetical order breaks the tie (a/Tie.md beats b/Tie.md).
	bID := createTestNote(t, g, ctx, "B", "body")
	aID := createTestNote(t, g, ctx, "A", "body")
	insertNotePath(t, g, ctx, bID, "b/Tie.md")
	insertNotePath(t, g, ctx, aID, "a/Tie.md")

	if _, err := r.Resolve(ctx, g, srcID, "See [[Tie]]."); err != nil {
		t.Fatalf("Resolve (alpha tie): %v", err)
	}
	if n := countEdgesWithLabel(t, g, ctx, srcID, aID, "links_to"); n != 1 {
		t.Errorf("expected a/Tie.md to win alphabetical tie, got edges=%d", n)
	}
	if n := countEdgesWithLabel(t, g, ctx, srcID, bID, "links_to"); n != 0 {
		t.Errorf("expected b/Tie.md to lose alphabetical tie, got edges=%d", n)
	}
}

// TestResolveHeadingAndBlockAnchors verifies [[Note#Heading]] and [[Note#^block]]
// resolve to Note, [[#Heading]] and [[^block]] make nothing, and [[Note#A]] +
// [[Note#B]] deduplicate to a single edge (and a single dangling row when absent).
func TestResolveHeadingAndBlockAnchors(t *testing.T) {
	ctx := context.Background()
	g := testutil.NewInMemoryTestGraph(t)

	srcID := createTestNote(t, g, ctx, "Source", "body")
	dstID := createTestNote(t, g, ctx, "Note", "body")
	insertNotePath(t, g, ctx, dstID, "sub/Note.md")

	r := &Resolver{}
	outcomes, err := r.Resolve(ctx, g, srcID, "See [[Note#Heading]], [[Note#^blk1]], [[#Local]], and [[^localblk]].")
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if len(outcomes) != 1 || !outcomes[0].Resolved {
		t.Fatalf("expected 1 resolved deduplicated outcome, got %+v", outcomes)
	}
	if n := countEdgesWithLabel(t, g, ctx, srcID, dstID, "links_to"); n != 1 {
		t.Errorf("expected 1 edge for [[Note#Heading]] + [[Note#^blk1]], got %d", n)
	}
	if n := countDanglingForSrc(t, g, ctx, srcID); n != 0 {
		t.Errorf("expected 0 dangling rows for anchor-only links, got %d", n)
	}

	// Explicit [[Note#A]] and [[Note#B]] deduplication: resolved and dangling.
	if _, err := r.Resolve(ctx, g, srcID, "[[Note#A]] and [[Note#B]]"); err != nil {
		t.Fatalf("Resolve (dedup resolved): %v", err)
	}
	if n := countEdgesWithLabel(t, g, ctx, srcID, dstID, "links_to"); n != 1 {
		t.Errorf("expected 1 edge for [[Note#A]] and [[Note#B]], got %d", n)
	}

	if _, err := r.Resolve(ctx, g, srcID, "[[Missing#A]] and [[Missing#B]]"); err != nil {
		t.Fatalf("Resolve (dedup dangling): %v", err)
	}
	if n := countDanglingForSrc(t, g, ctx, srcID); n != 1 {
		t.Errorf("expected 1 dangling row for [[Missing#A]] and [[Missing#B]], got %d", n)
	}
	var storedKey string
	if err := g.DoRead(ctx, func(tx *graph.ReadTx) error {
		return tx.QueryRow(`SELECT target_key FROM dangling_links WHERE src_node_id = ?`, srcID).Scan(&storedKey)
	}); err != nil {
		t.Fatalf("read dangling key: %v", err)
	}
	if storedKey != "missing" {
		t.Errorf("dangling target_key = %q, want %q", storedKey, "missing")
	}

	// Anchor-only links alone create nothing at all.
	outcomes, err = r.Resolve(ctx, g, srcID, "Only [[#Heading]] and [[^block]].")
	if err != nil {
		t.Fatalf("Resolve (anchor only): %v", err)
	}
	if len(outcomes) != 0 {
		t.Errorf("expected 0 outcomes for anchor-only links, got %+v", outcomes)
	}
	if n := countDanglingForSrc(t, g, ctx, srcID); n != 0 {
		t.Errorf("expected 0 dangling rows for anchor-only links, got %d", n)
	}
}

// TestResolveEmbedsAndNonNoteExtensionsMakeNoEdge verifies ![[image.png]] and
// [[report.pdf]] produce neither edges nor dangling rows.
func TestResolveEmbedsAndNonNoteExtensionsMakeNoEdge(t *testing.T) {
	ctx := context.Background()
	g := testutil.NewInMemoryTestGraph(t)

	srcID := createTestNote(t, g, ctx, "Source", "body")
	imgNoteID := createTestNote(t, g, ctx, "image.png", "body")
	insertNotePath(t, g, ctx, imgNoteID, "image.png.md")
	pdfNoteID := createTestNote(t, g, ctx, "report.pdf", "body")
	insertNotePath(t, g, ctx, pdfNoteID, "report.pdf.md")
	otherID := createTestNote(t, g, ctx, "Embedded", "body")
	insertNotePath(t, g, ctx, otherID, "Embedded.md")

	r := &Resolver{}
	outcomes, err := r.Resolve(ctx, g, srcID, "![[image.png]] and [[report.pdf]] and ![[Embedded]]")
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if len(outcomes) != 0 {
		t.Errorf("expected 0 outcomes, got %+v", outcomes)
	}
	if n := countDanglingForSrc(t, g, ctx, srcID); n != 0 {
		t.Errorf("expected 0 dangling rows, got %d", n)
	}
	var edgeCount int
	if err := g.DoRead(ctx, func(tx *graph.ReadTx) error {
		return tx.QueryRow(`SELECT COUNT(*) FROM edges WHERE src = ?`, srcID).Scan(&edgeCount)
	}); err != nil {
		t.Fatalf("count edges: %v", err)
	}
	if edgeCount != 0 {
		t.Errorf("expected 0 edges, got %d", edgeCount)
	}
}

// TestResolveDottedNamesCaretsAndExplicitMdExtension verifies [[v1.2]],
// [[2026.11.25]], [[2^n]], and [[a/b.md]] all resolve cleanly.
func TestResolveDottedNamesCaretsAndExplicitMdExtension(t *testing.T) {
	ctx := context.Background()
	g := testutil.NewInMemoryTestGraph(t)

	srcID := createTestNote(t, g, ctx, "Source", "body")
	vID := createTestNote(t, g, ctx, "Release v1.2", "body")
	insertNotePath(t, g, ctx, vID, "releases/v1.2.md")
	dateID := createTestNote(t, g, ctx, "Daily", "body")
	insertNotePath(t, g, ctx, dateID, "daily/2026.11.25.md")
	powID := createTestNote(t, g, ctx, "2^n", "body")
	insertNotePath(t, g, ctx, powID, "math/2^n.md")
	abID := createTestNote(t, g, ctx, "B", "body")
	insertNotePath(t, g, ctx, abID, "a/b.md")

	r := &Resolver{}
	outcomes, err := r.Resolve(ctx, g, srcID, "See [[v1.2]], [[2026.11.25]], [[2^n]], and [[a/b.md]].")
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if len(outcomes) != 4 {
		t.Fatalf("expected 4 outcomes, got %d: %+v", len(outcomes), outcomes)
	}
	for _, dst := range []string{vID, dateID, powID, abID} {
		if n := countEdgesWithLabel(t, g, ctx, srcID, dst, "links_to"); n != 1 {
			t.Errorf("expected 1 edge to %s, got %d", dst, n)
		}
	}
}

// TestResolveUUIDWithNoNodeFallsThrough verifies a UUID-shaped target that does
// not match any live node falls through to path/stem/title lookup (or becomes a
// dangling row instead of erroring on edge creation).
func TestResolveUUIDWithNoNodeFallsThrough(t *testing.T) {
	ctx := context.Background()
	g := testutil.NewInMemoryTestGraph(t)

	srcID := createTestNote(t, g, ctx, "Source", "body")

	// Case 1: UUID-shaped target matches a note's filename, not its node ID.
	const fakeUUID = "11111111-2222-3333-4444-555555555555"
	noteID := createTestNote(t, g, ctx, "Named By UUID", "body")
	insertNotePath(t, g, ctx, noteID, "archive/"+fakeUUID+".md")

	// Case 2: UUID-shaped target matches nothing anywhere -> becomes dangling.
	const absentUUID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"

	r := &Resolver{}
	outcomes, err := r.Resolve(ctx, g, srcID, "See [["+fakeUUID+"]] and [["+absentUUID+"]].")
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if len(outcomes) != 2 {
		t.Fatalf("expected 2 outcomes, got %d: %+v", len(outcomes), outcomes)
	}
	if !outcomes[0].Resolved || outcomes[0].ResolvedBy != "stem" {
		t.Errorf("expected UUID target with no node to fall through to stem, got %+v", outcomes[0])
	}
	if n := countEdgesWithLabel(t, g, ctx, srcID, noteID, "links_to"); n != 1 {
		t.Errorf("expected 1 edge to note matched by filename, got %d", n)
	}
	if outcomes[1].Resolved {
		t.Errorf("expected absent UUID to remain dangling, got %+v", outcomes[1])
	}
	if n := countDanglingForSrc(t, g, ctx, srcID); n != 1 {
		t.Errorf("expected 1 dangling row for absent UUID, got %d", n)
	}
}

// TestPromoteDangling_MultipleSpellingsLeaveOneEdgeAndNoDangling verifies that
// a source holding both [[Note]] and [[sub/note]] as dangling links ends up
// with exactly one edge and zero dangling rows when sub/note.md appears.
func TestPromoteDangling_MultipleSpellingsLeaveOneEdgeAndNoDangling(t *testing.T) {
	ctx := context.Background()
	g := testutil.NewInMemoryTestGraph(t)

	srcID := createTestNote(t, g, ctx, "Source", "body")
	r := &Resolver{}
	if _, err := r.Resolve(ctx, g, srcID, "See [[Note]] and [[sub/note]]."); err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if n := countDanglingForSrc(t, g, ctx, srcID); n != 2 {
		t.Fatalf("expected 2 dangling rows before promote, got %d", n)
	}

	dstID := createTestNote(t, g, ctx, "Note", "body")
	insertNotePath(t, g, ctx, dstID, "sub/note.md")

	promoted, err := PromoteDangling(ctx, g, dstID,
		PromoteKey{Key: "note"},
		PromoteKey{Key: "sub/note"},
		PromoteKey{Key: dstID},
	)
	if err != nil {
		t.Fatalf("PromoteDangling: %v", err)
	}
	if promoted != 1 {
		t.Errorf("expected promoted=1, got %d", promoted)
	}
	if n := countEdgesWithLabel(t, g, ctx, srcID, dstID, "links_to"); n != 1 {
		t.Errorf("expected exactly 1 links_to edge, got %d", n)
	}
	if n := countDanglingForSrc(t, g, ctx, srcID); n != 0 {
		t.Errorf("expected 0 remaining dangling rows, got %d", n)
	}
}
