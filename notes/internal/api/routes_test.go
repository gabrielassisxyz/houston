package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
)

// The health body is decoded by the CLI and the hub, so its three fields are
// pinned by key and value, and its bytes against kernl's map[string]string
// encoding: the map[string]any the port encodes must not change them.
func TestHealthAnswersItsThreeFields(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	root := filepath.Join(home, "vault")
	mux := newTestRouter(t, newTestDeps(t, root))

	w := httptest.NewRecorder()
	mux.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/health", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("GET /api/health = %d: %s", w.Code, w.Body.String())
	}
	if got := w.Header().Get("Content-Type"); got != "application/json" {
		t.Errorf("Content-Type = %q, want application/json", got)
	}

	var got map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v: %s", err, w.Body.String())
	}
	want := map[string]string{"status": "ok", "vaultRoot": root, "vaultLabel": "~/vault"}
	if len(got) != len(want) {
		t.Errorf("health carries %d fields, want %d: %v", len(got), len(want), got)
	}
	for key, value := range want {
		if got[key] != value {
			t.Errorf("health %s = %#v, want %q", key, got[key], value)
		}
	}

	kernlBytes, err := json.Marshal(want)
	if err != nil {
		t.Fatal(err)
	}
	if w.Body.String() != string(kernlBytes)+"\n" {
		t.Errorf("health body = %q, want kernl's %q", w.Body.String(), string(kernlBytes)+"\n")
	}
}

func TestVaultDisplayPathAbbreviatesHome(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	outside := filepath.Join(filepath.Dir(home), "elsewhere")

	for root, want := range map[string]string{
		"":                                 "",
		home:                               "~",
		filepath.Join(home, "notes", "wv"): "~/notes/wv",
		outside:                            outside,
	} {
		if got := vaultDisplayPath(root); got != want {
			t.Errorf("vaultDisplayPath(%q) = %q, want %q", root, got, want)
		}
	}
}

// kernl fell back to ~/.kernl/vault when its root was empty. Routes that write
// and delete notes must not choose a directory on their own, so a blank root
// is refused, and refused before any route is registered.
func TestRegisterRefusesAnEmptyVaultRoot(t *testing.T) {
	for name, root := range map[string]string{"empty": "", "blank": "  \t"} {
		t.Run(name, func(t *testing.T) {
			mux := http.NewServeMux()
			err := Register(mux, Deps{VaultRoot: root})
			if !errors.Is(err, ErrEmptyVaultRoot) {
				t.Fatalf("Register with root %q = %v, want ErrEmptyVaultRoot", root, err)
			}
			if _, pattern := mux.Handler(httptest.NewRequest(http.MethodGet, "/api/health", nil)); pattern != "" {
				t.Errorf("a refused registration still registered %q", pattern)
			}
		})
	}
}

// Every ported route is registered under kernl's own pattern, and every notes
// route the port leaves in kernl is absent rather than half-wired.
func TestRegisterServesEveryPortedRouteAndNoOther(t *testing.T) {
	mux := newTestRouter(t, newTestDeps(t, ""))

	ported := []struct{ method, path, pattern string }{
		{"GET", "/api/health", "GET /api/health"},
		{"GET", "/api/nodes", "GET /api/nodes"},
		{"GET", "/api/vault/list", "GET /api/vault/list"},
		{"GET", "/api/vault/notes", "GET /api/vault/notes"},
		{"GET", "/api/vault/file", "GET /api/vault/file"},
		{"POST", "/api/vault/file", "POST /api/vault/file"},
		{"POST", "/api/vault/append", "POST /api/vault/append"},
		{"GET", "/api/notes", "GET /api/notes"},
		{"GET", "/api/notes/tags", "GET /api/notes/tags"},
		{"GET", "/api/nodes/search", "GET /api/nodes/search"},
		{"GET", "/api/nodes/n1/related", "GET /api/nodes/{id}/related"},
		{"GET", "/api/nodes/n1/edges", "GET /api/nodes/{id}/edges"},
		{"GET", "/api/edges", "GET /api/edges"},
	}
	for _, route := range ported {
		_, pattern := mux.Handler(httptest.NewRequest(route.method, route.path, nil))
		if pattern != route.pattern {
			t.Errorf("%s %s matched %q, want %q", route.method, route.path, pattern, route.pattern)
		}
	}

	leftInKernl := []struct{ method, path string }{
		{"POST", "/api/notes/save"},
		{"POST", "/api/notes/suggest"},
		{"POST", "/api/notes/apply-hunks"},
		{"PATCH", "/api/notes/n1"},
		{"PATCH", "/api/notes/tags"},
		{"GET", "/api/plan/context"},
	}
	for _, route := range leftInKernl {
		if _, pattern := mux.Handler(httptest.NewRequest(route.method, route.path, nil)); pattern != "" {
			t.Errorf("%s %s is left in kernl but matched %q", route.method, route.path, pattern)
		}
	}
}
