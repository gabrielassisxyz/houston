package api

import (
	"encoding/json"
	"log/slog"
	"net/http"

	"github.com/gabrielassisxyz/houston/notes/internal/graph"
)

// listNodesHandler answers GET /api/nodes, the only route this package takes
// from kernl's chat.go.
func listNodesHandler(g *graph.Graph) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		var out []map[string]any
		err := g.DoRead(ctx, func(tx *graph.ReadTx) error {
			rows, err := tx.Query(`SELECT id, title, type FROM nodes WHERE deleted_at IS NULL`)
			if err != nil {
				return err
			}
			defer rows.Close()
			for rows.Next() {
				var id, title, nodeType string
				if err := rows.Scan(&id, &title, &nodeType); err != nil {
					return err
				}
				out = append(out, map[string]any{
					"id":    id,
					"title": title,
					"type":  nodeType,
				})
			}
			return rows.Err()
		})
		if err != nil {
			slog.Error("list nodes", "error", err)
			writeError(w, http.StatusInternalServerError, "failed to list nodes")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(out)
	}
}
