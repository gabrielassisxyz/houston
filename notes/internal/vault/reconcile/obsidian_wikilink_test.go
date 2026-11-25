package reconcile_test

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/gabrielassisxyz/houston/notes/internal/api"
	"github.com/gabrielassisxyz/houston/notes/internal/config"
	"github.com/gabrielassisxyz/houston/notes/internal/graph"
	"github.com/gabrielassisxyz/houston/notes/internal/graph/nodes"
	"github.com/gabrielassisxyz/houston/notes/internal/graph/testutil"
	"github.com/gabrielassisxyz/houston/notes/internal/vault"
	"github.com/gabrielassisxyz/houston/notes/internal/vault/frontmatter"
	"github.com/gabrielassisxyz/houston/notes/internal/vault/reconcile"
	"github.com/gabrielassisxyz/houston/notes/internal/vault/wikilink"
)

func danglingKeysForSrc(t *testing.T, g *graph.Graph, srcID string) []string {
	t.Helper()
	var keys []string
	if err := g.DoRead(context.Background(), func(tx *graph.ReadTx) error {
		rows, err := tx.Query(
			`SELECT target_key FROM dangling_links WHERE src_node_id = ? ORDER BY target_key ASC`,
			srcID,
		)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var k string
			if err := rows.Scan(&k); err != nil {
				return err
			}
			keys = append(keys, k)
		}
		return rows.Err()
	}); err != nil {
		t.Fatalf("danglingKeysForSrc(%q): %v", srcID, err)
	}
	return keys
}

// TestPostVaultFile_HealsDanglingLink verifies that a dangling wikilink heals
// when its target note is created through POST /api/vault/file — both when the
// service creates the node before the change event arrives (exercising OnChange
// promotion directly) and end-to-end through the live vault service watcher.
func TestPostVaultFile_HealsDanglingLink(t *testing.T) {
	t.Run("via OnChange after service pre-creates node", func(t *testing.T) {
		ctx := context.Background()
		g := testutil.NewInMemoryTestGraph(t)
		root := newVaultDir(t)
		rec := reconcile.New(g, root)

		// Source note links to a target that does not exist yet.
		srcPath := filepath.Join(root, "source.md")
		writeFile(t, srcPath, "---\nid: heal-src\ntitle: Source\n---\n\nSee [[ApiTarget#Overview]].\n")
		if err := rec.OnCreate(ctx, srcPath); err != nil {
			t.Fatalf("OnCreate source: %v", err)
		}
		if keys := danglingKeysForSrc(t, g, "heal-src"); len(keys) != 1 || keys[0] != "apitarget" {
			t.Fatalf("expected dangling key [apitarget], got %v", keys)
		}

		// Create the target note through POST /api/vault/file.
		mux := http.NewServeMux()
		if err := api.Register(mux, api.Deps{Graph: g, VaultRoot: root}); err != nil {
			t.Fatalf("api.Register: %v", err)
		}
		req := httptest.NewRequest(http.MethodPost, "/api/vault/file?path=sub/ApiTarget.md",
			bytes.NewBufferString("---\ntitle: API Target\n---\n\nCreated via HTTP.\n"))
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, req)
		if w.Code != http.StatusOK {
			t.Fatalf("POST /api/vault/file returned %d: %s", w.Code, w.Body.String())
		}

		targetPath := filepath.Join(root, "sub", "ApiTarget.md")
		raw, err := os.ReadFile(targetPath)
		if err != nil {
			t.Fatalf("ReadFile target: %v", err)
		}
		fm, err := frontmatter.Parse(raw)
		if err != nil || fm.ID == "" {
			t.Fatalf("target frontmatter id missing: fm=%+v err=%v", fm, err)
		}

		// Simulate the service creating the node (e.g. SetLinkState) before the
		// filesystem watcher delivers the write as a KindChange event.
		if err := reconcile.SetLinkState(ctx, g, root, targetPath, reconcile.LinkState{Channel: "api"}); err != nil {
			t.Fatalf("SetLinkState: %v", err)
		}

		// Watcher delivers OnChange (does not fall back to OnCreate because the
		// node already exists). Dangling link must still heal.
		if err := rec.OnChange(ctx, targetPath); err != nil {
			t.Fatalf("OnChange target: %v", err)
		}

		if n := edgeCount(t, g, "heal-src", fm.ID); n != 1 {
			t.Errorf("expected 1 links_to edge after OnChange, got %d", n)
		}
		if keys := danglingKeysForSrc(t, g, "heal-src"); len(keys) != 0 {
			t.Errorf("expected 0 dangling rows after heal, got %v", keys)
		}
	})

	t.Run("end-to-end with live vault service", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()

		root := newVaultDir(t)
		if err := os.MkdirAll(filepath.Join(root, "sub"), 0o755); err != nil {
			t.Fatalf("MkdirAll: %v", err)
		}
		dbPath := filepath.Join(t.TempDir(), "graph.db")
		g, err := graph.Open(ctx, graph.Config{Path: dbPath})
		if err != nil {
			t.Fatalf("graph.Open: %v", err)
		}
		t.Cleanup(func() { _ = g.Close() })

		// Seed source note before starting the service so ColdStart indexes it.
		writeFile(t, filepath.Join(root, "source.md"),
			"---\nid: e2e-heal-src\ntitle: Source\n---\n\nSee [[LiveTarget]].\n")

		svc := vault.New(g, config.VaultConfig{
			Root:             root,
			CoalesceWindowMs: 50,
			MoveWindowMs:     200,
		})
		if err := svc.Start(ctx); err != nil {
			t.Fatalf("svc.Start: %v", err)
		}
		t.Cleanup(svc.Stop)

		if keys := danglingKeysForSrc(t, g, "e2e-heal-src"); len(keys) != 1 || keys[0] != "livetarget" {
			t.Fatalf("expected dangling key [livetarget] after cold start, got %v", keys)
		}

		mux := http.NewServeMux()
		if err := api.Register(mux, api.Deps{Graph: g, VaultRoot: root}); err != nil {
			t.Fatalf("api.Register: %v", err)
		}
		req := httptest.NewRequest(http.MethodPost, "/api/vault/file?path=sub/LiveTarget.md",
			bytes.NewBufferString("---\ntitle: Live Target\n---\n\nHello.\n"))
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, req)
		if w.Code != http.StatusOK {
			t.Fatalf("POST /api/vault/file returned %d: %s", w.Code, w.Body.String())
		}

		raw, err := os.ReadFile(filepath.Join(root, "sub", "LiveTarget.md"))
		if err != nil {
			t.Fatalf("ReadFile: %v", err)
		}
		fm, err := frontmatter.Parse(raw)
		if err != nil || fm.ID == "" {
			t.Fatalf("parse target id: fm=%+v err=%v", fm, err)
		}

		deadline := time.Now().Add(5 * time.Second)
		for time.Now().Before(deadline) {
			if edgeCount(t, g, "e2e-heal-src", fm.ID) == 1 && len(danglingKeysForSrc(t, g, "e2e-heal-src")) == 0 {
				return
			}
			time.Sleep(25 * time.Millisecond)
		}
		t.Fatalf("dangling link did not heal after POST /api/vault/file: edges=%d dangling=%v",
			edgeCount(t, g, "e2e-heal-src", fm.ID), danglingKeysForSrc(t, g, "e2e-heal-src"))
	})
}

// TestOnCreate_TwoDanglingSpellingsLeaveOneEdgeAndNoDangling verifies that a
// source holding both [[Note]] and [[sub/note]] (both dangling) gets exactly
// one links_to edge and zero remaining dangling rows once sub/note.md arrives.
func TestOnCreate_TwoDanglingSpellingsLeaveOneEdgeAndNoDangling(t *testing.T) {
	ctx := context.Background()
	g := testutil.NewInMemoryTestGraph(t)
	root := newVaultDir(t)
	rec := reconcile.New(g, root)

	srcPath := filepath.Join(root, "index.md")
	writeFile(t, srcPath, "---\nid: multi-src\ntitle: Index\n---\n\nSee [[Note]] and [[sub/note]].\n")
	if err := rec.OnCreate(ctx, srcPath); err != nil {
		t.Fatalf("OnCreate index: %v", err)
	}
	if keys := danglingKeysForSrc(t, g, "multi-src"); len(keys) != 2 {
		t.Fatalf("expected 2 dangling rows before arrival, got %v", keys)
	}

	targetPath := filepath.Join(root, "sub", "note.md")
	writeFile(t, targetPath, "---\nid: multi-dst\ntitle: Note\n---\n\nTarget body.\n")
	if err := rec.OnCreate(ctx, targetPath); err != nil {
		t.Fatalf("OnCreate sub/note.md: %v", err)
	}

	if n := edgeCount(t, g, "multi-src", "multi-dst"); n != 1 {
		t.Errorf("expected exactly 1 links_to edge, got %d", n)
	}
	if keys := danglingKeysForSrc(t, g, "multi-src"); len(keys) != 0 {
		t.Errorf("expected 0 dangling rows remaining, got %v", keys)
	}
}

// TestDeleteAndReturn_OneDanglingRowAndOneEdge verifies that deleting a target
// note degrades each incoming edge into a single dangling row (not a stem row
// plus a title row), and bringing the target back restores exactly one edge,
// not two.
func TestDeleteAndReturn_OneDanglingRowAndOneEdge(t *testing.T) {
	ctx := context.Background()
	g := testutil.NewInMemoryTestGraph(t)
	root := newVaultDir(t)
	rec, clk := newTestReconcilerWithClock(g, root)

	targetPath := filepath.Join(root, "notes", "my-file.md")
	writeFile(t, targetPath, "---\nid: ret-target\ntitle: Different Display Title\n---\n\nBody.\n")
	srcPath := filepath.Join(root, "source.md")
	writeFile(t, srcPath, "---\nid: ret-src\ntitle: Source\n---\n\nSee [[Different Display Title#Intro]].\n")

	if err := rec.OnCreate(ctx, targetPath); err != nil {
		t.Fatalf("OnCreate target: %v", err)
	}
	if err := rec.OnCreate(ctx, srcPath); err != nil {
		t.Fatalf("OnCreate source: %v", err)
	}
	if n := edgeCount(t, g, "ret-src", "ret-target"); n != 1 {
		t.Fatalf("setup: expected 1 edge, got %d", n)
	}

	// Delete target and expire move window.
	if err := os.Remove(targetPath); err != nil {
		t.Fatalf("Remove: %v", err)
	}
	if err := rec.OnDelete(ctx, targetPath); err != nil {
		t.Fatalf("OnDelete: %v", err)
	}
	clk.Advance(2 * time.Second)
	if tombstoned, err := rec.FlushExpired(ctx); err != nil || tombstoned != 1 {
		t.Fatalf("FlushExpired = (%d, %v), want (1, nil)", tombstoned, err)
	}

	// Exactly ONE dangling row, normalized from attrs.target_text.
	keys := danglingKeysForSrc(t, g, "ret-src")
	if len(keys) != 1 || keys[0] != "different display title" {
		t.Fatalf("expected 1 dangling row [different display title], got %v", keys)
	}

	// Bring the target back -> revived, 1 edge (not 2), 0 dangling rows.
	writeFile(t, targetPath, "---\nid: ret-target\ntitle: Different Display Title\n---\n\nBody.\n")
	if err := rec.OnCreate(ctx, targetPath); err != nil {
		t.Fatalf("OnCreate (return): %v", err)
	}

	if n := edgeCount(t, g, "ret-src", "ret-target"); n != 1 {
		t.Errorf("expected exactly 1 edge on return, got %d", n)
	}
	if keys := danglingKeysForSrc(t, g, "ret-src"); len(keys) != 0 {
		t.Errorf("expected 0 dangling rows after return, got %v", keys)
	}
}

// TestDeleteQualifiedPath_DoesNotAttachToOtherFolder verifies that [[a/foo]]
// degrades to "a/foo" when a/foo.md is deleted (both on live delete and on
// cold start), so an unrelated b/foo.md cannot steal the link, while a/foo.md
// returning reclaims it.
func TestDeleteQualifiedPath_DoesNotAttachToOtherFolder(t *testing.T) {
	for _, mode := range []string{"live-delete", "coldstart-delete"} {
		t.Run(mode, func(t *testing.T) {
			ctx := context.Background()
			g := testutil.NewInMemoryTestGraph(t)
			root := newVaultDir(t)
			rec, clk := newTestReconcilerWithClock(g, root)

			pathA := filepath.Join(root, "a", "foo.md")
			writeFile(t, pathA, "---\nid: id-a-foo\ntitle: Foo\n---\n\nA's foo.\n")
			pathSrc := filepath.Join(root, "source.md")
			writeFile(t, pathSrc, "---\nid: id-src\ntitle: Source\n---\n\nSee [[a/foo]].\n")

			if err := rec.OnCreate(ctx, pathA); err != nil {
				t.Fatalf("OnCreate a/foo: %v", err)
			}
			if err := rec.OnCreate(ctx, pathSrc); err != nil {
				t.Fatalf("OnCreate source: %v", err)
			}
			if n := edgeCount(t, g, "id-src", "id-a-foo"); n != 1 {
				t.Fatalf("setup: expected 1 edge to a/foo, got %d", n)
			}

			// Delete a/foo.md.
			if err := os.Remove(pathA); err != nil {
				t.Fatalf("Remove a/foo: %v", err)
			}
			if mode == "live-delete" {
				if err := rec.OnDelete(ctx, pathA); err != nil {
					t.Fatalf("OnDelete a/foo: %v", err)
				}
				clk.Advance(2 * time.Second)
				if _, err := rec.FlushExpired(ctx); err != nil {
					t.Fatalf("FlushExpired: %v", err)
				}
			} else {
				rec2 := reconcile.New(g, root)
				if err := rec2.ColdStart(ctx); err != nil {
					t.Fatalf("ColdStart: %v", err)
				}
			}

			// Degraded dangling key must stay "a/foo", not "foo".
			keys := danglingKeysForSrc(t, g, "id-src")
			if len(keys) != 1 || keys[0] != "a/foo" {
				t.Fatalf("expected dangling key [a/foo], got %v", keys)
			}

			// Create unrelated b/foo.md with the same stem and title.
			pathB := filepath.Join(root, "b", "foo.md")
			writeFile(t, pathB, "---\nid: id-b-foo\ntitle: Foo\n---\n\nB's foo.\n")
			if err := rec.OnCreate(ctx, pathB); err != nil {
				t.Fatalf("OnCreate b/foo: %v", err)
			}

			if n := edgeCount(t, g, "id-src", "id-b-foo"); n != 0 {
				t.Errorf("[[a/foo]] must not attach to b/foo.md, got %d edges", n)
			}
			if keys := danglingKeysForSrc(t, g, "id-src"); len(keys) != 1 || keys[0] != "a/foo" {
				t.Errorf("dangling key [a/foo] must remain waiting, got %v", keys)
			}

			// When a/foo.md returns, the link heals back to a/foo.
			writeFile(t, pathA, "---\nid: id-a-foo\ntitle: Foo\n---\n\nA's foo returns.\n")
			if err := rec.OnCreate(ctx, pathA); err != nil {
				t.Fatalf("OnCreate a/foo return: %v", err)
			}
			if n := edgeCount(t, g, "id-src", "id-a-foo"); n != 1 {
				t.Errorf("expected 1 edge back to a/foo after return, got %d", n)
			}
			if keys := danglingKeysForSrc(t, g, "id-src"); len(keys) != 0 {
				t.Errorf("expected 0 dangling rows after a/foo returns, got %v", keys)
			}
		})
	}
}

// TestDanglingByUUID_PromotesOnArrival verifies that danglingKeysFor offers the
// note's ID so a dangling UUID link heals when that note arrives.
func TestDanglingByUUID_PromotesOnArrival(t *testing.T) {
	ctx := context.Background()
	g := testutil.NewInMemoryTestGraph(t)
	root := newVaultDir(t)
	rec := reconcile.New(g, root)

	const targetUUID = "550e8400-e29b-41d4-a716-446655440000"
	srcPath := filepath.Join(root, "src.md")
	writeFile(t, srcPath, "---\nid: uuid-src\ntitle: Source\n---\n\nSee [["+targetUUID+"|Later]].\n")
	if err := rec.OnCreate(ctx, srcPath); err != nil {
		t.Fatalf("OnCreate src: %v", err)
	}
	if keys := danglingKeysForSrc(t, g, "uuid-src"); len(keys) != 1 || keys[0] != targetUUID {
		t.Fatalf("expected dangling UUID key, got %v", keys)
	}

	targetPath := filepath.Join(root, "sub", "unrelated-name.md")
	writeFile(t, targetPath, "---\nid: "+targetUUID+"\ntitle: Unrelated Title\n---\n\nBody.\n")
	if err := rec.OnCreate(ctx, targetPath); err != nil {
		t.Fatalf("OnCreate target: %v", err)
	}
	if n := edgeCount(t, g, "uuid-src", targetUUID); n != 1 {
		t.Errorf("expected 1 edge promoted via note id, got %d", n)
	}
	if keys := danglingKeysForSrc(t, g, "uuid-src"); len(keys) != 0 {
		t.Errorf("expected 0 dangling rows after UUID promotion, got %v", keys)
	}
}

// TestSoftDeleteDegradedKeyMatchesNormalizeTarget guards parity between
// nodes.SoftDeleteNoteTx's internal key normalization and wikilink.NormalizeTarget.
func TestSoftDeleteDegradedKeyMatchesNormalizeTarget(t *testing.T) {
	cases := []struct {
		name string
		raw  string
	}{
		{"heading_anchor", "Sub/MyNote.md#Heading"},
		{"backslash_block_anchor", "Sub\\MyNote.MD#^blk1"},
		{"caret_in_name", "2^n"},
		{"dotted_version", "v1.2"},
		{"uppercase_uuid", "550E8400-E29B-41D4-A716-446655440000"},
	}
	ctx := context.Background()
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			g := testutil.NewInMemoryTestGraph(t)
			srcID := "src"
			dstID := "dst"
			if err := g.DoWrite(ctx, func(tx *graph.WriteTx) error {
				if _, err := nodes.CreateNote(ctx, tx, nodes.Note{ID: srcID, Title: "Src"}, nodes.Author{Name: "test"}); err != nil {
					return err
				}
				if _, err := nodes.CreateNote(ctx, tx, nodes.Note{ID: dstID, Title: "Dst"}, nodes.Author{Name: "test"}); err != nil {
					return err
				}
				attrs := `{"target_text":` + `"` + escapeJSONString(tc.raw) + `","resolved_by":"stem"}`
				if _, err := tx.Exec(
					`INSERT INTO edges(id, src, dst, label, attrs) VALUES ('e1', ?, ?, 'links_to', ?)`,
					srcID, dstID, attrs,
				); err != nil {
					return err
				}
				return nodes.SoftDeleteNoteTx(ctx, tx, dstID, "fallback.md", "Dst", nodes.Author{Name: "test"})
			}); err != nil {
				t.Fatalf("case %q: %v", tc.raw, err)
			}
			got := danglingKeysForSrc(t, g, srcID)
			want := wikilink.NormalizeTarget(tc.raw)
			if len(got) != 1 || got[0] != want {
				t.Errorf("case %q: softDeleteNote stored %v, wikilink.NormalizeTarget = %q", tc.raw, got, want)
			}
		})
	}
}

func escapeJSONString(s string) string {
	var buf bytes.Buffer
	for i := 0; i < len(s); i++ {
		if s[i] == '\\' || s[i] == '"' {
			buf.WriteByte('\\')
		}
		buf.WriteByte(s[i])
	}
	return buf.String()
}
