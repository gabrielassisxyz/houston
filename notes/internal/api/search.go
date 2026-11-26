package api

import (
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/gabrielassisxyz/houston/notes/internal/graph"
	"github.com/gabrielassisxyz/houston/notes/internal/graph/search"
)

// notesSearchHit is one ranked search result. Tags is [] when empty, never
// null; Snippet carries STX/ETX around the matched terms, or the body
// excerpt when every token matched through refs.
type notesSearchHit struct {
	ID      string   `json:"id"`
	Title   string   `json:"title"`
	Path    string   `json:"path"`
	Kind    string   `json:"kind"`
	Tags    []string `json:"tags"`
	Snippet string   `json:"snippet"`
}

// notesSearchResponse is the pinned answer shape the hub's search page and
// the CLI render: the page of hits, the exact total before paging, and the
// limit and offset that produced the page.
type notesSearchResponse struct {
	Hits   []notesSearchHit `json:"hits"`
	Total  int              `json:"total"`
	Limit  int              `json:"limit"`
	Offset int              `json:"offset"`
}

func registerNotesSearchRoutes(mux *http.ServeMux, d Deps) {
	mux.HandleFunc("GET /api/search", func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query().Get("q")
		if strings.TrimSpace(q) == "" {
			writeError(w, http.StatusBadRequest, "q must not be empty")
			return
		}

		tag := strings.TrimSpace(r.URL.Query().Get("tag"))
		folder := strings.TrimSpace(r.URL.Query().Get("folder"))

		kind := ""
		if raw := r.URL.Query().Get("kind"); strings.TrimSpace(raw) != "" {
			kind = strings.ToLower(strings.TrimSpace(raw))
			switch kind {
			case "plano", "implementacao", "evidencia", "nota":
			default:
				writeError(w, http.StatusBadRequest, "kind must be one of plano, implementacao, evidencia, nota")
				return
			}
		}

		limit := 20
		if raw := strings.TrimSpace(r.URL.Query().Get("limit")); raw != "" {
			n, err := strconv.Atoi(raw)
			if err != nil {
				writeError(w, http.StatusBadRequest, "limit must be an integer")
				return
			}
			if n < 1 {
				writeError(w, http.StatusBadRequest, "limit must be at least 1")
				return
			}
			limit = n
			if limit > 100 {
				limit = 100
			}
		}

		offset := 0
		if raw := strings.TrimSpace(r.URL.Query().Get("offset")); raw != "" {
			n, err := strconv.Atoi(raw)
			if err != nil {
				writeError(w, http.StatusBadRequest, "offset must be an integer")
				return
			}
			if n < 0 {
				writeError(w, http.StatusBadRequest, "offset must not be negative")
				return
			}
			offset = n
		}

		var ranked []search.RankedHit
		err := d.Graph.DoRead(r.Context(), func(tx *graph.ReadTx) error {
			var err error
			ranked, err = search.RankedSearch(r.Context(), tx, q, tag, folder, kind)
			return err
		})
		if err != nil {
			if errors.Is(err, graph.ErrFTSQuerySyntax) {
				writeError(w, http.StatusBadRequest, "q must not be empty")
				return
			}
			writeError(w, http.StatusInternalServerError, "search failed: "+err.Error())
			return
		}

		total := len(ranked)
		page := []search.RankedHit{}
		if offset < total {
			end := offset + limit
			if end > total {
				end = total
			}
			page = ranked[offset:end]
		}

		out := notesSearchResponse{Hits: []notesSearchHit{}, Total: total, Limit: limit, Offset: offset}
		for _, h := range page {
			tags := h.Tags
			if tags == nil {
				tags = []string{}
			}
			out.Hits = append(out.Hits, notesSearchHit{
				ID: h.NodeID, Title: h.Title, Path: h.Path, Kind: h.Kind, Tags: tags, Snippet: h.Snippet,
			})
		}
		writeJSON(w, out)
	})
}
