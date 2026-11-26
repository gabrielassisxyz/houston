package wikilink

import (
	"context"
	"strings"
	"testing"

	"github.com/gabrielassisxyz/houston/notes/internal/graph"
	"github.com/gabrielassisxyz/houston/notes/internal/graph/testutil"
)

// queryPlan returns the detail column of EXPLAIN QUERY PLAN for query.
func queryPlan(t *testing.T, g *graph.Graph, query string, args ...any) []string {
	t.Helper()
	var plan []string
	err := g.DoRead(context.Background(), func(tx *graph.ReadTx) error {
		rows, err := tx.Query("EXPLAIN QUERY PLAN "+query, args...)
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
	return plan
}

// Every link of a vault goes through these four lookups, so a lookup that
// reads a whole table makes the first index grow with notes times links: on
// 5,000 notes that was about twelve minutes. SQLite takes an expression index
// only when the query spells the expression exactly as the index does, so a
// harmless-looking edit to a query's text silently brings the scan back.
func TestResolverLookupsUseTheirIndexes(t *testing.T) {
	g := testutil.NewInMemoryTestGraph(t)

	cases := []struct {
		step  string
		query string
		args  []any
		index string
	}{
		{"1 node id", lookupByIDQuery, []any{"target"}, "idx_nodes_lower_id"},
		{"2 exact path", lookupByPathQuery, []any{"area/target.md", "area/target"}, "idx_note_paths_path_key"},
		{"3 bare filename", lookupByBaseKeyQuery, []any{"target", "/target.md", "/target.md"}, "idx_note_paths_base_key"},
		{"4 title", lookupByTitleQuery, []any{"target"}, "idx_nodes_lower_title"},
	}
	for _, c := range cases {
		t.Run(c.step, func(t *testing.T) {
			plan := queryPlan(t, g, c.query, c.args...)
			joined := strings.Join(plan, "\n")
			if !strings.Contains(joined, "INDEX "+c.index+" ") {
				t.Errorf("step %s does not use %s; plan:\n%s", c.step, c.index, joined)
			}
			for _, step := range plan {
				if strings.HasPrefix(step, "SCAN ") {
					t.Errorf("step %s scans a table (%q); plan:\n%s", c.step, step, joined)
				}
			}
		})
	}
}
