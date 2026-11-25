package api

import (
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/gabrielassisxyz/houston/notes/internal/graph"
	"github.com/gabrielassisxyz/houston/notes/internal/graph/relate"
)

type relatedNode struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	Type  string `json:"type"`
}

// registerNodeRelatedRoutes exposes the 4-signal relevance over HTTP so module
// surfaces (and the magic-loop "connect" step) can show related items.
func registerNodeRelatedRoutes(mux *http.ServeMux, g *graph.Graph) {
	mux.HandleFunc("GET /api/nodes/{id}/related", func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		if id == "" {
			http.Error(w, "missing id", http.StatusBadRequest)
			return
		}
		limit := 10
		if l := r.URL.Query().Get("limit"); l != "" {
			if n, err := strconv.Atoi(l); err == nil && n > 0 {
				limit = n
			}
		}

		var out []relatedNode
		err := g.DoRead(r.Context(), func(tx *graph.ReadTx) error {
			ids, err := relate.RelatedTo(r.Context(), tx, id, limit)
			if err != nil {
				return err
			}
			out = make([]relatedNode, 0, len(ids))
			for _, rid := range ids {
				var title, typ string
				if err := tx.QueryRow(
					`SELECT title, type FROM nodes WHERE id = ? AND deleted_at IS NULL`, rid,
				).Scan(&title, &typ); err != nil {
					continue
				}
				out = append(out, relatedNode{ID: rid, Title: title, Type: typ})
			}
			return nil
		})
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(out)
	})
}
