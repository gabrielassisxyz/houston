package wikilink

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/gabrielassisxyz/houston/notes/internal/graph"
	"github.com/gabrielassisxyz/houston/notes/internal/graph/edges"
	"github.com/gabrielassisxyz/houston/notes/internal/graph/nodes"
	"github.com/google/uuid"
)

// Resolver resolves wikilinks against a graph instance.
type Resolver struct{}

// ResolveOutcome describes what happened for a single link resolution.
type ResolveOutcome struct {
	Link       Link
	Resolved   bool
	EdgeID     string // set when resolved
	ResolvedBy string // "uuid", "stem", "title", or "" if dangling
}

// Resolve parses and resolves all wikilinks in body for the given source node.
// Resolved links become edges (label "links_to"); unresolved links are stored
// as dangling_links rows.
// Returns the outcomes for each link found.
func (r *Resolver) Resolve(ctx context.Context, g *graph.Graph, srcNodeID, body string) ([]ResolveOutcome, error) {
	var outcomes []ResolveOutcome
	err := g.DoWrite(ctx, func(tx *graph.WriteTx) error {
		var err error
		outcomes, err = resolveInTx(ctx, tx, srcNodeID, body)
		return err
	})
	if err != nil {
		return nil, err
	}
	return outcomes, nil
}

// ResolveInTx performs wikilink resolution inside a caller-supplied write tx.
// Callers that need single-transaction-per-event discipline should use this
// variant and supply the tx from their own g.DoWrite block.
func (r *Resolver) ResolveInTx(ctx context.Context, tx *graph.WriteTx, srcNodeID, body string) ([]ResolveOutcome, error) {
	return resolveInTx(ctx, tx, srcNodeID, body)
}

// resolveInTx is the inner implementation shared by Resolve and ResolveInTx.
func resolveInTx(ctx context.Context, tx *graph.WriteTx, srcNodeID, body string) ([]ResolveOutcome, error) {
	links := Parse(body)

	// Re-indexing rebuilds this source's complete outgoing link state, so clear
	// its stale rows first - both resolved links_to edges and unresolved dangling
	// links. This runs before the empty-body early return so that removing every
	// wikilink from a note also clears its old edges/dangling rows, and it makes
	// re-indexing idempotent (a repeated change does not duplicate edges).
	if _, err := tx.Exec(`DELETE FROM edges WHERE src = ? AND label = ?`, srcNodeID, string(edges.EdgeTypeLinksTo)); err != nil {
		return nil, fmt.Errorf("resolver: clear old edges: %w", err)
	}
	if _, err := tx.Exec(`DELETE FROM dangling_links WHERE src_node_id = ?`, srcNodeID); err != nil {
		return nil, fmt.Errorf("resolver: clear old dangling: %w", err)
	}

	if len(links) == 0 {
		return nil, nil
	}

	outcomes := make([]ResolveOutcome, 0, len(links))
	seenDst := make(map[string]struct{}, len(links))
	seenDangling := make(map[string]struct{}, len(links))

	for _, link := range links {
		norm := NormalizeTarget(link.Target)
		if norm == "" {
			continue
		}

		dstNodeID, resolvedBy, err := resolveTargetInTx(tx, norm)
		if err != nil {
			return nil, err
		}

		if dstNodeID != "" && dstNodeID != srcNodeID {
			if _, dup := seenDst[dstNodeID]; dup {
				continue
			}
			seenDst[dstNodeID] = struct{}{}

			// Resolved - create edge
			attrsJSON := buildLinkAttrs(link.Target, resolvedBy, false)
			edgeID, err := edges.Create(ctx, tx, edges.Edge{
				Src:   srcNodeID,
				Dst:   dstNodeID,
				Label: string(edges.EdgeTypeLinksTo),
				Attrs: attrsJSON,
			}, nodes.Author{Name: "agent:wikilink-resolver"})
			if err != nil {
				return nil, fmt.Errorf("resolver: create edge %s -> %s: %w", srcNodeID, dstNodeID, err)
			}
			outcomes = append(outcomes, ResolveOutcome{
				Link:       link,
				Resolved:   true,
				EdgeID:     edgeID,
				ResolvedBy: resolvedBy,
			})
		} else if dstNodeID == srcNodeID {
			if _, dup := seenDst[dstNodeID]; dup {
				continue
			}
			seenDst[dstNodeID] = struct{}{}

			// Self-link - resolved but no edge created
			outcomes = append(outcomes, ResolveOutcome{
				Link:       link,
				Resolved:   true,
				ResolvedBy: resolvedBy,
			})
		} else {
			if _, dup := seenDangling[norm]; dup {
				continue
			}
			seenDangling[norm] = struct{}{}

			// Unresolved - store as dangling under the normalized key
			targetKind := string(ClassifyTarget(norm))
			if targetKind == "" {
				targetKind = string(KindStem)
			}
			u, _ := uuid.NewV7()
			id := "dl-" + u.String()
			if _, err := tx.Exec(
				`INSERT INTO dangling_links (id, src_node_id, target_key, target_kind) VALUES (?, ?, ?, ?)`,
				id, srcNodeID, norm, targetKind,
			); err != nil {
				return nil, fmt.Errorf("resolver: insert dangling: %w", err)
			}
			outcomes = append(outcomes, ResolveOutcome{
				Link:     link,
				Resolved: false,
			})
		}
	}
	return outcomes, nil
}

// The four lookups of resolveTargetInTx. Each expression matches an index of
// migration 0011 character for character, which is what lets SQLite use it;
// resolver_plan_test.go runs these same strings through EXPLAIN QUERY PLAN.
// The path lookups join with CROSS JOIN, which keeps note_paths the outer
// loop: with a plain JOIN the planner starts at nodes through idx_nodes_type,
// whose type = 'note' matches every note, and never reaches the path index.
const (
	lookupByIDQuery = `SELECT id FROM nodes WHERE LOWER(id) = ? AND deleted_at IS NULL ORDER BY id ASC LIMIT 1`

	lookupByPathQuery = `SELECT np.uuid
		 FROM note_paths np
		 CROSS JOIN nodes n ON n.id = np.uuid
		 WHERE n.type = 'note' AND n.deleted_at IS NULL
		   AND (LOWER(REPLACE(np.path, '\', '/')) = ? OR LOWER(REPLACE(np.path, '\', '/')) = ?)
		 ORDER BY LENGTH(np.path) ASC, LOWER(np.path) ASC, np.path ASC, np.uuid ASC
		 LIMIT 1`

	// A path can end in /<target>.md only when its basename is the target, so
	// base_key narrows the candidates through its index and the suffix check
	// keeps the answer what it was. A row with no key yet stays a candidate:
	// rows written before migration 0011, until a cold start fills them, and
	// rows inserted without the reconciler would otherwise drop out of step 3.
	lookupByBaseKeyQuery = `SELECT np.uuid
		 FROM note_paths np
		 CROSS JOIN nodes n ON n.id = np.uuid
		 WHERE n.type = 'note' AND n.deleted_at IS NULL
		   AND (np.base_key = ? OR np.base_key IS NULL)
		   AND SUBSTR(LOWER(REPLACE(np.path, '\', '/')), -LENGTH(?)) = ?
		 ORDER BY LENGTH(np.path) ASC, LOWER(np.path) ASC, np.path ASC, np.uuid ASC
		 LIMIT 1`

	lookupByTitleQuery = `SELECT id FROM nodes WHERE type = 'note' AND LOWER(title) = ? AND deleted_at IS NULL ORDER BY id ASC LIMIT 1`
)

// resolveTargetInTx looks up a normalized target in Obsidian order, without
// regard to case:
//  1. Live node ID of any type (keeps UUID links to non-note nodes working,
//     while a UUID-shaped target with no matching node falls through).
//  2. Exact vault-relative path (with or without .md) of a live note.
//  3. Bare filename anywhere in the vault (shortest path, then alphabetical).
//  4. Live note title (ties broken by id ASC).
func resolveTargetInTx(tx *graph.WriteTx, norm string) (dstNodeID, resolvedBy string, err error) {
	var foundID string

	// 1. Live node ID of any type.
	err = tx.QueryRow(lookupByIDQuery, norm).Scan(&foundID)
	if err == nil {
		return foundID, "uuid", nil
	}
	if err != sql.ErrNoRows {
		return "", "", fmt.Errorf("resolver: lookup id %q: %w", norm, err)
	}

	// 2. Exact relative path of a live note, with or without .md.
	withExt := norm + ".md"
	err = tx.QueryRow(lookupByPathQuery, withExt, norm).Scan(&foundID)
	if err == nil {
		return foundID, "stem", nil
	}
	if err != sql.ErrNoRows {
		return "", "", fmt.Errorf("resolver: lookup path %q: %w", norm, err)
	}

	// 3. Bare filename anywhere in the vault: shortest path wins, ties alphabetically.
	// norm holds no "/" here, so it is its own last segment and the base key.
	if !strings.Contains(norm, "/") {
		suffix := "/" + norm + ".md"
		err = tx.QueryRow(lookupByBaseKeyQuery, norm, suffix, suffix).Scan(&foundID)
		if err == nil {
			return foundID, "stem", nil
		}
		if err != sql.ErrNoRows {
			return "", "", fmt.Errorf("resolver: lookup basename %q: %w", norm, err)
		}
	}

	// 4. Live note title, ties broken by id ASC.
	err = tx.QueryRow(lookupByTitleQuery, norm).Scan(&foundID)
	if err == nil {
		return foundID, "title", nil
	}
	if err != sql.ErrNoRows {
		return "", "", fmt.Errorf("resolver: lookup title %q: %w", norm, err)
	}

	return "", "", nil
}

// PromoteKey represents a key that can be matched against dangling_links
// when a new note appears.
// PromoteKey is one spelling under which a newly adopted note might have been
// linked before it existed.
//
// It carries no kind, and that absence is the fix rather than an omission. A
// dangling row's target_kind is not a classification of the target: ClassifyTarget
// sees only text and calls everything that is not a uuid a "stem", so the title
// "Kernl: redesign brief" and the path "kernl/tasks/foo" are both stored as stems.
// Matching on the kind column therefore compared a title key against stem rows and
// never matched, which is the defect. The key is the only thing that carries
// information, so the key is what is matched.
type PromoteKey struct {
	Key string
}

// PromoteDangling scans dangling_links for rows matching the given keys and
// promotes each match to a real edge, then deletes the dangling row.
// The keys should be derived from the new note's filename stem and title.
// Returns the count of promoted edges. Idempotent - calling twice produces
// no duplicate edges.
func PromoteDangling(ctx context.Context, g *graph.Graph, noteID string, keys ...PromoteKey) (int, error) {
	if len(keys) == 0 {
		return 0, nil
	}

	var promoted int
	err := g.DoWrite(ctx, func(tx *graph.WriteTx) error {
		var err error
		promoted, err = promoteDanglingInTx(ctx, tx, noteID, keys...)
		return err
	})
	if err != nil {
		return promoted, err
	}
	return promoted, nil
}

// PromoteDanglingInTx promotes dangling links inside a caller-supplied write tx.
// Callers that need single-transaction-per-event discipline should use this
// variant and supply the tx from their own g.DoWrite block.
func PromoteDanglingInTx(ctx context.Context, tx *graph.WriteTx, noteID string, keys ...PromoteKey) (int, error) {
	return promoteDanglingInTx(ctx, tx, noteID, keys...)
}

// promoteDanglingInTx is the inner implementation shared by PromoteDangling and PromoteDanglingInTx.
func promoteDanglingInTx(ctx context.Context, tx *graph.WriteTx, noteID string, keys ...PromoteKey) (int, error) {
	if len(keys) == 0 {
		return 0, nil
	}

	seenKeys := make(map[string]struct{}, len(keys))
	var promoted int
	for _, key := range keys {
		normKey := NormalizeTarget(key.Key)
		if normKey == "" {
			continue
		}
		if _, dup := seenKeys[normKey]; dup {
			continue
		}
		seenKeys[normKey] = struct{}{}

		rows, err := tx.Query(
			`SELECT id, src_node_id, target_key, target_kind FROM dangling_links WHERE target_key = ?`,
			normKey,
		)
		if err != nil {
			return promoted, fmt.Errorf("PromoteDangling: query: %w", err)
		}

		type danglingRow struct {
			id, srcNodeID, targetKey, targetKind string
		}
		var matches []danglingRow
		for rows.Next() {
			var dr danglingRow
			if err := rows.Scan(&dr.id, &dr.srcNodeID, &dr.targetKey, &dr.targetKind); err != nil {
				rows.Close()
				return promoted, fmt.Errorf("PromoteDangling: scan: %w", err)
			}
			matches = append(matches, dr)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return promoted, fmt.Errorf("PromoteDangling: rows: %w", err)
		}

		for _, dr := range matches {
			if dr.srcNodeID == noteID {
				// Self-link - just delete the dangling row, no edge
				if _, err := tx.Exec(`DELETE FROM dangling_links WHERE id = ?`, dr.id); err != nil {
					return promoted, fmt.Errorf("PromoteDangling: delete self-dangling: %w", err)
				}
				continue
			}

			// edges has no unique constraint on (src, dst, label); check before
			// creating so revivals and multi-spelling dangling rows never
			// mint duplicate edges, while still removing every matched row.
			exists, err := edges.Exists(ctx, tx, dr.srcNodeID, noteID, edges.EdgeTypeLinksTo)
			if err != nil {
				return promoted, fmt.Errorf("PromoteDangling: check edge %s -> %s: %w", dr.srcNodeID, noteID, err)
			}

			created := false
			if !exists {
				attrsJSON := buildLinkAttrs(dr.targetKey, dr.targetKind, true)
				_, err := edges.Create(ctx, tx, edges.Edge{
					Src:   dr.srcNodeID,
					Dst:   noteID,
					Label: string(edges.EdgeTypeLinksTo),
					Attrs: attrsJSON,
				}, nodes.Author{Name: "agent:wikilink-resolver"})
				if err != nil {
					// If edge creation fails (e.g. dst node doesn't exist),
					// still delete the dangling row to avoid accumulating stale entries.
					if !strings.Contains(err.Error(), "edges.Create: dst node") {
						return promoted, fmt.Errorf("PromoteDangling: create edge %s -> %s: %w", dr.srcNodeID, noteID, err)
					}
				} else {
					created = true
				}
			}

			// Delete the dangling row whether or not a new edge was created.
			if _, err := tx.Exec(`DELETE FROM dangling_links WHERE id = ?`, dr.id); err != nil {
				return promoted, fmt.Errorf("PromoteDangling: delete: %w", err)
			}
			if created {
				promoted++
			}
		}
	}
	return promoted, nil
}

// buildLinkAttrs marshals provenance attributes for a wikilink edge.
func buildLinkAttrs(targetText, resolvedBy string, promoted bool) json.RawMessage {
	m := map[string]interface{}{
		"target_text": targetText,
		"resolved_by": resolvedBy,
	}
	if promoted {
		m["promoted"] = true
	}
	b, _ := json.Marshal(m)
	return json.RawMessage(b)
}
