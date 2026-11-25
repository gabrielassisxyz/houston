package api

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// traversalVault lays out a vault root with a sibling file that lives OUTSIDE
// it, so every traversal assertion can prove the attacker's target was neither
// read, written nor deleted.
func traversalVault(t *testing.T) (root, outside, outsideBody string) {
	t.Helper()
	base := t.TempDir()
	root = filepath.Join(base, "vault")
	if err := os.MkdirAll(filepath.Join(root, "sub", "dir"), 0o755); err != nil {
		t.Fatal(err)
	}
	outside = filepath.Join(base, "secret.txt")
	outsideBody = "TOP SECRET private key\n"
	if err := os.WriteFile(outside, []byte(outsideBody), 0o644); err != nil {
		t.Fatal(err)
	}
	return root, outside, outsideBody
}

// traversalPaths are the client-supplied paths every vault-facing route must
// refuse. The %2f entries matter because net/http percent-decodes the query
// before the handler ever sees it - the guard must run on the decoded value.
func traversalPaths(outside string) map[string]string {
	return map[string]string{
		"relative escape":  "../secret.txt",
		"deep escape":      "../../../etc/passwd",
		"absolute path":    outside,
		"absolute etc":     "/etc/passwd",
		"encoded escape":   "..%2f..%2fetc%2fpasswd",
		"escape then back": "sub/../../secret.txt",
	}
}

// A rejection must say the path is out of bounds without echoing the resolved
// absolute path or the vault root - that would hand an attacker the layout of
// the filesystem they are trying to map.
func assertNoPathLeak(t *testing.T, body, root string) {
	t.Helper()
	if strings.Contains(body, root) {
		t.Errorf("rejection body leaks the vault root %q: %s", root, body)
	}
	if strings.Contains(body, "/etc/passwd") {
		t.Errorf("rejection body echoes the resolved path: %s", body)
	}
}

func TestVaultGetFileRejectsTraversal(t *testing.T) {
	root, outside, outsideBody := traversalVault(t)
	mux := newTestRouter(t, newTestDeps(t, root))

	for name, p := range traversalPaths(outside) {
		t.Run(name, func(t *testing.T) {
			req := httptest.NewRequest("GET", "/api/vault/file?path="+p, nil)
			w := httptest.NewRecorder()
			mux.ServeHTTP(w, req)

			if w.Code != http.StatusBadRequest {
				t.Fatalf("expected 400, got %d: %s", w.Code, w.Body.String())
			}
			if strings.Contains(w.Body.String(), outsideBody) {
				t.Fatal("response leaked the contents of a file outside the vault")
			}
			assertNoPathLeak(t, w.Body.String(), root)
		})
	}
}

// A guard that also breaks legitimate nested notes is a regression, not a fix.
func TestVaultGetFileAllowsNestedPath(t *testing.T) {
	root, _, _ := traversalVault(t)
	mux := newTestRouter(t, newTestDeps(t, root))

	want := "---\nid: nested\n---\nnested body\n"
	if err := os.WriteFile(filepath.Join(root, "sub", "dir", "note.md"), []byte(want), 0o644); err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest("GET", "/api/vault/file?path=sub/dir/note.md", nil)
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200 for a nested vault path, got %d: %s", w.Code, w.Body.String())
	}
	if w.Body.String() != want {
		t.Errorf("unexpected body: %q", w.Body.String())
	}
	if w.Header().Get("ETag") == "" || w.Header().Get("Last-Modified") == "" {
		t.Error("ETag/Last-Modified must still be set so the editor can baseline conflicts")
	}
}

func TestVaultPostFileRejectsTraversal(t *testing.T) {
	root, outside, outsideBody := traversalVault(t)
	mux := newTestRouter(t, newTestDeps(t, root))

	for name, p := range traversalPaths(outside) {
		t.Run(name, func(t *testing.T) {
			req := httptest.NewRequest("POST", "/api/vault/file?path="+p, bytes.NewBufferString("pwned\n"))
			w := httptest.NewRecorder()
			mux.ServeHTTP(w, req)

			if w.Code != http.StatusBadRequest {
				t.Fatalf("expected 400, got %d: %s", w.Code, w.Body.String())
			}
			assertNoPathLeak(t, w.Body.String(), root)
			got, err := os.ReadFile(outside)
			if err != nil {
				t.Fatalf("file outside the vault must still exist: %v", err)
			}
			if string(got) != outsideBody {
				t.Fatalf("file outside the vault was overwritten: %q", string(got))
			}
		})
	}
}

func TestVaultPostFileAllowsNestedPath(t *testing.T) {
	root, _, _ := traversalVault(t)
	mux := newTestRouter(t, newTestDeps(t, root))

	// A directory that does not exist yet: the handler's MkdirAll must survive.
	req := httptest.NewRequest("POST", "/api/vault/file?path=sub/fresh/deep.md", bytes.NewBufferString("---\ntitle: Deep\n---\nbody\n"))
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200 for a nested vault path, got %d: %s", w.Code, w.Body.String())
	}
	if _, err := os.Stat(filepath.Join(root, "sub", "fresh", "deep.md")); err != nil {
		t.Fatalf("nested note was not written: %v", err)
	}
}

func TestVaultDeleteFileRejectsTraversal(t *testing.T) {
	root, outside, outsideBody := traversalVault(t)
	mux := newTestRouter(t, newTestDeps(t, root))

	paths := traversalPaths(outside)
	// The vault root itself is not a deletable target either.
	paths["vault root"] = "."

	for name, p := range paths {
		t.Run(name, func(t *testing.T) {
			req := httptest.NewRequest("DELETE", "/api/vault/file?path="+p, nil)
			w := httptest.NewRecorder()
			mux.ServeHTTP(w, req)

			if w.Code != http.StatusBadRequest {
				t.Fatalf("expected 400, got %d: %s", w.Code, w.Body.String())
			}
			assertNoPathLeak(t, w.Body.String(), root)
			got, err := os.ReadFile(outside)
			if err != nil {
				t.Fatalf("file outside the vault must still exist: %v", err)
			}
			if string(got) != outsideBody {
				t.Fatalf("file outside the vault was modified: %q", string(got))
			}
			if _, err := os.Stat(root); err != nil {
				t.Fatalf("the vault root must survive: %v", err)
			}
		})
	}
}
