// Package api serves the notes side of the houston service over HTTP: health,
// the node list, the vault files, the note index and tag tree, node search,
// related nodes and edges.
//
// The handlers are ported from kernl's internal/api at commit 488fbbe. kernl's
// took its whole application struct and read only the graph and the vault root
// from it, so here they take Deps and nothing else. What the port leaves out,
// and why, is said where each route is registered.
package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/gabrielassisxyz/houston/notes/internal/graph"
	"github.com/gabrielassisxyz/houston/notes/internal/vault"
)

// Deps is everything the notes routes read.
type Deps struct {
	Graph *graph.Graph
	// VaultRoot is the directory the vault routes read, write and delete in.
	VaultRoot string
	// Vault is the vault service whose readiness health reports. Nil leaves
	// health with its three fields.
	Vault VaultStatus
}

// VaultStatus is the part of the vault service health reads. The server
// answers before the first index completes, so this is what tells a client
// whether the index is whole yet.
type VaultStatus interface {
	Status() vault.Status
}

// ErrEmptyVaultRoot refuses a registration that names no vault. kernl fell back
// to ~/.kernl/vault when its root was empty; routes that write and delete notes
// must never pick a directory nobody configured.
var ErrEmptyVaultRoot = errors.New("api: the vault root is empty")

// Register adds every ported notes route to mux. When d.VaultRoot is blank it
// registers nothing and returns ErrEmptyVaultRoot.
func Register(mux *http.ServeMux, d Deps) error {
	if strings.TrimSpace(d.VaultRoot) == "" {
		return ErrEmptyVaultRoot
	}

	mux.HandleFunc("GET /api/health", healthHandler(d))
	mux.HandleFunc("GET /api/nodes", listNodesHandler(d.Graph))
	registerVaultRoutes(mux, d)
	registerNotesRoutes(mux, d)
	registerNotesRefsRoutes(mux, d)
	registerNotesSearchRoutes(mux, d)
	mux.HandleFunc("GET /api/nodes/search", nodeSearchHandler(d.Graph))
	registerNodeRelatedRoutes(mux, d.Graph)
	registerNodeEdgeRoutes(mux, d.Graph)
	registerEdgeRoutes(mux, d.Graph)
	return nil
}

// healthHandler reports liveness plus the configured vault location, so the
// shell footer can show where the active vault lives instead of a placeholder.
// With a vault service it adds readiness: indexing, true until the first index
// has returned, and reports, the count of each kind of file report - files the
// index left out, or indexed with something other than what they say.
//
// kernl encodes a map[string]string. A map[string]any encodes these three
// string fields to the same bytes, and lets a readiness report add its own
// fields beside them without replacing these.
func healthHandler(d Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		body := map[string]any{
			"status":     "ok",
			"vaultRoot":  d.VaultRoot,
			"vaultLabel": vaultDisplayPath(d.VaultRoot),
		}
		if d.Vault != nil {
			st := d.Vault.Status()
			reports := make(map[string]int, len(st.Reports))
			for kind, n := range st.Reports {
				reports[string(kind)] = n
			}
			body["indexing"] = st.Indexing
			body["reports"] = reports
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(body)
	}
}

// vaultDisplayPath abbreviates the user's home directory to "~" for display.
// Returns the unmodified path when it is outside home or home is unknown.
func vaultDisplayPath(root string) string {
	if root == "" {
		return ""
	}
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return root
	}
	rel, err := filepath.Rel(home, root)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return root
	}
	if rel == "." {
		return "~"
	}
	return "~/" + filepath.ToSlash(rel)
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": msg})
}
