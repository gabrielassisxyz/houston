package nodes

import (
	"context"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/gabrielassisxyz/houston/notes/internal/graph"
	"github.com/gabrielassisxyz/houston/notes/internal/graph/internal/migrate"
	"github.com/gabrielassisxyz/houston/notes/internal/graph/internal/sqlite"
	"github.com/gabrielassisxyz/houston/notes/internal/graph/schema"
)

// latestRevisionQuery is the lookup updateNode runs on every update; the
// index of migration 0010 exists for it.
const latestRevisionQuery = `SELECT id FROM revisions WHERE node_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`

// graph.Open applies 0010 after 0009 and leaves every version clean.
func TestOpenAppliesRevisionsIndexAfterNoteRefs(t *testing.T) {
	ctx := context.Background()
	g, err := graph.Open(ctx, graph.Config{Path: filepath.Join(t.TempDir(), "graph.db")})
	if err != nil {
		t.Fatalf("graph.Open: %v", err)
	}
	t.Cleanup(func() { _ = g.Close() })

	var versions []int
	var plan []string
	var indexTable string
	if err := g.DoRead(ctx, func(tx *graph.ReadTx) error {
		rows, err := tx.Query(`SELECT version FROM schema_migrations WHERE dirty = 0 ORDER BY version`)
		if err != nil {
			return err
		}
		for rows.Next() {
			var v int
			if err := rows.Scan(&v); err != nil {
				rows.Close()
				return err
			}
			versions = append(versions, v)
		}
		rows.Close()
		if err := tx.QueryRow(
			`SELECT tbl_name FROM sqlite_master WHERE type = 'index' AND name = 'idx_revisions_node_id'`,
		).Scan(&indexTable); err != nil {
			return err
		}
		planRows, err := tx.Query(`EXPLAIN QUERY PLAN `+latestRevisionQuery, "some-node")
		if err != nil {
			return err
		}
		defer planRows.Close()
		for planRows.Next() {
			var id, parent, notused int
			var detail string
			if err := planRows.Scan(&id, &parent, &notused, &detail); err != nil {
				return err
			}
			plan = append(plan, detail)
		}
		return planRows.Err()
	}); err != nil {
		t.Fatalf("reading the schema: %v", err)
	}

	want := []int{1, 2, 3, 4, 6, 7, 8, 9, 10}
	if !reflect.DeepEqual(versions, want) {
		t.Errorf("clean migrations = %v, want %v", versions, want)
	}
	if indexTable != "revisions" {
		t.Errorf("idx_revisions_node_id is on %q, want revisions", indexTable)
	}
	joined := strings.Join(plan, " | ")
	if !strings.Contains(joined, "idx_revisions_node_id") {
		t.Errorf("the newest-revision lookup does not use the index: %s", joined)
	}
	if strings.Contains(joined, "TEMP B-TREE") {
		t.Errorf("the newest-revision lookup still sorts: %s", joined)
	}
}

// 0010's down file drops the index, and the migration applies again after.
func TestRevisionsIndexMigrationGoesDownAndUp(t *testing.T) {
	ctx := context.Background()
	pool, err := sqlite.Open(sqlite.Config{Path: filepath.Join(t.TempDir(), "graph.db")})
	if err != nil {
		t.Fatalf("sqlite.Open: %v", err)
	}
	t.Cleanup(func() { _ = pool.Close() })
	runner, err := migrate.New(pool.Write, schema.FS)
	if err != nil {
		t.Fatalf("migrate.New: %v", err)
	}
	if err := runner.Up(ctx); err != nil {
		t.Fatalf("Up: %v", err)
	}

	indexed := func() bool {
		var n int
		if err := pool.Write.QueryRowContext(ctx,
			`SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'idx_revisions_node_id'`,
		).Scan(&n); err != nil {
			t.Fatalf("reading sqlite_master: %v", err)
		}
		return n == 1
	}
	if !indexed() {
		t.Fatal("index missing after Up")
	}

	if err := runner.Down(ctx); err != nil {
		t.Fatalf("Down: %v", err)
	}
	if ver, _, err := runner.Current(ctx); err != nil || ver != 9 {
		t.Fatalf("version after Down = %d (err %v), want 9", ver, err)
	}
	if indexed() {
		t.Error("index still present after Down")
	}

	if err := runner.Up(ctx); err != nil {
		t.Fatalf("Up again: %v", err)
	}
	if !indexed() {
		t.Error("index missing after Up again")
	}
}
