package api

import (
	"net/http"
	"testing"

	"github.com/gabrielassisxyz/houston/notes/internal/graph/testutil"
)

// newTestDeps builds the dependency struct every test of this package runs
// against: an in-memory graph and root as the vault, or a fresh temporary
// directory when root is empty. It stands where kernl's tests built an App,
// with or without a graph and with or without an LLM: these routes read
// nothing else.
func newTestDeps(t *testing.T, root string) Deps {
	t.Helper()
	if root == "" {
		root = t.TempDir()
	}
	return Deps{Graph: testutil.NewInMemoryTestGraph(t), VaultRoot: root}
}

// newTestRouter registers every route on a fresh mux, failing the test when
// the registration is refused.
func newTestRouter(t *testing.T, d Deps) *http.ServeMux {
	t.Helper()
	mux := http.NewServeMux()
	if err := Register(mux, d); err != nil {
		t.Fatalf("Register: %v", err)
	}
	return mux
}
