package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestResolveAPIURLPrecedence(t *testing.T) {
	tmp := t.TempDir()
	cfgPath := filepath.Join(tmp, "notes.yaml")
	if err := os.WriteFile(cfgPath, []byte("vault:\n  root: /tmp/vault\nserver:\n  host: 127.0.0.1\n  port: 3399\n"), 0o644); err != nil {
		t.Fatalf("writing config: %v", err)
	}

	t.Setenv("HOUSTON_ADDR", "127.0.0.1:3388")

	got, err := resolveHealthURL(cfgPath, "127.0.0.1:3377")
	if err != nil || got != "http://127.0.0.1:3377" {
		t.Fatalf("--server must win: got %q, err %v", got, err)
	}
	got, err = resolveHealthURL(cfgPath, "")
	if err != nil || got != "http://127.0.0.1:3388" {
		t.Fatalf("HOUSTON_ADDR must beat the file: got %q, err %v", got, err)
	}

	t.Setenv("HOUSTON_ADDR", "")
	got, err = resolveHealthURL(cfgPath, "")
	if err != nil || got != "http://127.0.0.1:3399" {
		t.Fatalf("config file must beat the default: got %q, err %v", got, err)
	}
	got, err = resolveHealthURL(filepath.Join(tmp, "missing.yaml"), "")
	if err != nil || got != "http://127.0.0.1:3301" {
		t.Fatalf("default must be the loopback notes port: got %q, err %v", got, err)
	}
}

// A --server invocation must not need a config file: the whole point of the
// flag is pointing the CLI at a server from anywhere on the filesystem.
func TestResolveAPIURLSkipsConfigWhenServerGiven(t *testing.T) {
	t.Setenv("HOUSTON_ADDR", "")
	got, err := resolveHealthURL("/nonexistent/notes.yaml", "http://box:9000")
	if err != nil {
		t.Fatalf("resolveHealthURL should not have read the config: %v", err)
	}
	if got != "http://box:9000" {
		t.Errorf("got %q", got)
	}
}

// server.host ::1 is dialled as [::1], via net.JoinHostPort.
func TestResolveAPIURLJoinsIPv6Host(t *testing.T) {
	t.Setenv("HOUSTON_ADDR", "")
	tmp := t.TempDir()
	cfgPath := filepath.Join(tmp, "notes.yaml")
	if err := os.WriteFile(cfgPath, []byte("vault:\n  root: /tmp/vault\nserver:\n  host: ::1\n  port: 3399\n"), 0o644); err != nil {
		t.Fatalf("writing config: %v", err)
	}
	got, err := resolveHealthURL(cfgPath, "")
	if err != nil {
		t.Fatalf("resolveHealthURL: %v", err)
	}
	if got != "http://[::1]:3399" {
		t.Errorf("got %q, want %q", got, "http://[::1]:3399")
	}
}

func TestNormalizeServerURLRejectsGarbage(t *testing.T) {
	for _, raw := range []string{"", "   ", "http://"} {
		if _, err := normalizeServerURL(raw); err == nil {
			t.Errorf("normalizeServerURL(%q) accepted an invalid value", raw)
		} else if exitCode(err) != 2 {
			t.Errorf("normalizeServerURL(%q) exit code = %d, want 2 (usage)", raw, exitCode(err))
		}
	}
}

// The exit-code contract the client verbs rely on: a 4xx is about the
// invocation (exit 2), a 5xx is the backend failing (exit 1).
func TestRequestMapsStatusToExitCode(t *testing.T) {
	tests := []struct {
		status   int
		wantCode int
	}{
		{http.StatusBadRequest, 2},
		{http.StatusNotFound, 2},
		{http.StatusConflict, 2},
		{http.StatusInternalServerError, 1},
		{http.StatusBadGateway, 1},
	}

	for _, tt := range tests {
		ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(tt.status)
			_, _ = w.Write([]byte(`{"error":"nope"}`))
		}))
		c := &apiClient{baseURL: ts.URL, http: ts.Client()}
		_, err := c.get(context.Background(), "/api/vault/notes")
		ts.Close()

		if err == nil {
			t.Fatalf("status %d: expected an error", tt.status)
		}
		if got := exitCode(err); got != tt.wantCode {
			t.Errorf("status %d: exit code = %d, want %d", tt.status, got, tt.wantCode)
		}
		if !strings.Contains(err.Error(), "houston:") {
			t.Errorf("status %d: error is missing the marker: %v", tt.status, err)
		}
		if strings.Contains(err.Error(), "kernl") {
			t.Errorf("status %d: error must not name kernl: %v", tt.status, err)
		}
	}
}

// The single most likely failure for every client verb is "the server is not
// running", so that error must name the command that fixes it.
func TestUnreachableServerNamesTheFix(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	url := ts.URL
	ts.Close() // nothing is listening now

	c := &apiClient{baseURL: url, http: &http.Client{}}
	_, err := c.get(context.Background(), "/api/vault/notes")
	if err == nil {
		t.Fatal("expected a connection error")
	}
	if !strings.Contains(err.Error(), "houston serve") {
		t.Errorf("unreachable error does not name the fix: %v", err)
	}
	if strings.Contains(err.Error(), "kernl") {
		t.Errorf("unreachable error must not name kernl: %v", err)
	}
	if got := exitCode(err); got != 1 {
		t.Errorf("exit code = %d, want 1 (runtime)", got)
	}
}

func TestRequestSendsJSONBody(t *testing.T) {
	var gotMethod, gotPath, gotType, gotBody string
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod, gotPath, gotType = r.Method, r.URL.Path, r.Header.Get("Content-Type")
		buf := make([]byte, r.ContentLength)
		_, _ = r.Body.Read(buf)
		gotBody = string(buf)
		_, _ = w.Write([]byte(`{"id":"t1"}`))
	}))
	defer ts.Close()

	c := &apiClient{baseURL: ts.URL, http: ts.Client()}
	raw, err := c.post(context.Background(), "/api/vault/notes", map[string]string{"title": "write it"})
	if err != nil {
		t.Fatalf("post: %v", err)
	}
	if gotMethod != http.MethodPost || gotPath != "/api/vault/notes" {
		t.Errorf("got %s %s", gotMethod, gotPath)
	}
	if gotType != "application/json" {
		t.Errorf("Content-Type = %q", gotType)
	}
	if !strings.Contains(gotBody, `"title":"write it"`) {
		t.Errorf("body = %q", gotBody)
	}
	if string(raw) != `{"id":"t1"}` {
		t.Errorf("response passed through as %q", raw)
	}
}

// A GET must not carry a body or a JSON content type - some handlers branch on
// it, and an empty body is the difference between a read and a malformed write.
func TestGetSendsNoBody(t *testing.T) {
	var hadType bool
	var length int64
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hadType = r.Header.Get("Content-Type") != ""
		length = r.ContentLength
		_, _ = w.Write([]byte(`[]`))
	}))
	defer ts.Close()

	c := &apiClient{baseURL: ts.URL, http: ts.Client()}
	if _, err := c.get(context.Background(), "/api/vault/notes"); err != nil {
		t.Fatalf("get: %v", err)
	}
	if hadType {
		t.Error("GET sent a Content-Type header")
	}
	if length > 0 {
		t.Errorf("GET sent a %d-byte body", length)
	}
}

// getOptional is the opt-in for reads where absence is a legitimate answer.
// The default path must be unaffected: a 404 nobody opted out of is still a
// usage error.
func TestGetOptionalReportsAbsenceWithoutAnError(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte("no such node"))
	}))
	defer ts.Close()

	c := &apiClient{baseURL: ts.URL, http: ts.Client()}
	raw, found, err := c.getOptional(context.Background(), "/api/nodes/n1/related")
	if err != nil {
		t.Fatalf("a 404 must not be an error for getOptional, got: %v", err)
	}
	if found {
		t.Error("found must be false on a 404")
	}
	if raw != nil {
		t.Errorf("no body should come back, got %q", raw)
	}
}

func TestGetOptionalStillFailsOnRealErrors(t *testing.T) {
	// Only 404 means "absent". Everything else must keep failing loud, or
	// getOptional would quietly turn a broken backend into "nothing here".
	for _, status := range []int{http.StatusBadRequest, http.StatusInternalServerError} {
		ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(status)
		}))
		c := &apiClient{baseURL: ts.URL, http: ts.Client()}
		_, found, err := c.getOptional(context.Background(), "/api/nodes/n1/related")
		ts.Close()

		if err == nil {
			t.Errorf("status %d must still be an error", status)
		}
		if found {
			t.Errorf("status %d must not report found", status)
		}
	}
}

func TestGetOptionalReturnsTheBodyWhenPresent(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"title":"Prep"}`))
	}))
	defer ts.Close()

	c := &apiClient{baseURL: ts.URL, http: ts.Client()}
	raw, found, err := c.getOptional(context.Background(), "/api/nodes/n1/related")
	if err != nil || !found {
		t.Fatalf("present resource: found=%v err=%v", found, err)
	}
	if string(raw) != `{"title":"Prep"}` {
		t.Errorf("body not passed through, got %q", raw)
	}
}
