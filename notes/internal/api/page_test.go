package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"testing"

	"github.com/gabrielassisxyz/houston/notes/internal/graph"
)

func TestParsePage(t *testing.T) {
	for query, want := range map[string]page{
		"":                  {},
		"limit=10":          {set: true, limit: 10},
		"limit=500":         {set: true, limit: 500},
		"offset=40":         {set: true, limit: 500, offset: 40},
		"limit=1&offset=0":  {set: true, limit: 1},
		"limit=25&offset=5": {set: true, limit: 25, offset: 5},
	} {
		q, _ := url.ParseQuery(query)
		got, err := parsePage(q)
		if err != nil || got != want {
			t.Errorf("parsePage(%q) = %+v, %v; want %+v", query, got, err, want)
		}
	}
	for _, query := range []string{"limit=0", "limit=501", "limit=-1", "limit=", "limit=ten", "offset=-1", "offset=", "offset=x", "limit=5&offset=-1"} {
		q, _ := url.ParseQuery(query)
		if _, err := parsePage(q); err == nil {
			t.Errorf("parsePage(%q) accepted an invalid page", query)
		}
	}
}

// pagedRoute is one bulk listing: how to seed n items in a scrambled order,
// and how to read the keys of an answer in the order it lists them.
type pagedRoute struct {
	path string
	seed func(t *testing.T, d Deps, n int)
	keys func(t *testing.T, body []byte) []string
}

func seedSQL(t *testing.T, g *graph.Graph, stmts func(i int) []string, n int) {
	t.Helper()
	if err := g.DoWrite(context.Background(), func(tx *graph.WriteTx) error {
		// Inserted backwards, so an answer in insertion order fails the order checks.
		for i := n - 1; i >= 0; i-- {
			for _, stmt := range stmts(i) {
				if _, err := tx.Exec(stmt); err != nil {
					return fmt.Errorf("%s: %w", stmt, err)
				}
			}
		}
		return nil
	}); err != nil {
		t.Fatalf("seed: %v", err)
	}
}

func decodeKeys[T any](t *testing.T, body []byte, key func(T) string) []string {
	t.Helper()
	var items []T
	if err := json.Unmarshal(body, &items); err != nil {
		t.Fatalf("decode %s: %v", body, err)
	}
	keys := make([]string, 0, len(items))
	for _, it := range items {
		keys = append(keys, key(it))
	}
	return keys
}

func pagedRoutes() []pagedRoute {
	return []pagedRoute{
		{
			path: "/api/nodes",
			seed: func(t *testing.T, d Deps, n int) {
				seedSQL(t, d.Graph, func(i int) []string {
					return []string{fmt.Sprintf(`INSERT INTO nodes(id, type, title) VALUES ('n%03d', 'note', 'Node %d')`, i, i)}
				}, n)
			},
			keys: func(t *testing.T, body []byte) []string {
				return decodeKeys(t, body, func(m map[string]any) string { return m["id"].(string) })
			},
		},
		{
			path: "/api/vault/notes",
			seed: func(t *testing.T, d Deps, n int) {
				seedSQL(t, d.Graph, func(i int) []string {
					return []string{
						fmt.Sprintf(`INSERT INTO nodes(id, type, title) VALUES ('v%03d', 'note', 'Vault %d')`, i, i),
						fmt.Sprintf(`INSERT INTO note_paths(uuid, path, content_hash) VALUES ('v%03d', 'notes/p%03d.md', 'h%d')`, i, i, i),
					}
				}, n)
			},
			keys: func(t *testing.T, body []byte) []string {
				return decodeKeys(t, body, func(m map[string]any) string { return m["path"].(string) })
			},
		},
		{
			path: "/api/vault/list",
			seed: func(t *testing.T, d Deps, n int) {
				for i := n - 1; i >= 0; i-- {
					// a/ and a-*.md: the walk lists a/ first, path order does not.
					rel := fmt.Sprintf("a-%03d.md", i)
					if i%2 == 0 {
						rel = fmt.Sprintf("a/%03d.md", i)
					}
					writeVaultFile(t, d.VaultRoot, rel, "note\n")
				}
			},
			keys: func(t *testing.T, body []byte) []string {
				var doc struct {
					Files []string `json:"files"`
				}
				if err := json.Unmarshal(body, &doc); err != nil {
					t.Fatalf("decode %s: %v", body, err)
				}
				return doc.Files
			},
		},
		{
			path: "/api/edges",
			seed: func(t *testing.T, d Deps, n int) {
				seedSQL(t, d.Graph, func(int) []string {
					return []string{
						`INSERT INTO nodes(id, type, title) VALUES ('hub', 'note', 'Hub')`,
						`INSERT INTO nodes(id, type, title) VALUES ('spoke', 'note', 'Spoke')`,
					}
				}, 1)
				seedSQL(t, d.Graph, func(i int) []string {
					return []string{fmt.Sprintf(`INSERT INTO edges(id, src, dst, label) VALUES ('e%03d', 'hub', 'spoke', 'links_to')`, i)}
				}, n)
			},
			keys: func(t *testing.T, body []byte) []string {
				return decodeKeys(t, body, func(m map[string]any) string { return m["id"].(string) })
			},
		},
	}
}

func get(mux *http.ServeMux, target string) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, httptest.NewRequest(http.MethodGet, target, nil))
	return w
}

// Each bulk route: whole and in its fixed order without parameters; a page
// with limit, with limit and offset, and with offset alone; 400 for an
// invalid page.
func TestBulkRoutesPageOnRequest(t *testing.T) {
	const n = 7
	for _, route := range pagedRoutes() {
		t.Run(route.path, func(t *testing.T) {
			d := newTestDeps(t, "")
			route.seed(t, d, n)
			mux := newTestRouter(t, d)

			read := func(query string) []string {
				t.Helper()
				target := route.path
				if query != "" {
					target += "?" + query
				}
				w := get(mux, target)
				if w.Code != http.StatusOK {
					t.Fatalf("GET %s = %d: %s", target, w.Code, w.Body.String())
				}
				return route.keys(t, w.Body.Bytes())
			}

			all := read("")
			if len(all) != n {
				t.Fatalf("whole listing has %d items, want %d: %v", len(all), n, all)
			}
			for i := 1; i < len(all); i++ {
				if all[i-1] >= all[i] {
					t.Fatalf("whole listing is not in ascending order: %v", all)
				}
			}
			for query, want := range map[string][]string{
				"limit=3":          all[:3],
				"limit=3&offset=3": all[3:6],
				"limit=3&offset=6": all[6:],
				"offset=5":         all[5:],
				"offset=7":         {},
			} {
				got := read(query)
				if len(got) == 0 && len(want) == 0 {
					continue
				}
				if !reflect.DeepEqual(got, want) {
					t.Errorf("%s = %v, want %v", query, got, want)
				}
			}
			for _, query := range []string{"limit=0", "limit=501", "offset=-1"} {
				if w := get(mux, route.path+"?"+query); w.Code != http.StatusBadRequest {
					t.Errorf("%s = %d, want 400: %s", query, w.Code, w.Body.String())
				}
			}
		})
	}
}

// offset alone pages by the largest limit, 500.
func TestBulkRouteOffsetAloneTakesTheLargestLimit(t *testing.T) {
	d := newTestDeps(t, "")
	seedSQL(t, d.Graph, func(i int) []string {
		return []string{fmt.Sprintf(`INSERT INTO nodes(id, type, title) VALUES ('n%04d', 'note', 'Node')`, i)}
	}, 520)
	w := get(newTestRouter(t, d), "/api/nodes?offset=10")
	if w.Code != http.StatusOK {
		t.Fatalf("GET = %d: %s", w.Code, w.Body.String())
	}
	keys := decodeKeys(t, w.Body.Bytes(), func(m map[string]any) string { return m["id"].(string) })
	if len(keys) != 500 || keys[0] != "n0010" || keys[499] != "n0509" {
		t.Errorf("offset=10 answered %d items from %v to %v, want 500 from n0010 to n0509", len(keys), keys[0], keys[len(keys)-1])
	}
}
