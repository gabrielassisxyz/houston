package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"path/filepath"
	"strings"

	"github.com/gabrielassisxyz/houston/notes/internal/notes"
)

// registerNotesRoutes adds the note index and the tag tree. kernl's other
// /api/notes routes - save with its editor, suggest, apply-hunks and the two
// pin routes - are left in kernl: the code they call is not copied.
func registerNotesRoutes(mux *http.ServeMux, d Deps) {
	registerNotesIndexRoutes(mux, d)

	// Tag hierarchy sourced from the graph (one request, vs the editor's old
	// N+1 fetch-every-file-and-parse-frontmatter approach).
	mux.HandleFunc("GET /api/notes/tags", func(w http.ResponseWriter, r *http.Request) {
		tree, err := notes.TagTree(r.Context(), d.Graph)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(tree)
	})
}

func resolveVaultFilePath(root, relPath string) (string, error) {
	if strings.TrimSpace(relPath) == "" {
		return "", fmt.Errorf("path is required")
	}
	cleanRoot, err := filepath.Abs(root)
	if err != nil {
		return "", err
	}
	cleanRel := filepath.Clean(filepath.FromSlash(relPath))
	if filepath.IsAbs(cleanRel) || cleanRel == ".." || strings.HasPrefix(cleanRel, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("path must stay within the vault")
	}
	fullPath, err := filepath.Abs(filepath.Join(cleanRoot, cleanRel))
	if err != nil {
		return "", err
	}
	rootRel, err := filepath.Rel(cleanRoot, fullPath)
	if err != nil || rootRel == ".." || strings.HasPrefix(rootRel, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("path must stay within the vault")
	}
	return fullPath, nil
}
