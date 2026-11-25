package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gabrielassisxyz/houston/notes/internal/vault"
)

func TestRequestGuardAcceptedCases(t *testing.T) {
	cases := []struct {
		name    string
		method  string
		host    string
		headers map[string][]string
	}{
		{
			name:   "node fetch shape with sec-fetch-mode cors",
			method: http.MethodGet,
			host:   "127.0.0.1:3301",
			headers: map[string][]string{
				"Sec-Fetch-Mode": {"cors"},
			},
		},
		{
			name:   "ipv4 loopback with port",
			method: http.MethodGet,
			host:   "127.0.0.1:3301",
		},
		{
			name:   "localhost with port",
			method: http.MethodGet,
			host:   "localhost:3301",
		},
		{
			name:   "localhost uppercase with port",
			method: http.MethodGet,
			host:   "LOCALHOST:3301",
		},
		{
			name:   "ipv6 loopback with port",
			method: http.MethodGet,
			host:   "[::1]:3301",
		},
		{
			name:   "ipv4 loopback without port",
			method: http.MethodGet,
			host:   "127.0.0.1",
		},
		{
			name:   "localhost without port",
			method: http.MethodGet,
			host:   "localhost",
		},
		{
			name:   "bracketed ipv6 loopback without port",
			method: http.MethodGet,
			host:   "[::1]",
		},
		{
			name:   "bare ipv6 loopback without port",
			method: http.MethodGet,
			host:   "::1",
		},
		{
			name:   "port lower bound",
			method: http.MethodGet,
			host:   "127.0.0.1:1",
		},
		{
			name:   "port upper bound",
			method: http.MethodGet,
			host:   "127.0.0.1:65535",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			called := false
			next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				called = true
				w.WriteHeader(http.StatusOK)
			})

			req := httptest.NewRequest(tc.method, "/api/health", nil)
			req.Host = tc.host
			for k, vals := range tc.headers {
				req.Header[k] = vals
			}

			rec := httptest.NewRecorder()
			requestGuardMiddleware(next).ServeHTTP(rec, req)

			if rec.Code != http.StatusOK {
				t.Fatalf("status = %d, want 200 (body: %q)", rec.Code, rec.Body.String())
			}
			if !called {
				t.Fatalf("downstream handler was not called for accepted request")
			}
		})
	}
}

func TestRequestGuardRefusedCases(t *testing.T) {
	cases := []struct {
		name    string
		method  string
		host    string
		headers map[string][]string
	}{
		{
			name:   "origin header",
			method: http.MethodGet,
			host:   "127.0.0.1:3301",
			headers: map[string][]string{
				"Origin": {"http://evil.example"},
			},
		},
		{
			name:   "same-origin origin header",
			method: http.MethodPost,
			host:   "127.0.0.1:3301",
			headers: map[string][]string{
				"Origin": {"http://127.0.0.1:3301"},
			},
		},
		{
			name:   "origin null",
			method: http.MethodGet,
			host:   "127.0.0.1:3301",
			headers: map[string][]string{
				"Origin": {"null"},
			},
		},
		{
			name:   "empty origin header",
			method: http.MethodGet,
			host:   "127.0.0.1:3301",
			headers: map[string][]string{
				"Origin": {""},
			},
		},
		{
			name:   "sec-fetch-site same-origin",
			method: http.MethodGet,
			host:   "127.0.0.1:3301",
			headers: map[string][]string{
				"Sec-Fetch-Site": {"same-origin"},
			},
		},
		{
			name:   "empty sec-fetch-site header",
			method: http.MethodGet,
			host:   "127.0.0.1:3301",
			headers: map[string][]string{
				"Sec-Fetch-Site": {""},
			},
		},
		{
			name:   "options preflight",
			method: http.MethodOptions,
			host:   "127.0.0.1:3301",
			headers: map[string][]string{
				"Origin":                        {"http://evil.example"},
				"Access-Control-Request-Method": {"POST"},
			},
		},
		{
			name:   "host evil.example",
			method: http.MethodGet,
			host:   "evil.example",
		},
		{
			name:   "host localhost.evil.example",
			method: http.MethodGet,
			host:   "localhost.evil.example",
		},
		{
			name:   "host 127.0.0.1.nip.io with port",
			method: http.MethodGet,
			host:   "127.0.0.1.nip.io:3301",
		},
		{
			name:   "empty host",
			method: http.MethodGet,
			host:   "",
		},
		{
			name:   "malformed host bracketed ipv6 with suffix",
			method: http.MethodGet,
			host:   "[::1]evil",
		},
		{
			name:   "malformed host double port",
			method: http.MethodGet,
			host:   "127.0.0.1:1:2",
		},
		{
			name:   "malformed host non-numeric port",
			method: http.MethodGet,
			host:   "127.0.0.1:abc",
		},
		{
			name:   "malformed host empty port",
			method: http.MethodGet,
			host:   "127.0.0.1:",
		},
		{
			name:   "malformed host port zero",
			method: http.MethodGet,
			host:   "127.0.0.1:0",
		},
		{
			name:   "malformed host port above 65535",
			method: http.MethodGet,
			host:   "127.0.0.1:65536",
		},
		{
			name:   "malformed host signed port",
			method: http.MethodGet,
			host:   "127.0.0.1:+3301",
		},
		{
			name:   "bracketed ipv4 without port",
			method: http.MethodGet,
			host:   "[127.0.0.1]",
		},
		{
			name:   "bracketed ipv4 with port",
			method: http.MethodGet,
			host:   "[127.0.0.1]:3301",
		},
		{
			name:   "bracketed localhost without port",
			method: http.MethodGet,
			host:   "[localhost]",
		},
		{
			name:   "bracketed localhost with port",
			method: http.MethodGet,
			host:   "[localhost]:3301",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			called := false
			next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				called = true
				w.WriteHeader(http.StatusOK)
			})

			req := httptest.NewRequest(tc.method, "/api/health", nil)
			req.Host = tc.host
			for k, vals := range tc.headers {
				req.Header[k] = vals
			}

			rec := httptest.NewRecorder()
			requestGuardMiddleware(next).ServeHTTP(rec, req)

			if rec.Code != http.StatusForbidden {
				t.Fatalf("status = %d, want 403", rec.Code)
			}
			if called {
				t.Fatalf("downstream handler was called for refused request")
			}
		})
	}
}

func TestRequestGuardLogsRefusedRequest(t *testing.T) {
	var buf bytes.Buffer
	original := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&buf, &slog.HandlerOptions{Level: slog.LevelInfo})))
	t.Cleanup(func() { slog.SetDefault(original) })

	called := false
	next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		called = true
		w.WriteHeader(http.StatusOK)
	})
	handler := buildServeHandler(next)

	req := httptest.NewRequest(http.MethodGet, "/api/health", nil)
	req.Host = "evil.example"
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", rec.Code)
	}
	if called {
		t.Fatalf("downstream handler was called for refused request")
	}

	reqID := rec.Header().Get("X-Request-ID")
	if reqID == "" {
		t.Fatalf("expected X-Request-ID response header from correlation middleware")
	}

	lines := strings.Split(strings.TrimSpace(buf.String()), "\n")
	if len(lines) == 0 || lines[0] == "" {
		t.Fatalf("expected log output for refused request, got none")
	}

	var sawRequestLog, sawRefusalLog bool
	for _, line := range lines {
		var entry map[string]any
		if err := json.Unmarshal([]byte(line), &entry); err != nil {
			t.Fatalf("expected JSON log line, got %q: %v", line, err)
		}
		switch entry["msg"] {
		case "request":
			status, ok := entry["status"].(float64)
			if !ok || int(status) != http.StatusForbidden {
				t.Fatalf("request log status = %v, want 403", entry["status"])
			}
			if entry["path"] != "/api/health" {
				t.Fatalf("request log path = %v, want /api/health", entry["path"])
			}
			if entry["correlation_id"] != reqID {
				t.Fatalf("request log correlation_id = %v, want %q", entry["correlation_id"], reqID)
			}
			sawRequestLog = true
		case "request refused":
			if entry["correlation_id"] != reqID {
				t.Fatalf("refusal log correlation_id = %v, want %q", entry["correlation_id"], reqID)
			}
			if entry["host"] != "evil.example" {
				t.Fatalf("refusal log host = %v, want evil.example", entry["host"])
			}
			sawRefusalLog = true
		}
	}
	if !sawRequestLog {
		t.Fatalf("missing LoggingMiddleware 403 request log line in:\n%s", buf.String())
	}
	if !sawRefusalLog {
		t.Fatalf("missing guard refusal warning log line in:\n%s", buf.String())
	}
}

// TestServeRefusesOriginThroughHandlerChain starts houston serve on a real
// loopback port and proves requests through the server's own handler chain are
// refused when carrying an Origin or non-loopback Host while Node-shaped
// loopback requests still succeed.
func TestServeRefusesOriginThroughHandlerChain(t *testing.T) {
	h := newServeHarness(t)
	cfg, err := loadServeConfig("", "")
	if err != nil {
		t.Fatalf("loadServeConfig: %v", err)
	}

	started := make(chan struct{})
	fakeStart := func(ctx context.Context, _ *vault.Service) error {
		close(started)
		<-ctx.Done()
		return ctx.Err()
	}

	ctx, stop := context.WithCancel(context.Background())
	defer stop()
	serveErrCh := make(chan error, 1)
	go func() {
		serveErrCh <- runServe(ctx, io.Discard, io.Discard, cfg, fakeStart)
	}()

	select {
	case <-started:
	case <-time.After(10 * time.Second):
		t.Fatalf("serve did not start")
	}

	waitHealth(t, h.baseURL, 10*time.Second)

	var buf bytes.Buffer
	original := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&buf, &slog.HandlerOptions{Level: slog.LevelInfo})))
	t.Cleanup(func() { slog.SetDefault(original) })

	client := &http.Client{Timeout: 5 * time.Second}

	// 1. Origin on GET /api/health is refused with 403.
	req, err := http.NewRequest(http.MethodGet, h.baseURL+"/api/health", nil)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	req.Header.Set("Origin", "http://evil.example")
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("GET with Origin: %v", err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("GET /api/health with Origin status = %d, want 403", resp.StatusCode)
	}

	// 2. Cross-site form POST to the write route is refused before the file is created.
	postReq, err := http.NewRequest(http.MethodPost, h.baseURL+"/api/vault/file?path=blocked.md", strings.NewReader("# blocked\n"))
	if err != nil {
		t.Fatalf("new post request: %v", err)
	}
	postReq.Header.Set("Origin", "http://evil.example")
	postReq.Header.Set("Content-Type", "text/plain")
	postResp, err := client.Do(postReq)
	if err != nil {
		t.Fatalf("POST with Origin: %v", err)
	}
	_ = postResp.Body.Close()
	if postResp.StatusCode != http.StatusForbidden {
		t.Fatalf("POST /api/vault/file with Origin status = %d, want 403", postResp.StatusCode)
	}
	if _, statErr := os.Stat(filepath.Join(h.vaultDir, "blocked.md")); !os.IsNotExist(statErr) {
		t.Fatalf("blocked.md must not be created by a refused POST (stat err = %v)", statErr)
	}

	// 3. Rebound Host header is refused with 403.
	rebindReq, err := http.NewRequest(http.MethodGet, h.baseURL+"/api/health", nil)
	if err != nil {
		t.Fatalf("new rebind request: %v", err)
	}
	rebindReq.Host = "evil.example"
	rebindResp, err := client.Do(rebindReq)
	if err != nil {
		t.Fatalf("GET with rebound Host: %v", err)
	}
	_ = rebindResp.Body.Close()
	if rebindResp.StatusCode != http.StatusForbidden {
		t.Fatalf("GET /api/health with rebound Host status = %d, want 403", rebindResp.StatusCode)
	}

	// 4. Node's fetch shape (sec-fetch-mode: cors, no Origin/Sec-Fetch-Site) succeeds.
	nodeReq, err := http.NewRequest(http.MethodGet, h.baseURL+"/api/health", nil)
	if err != nil {
		t.Fatalf("new node request: %v", err)
	}
	nodeReq.Header.Set("Sec-Fetch-Mode", "cors")
	nodeResp, err := client.Do(nodeReq)
	if err != nil {
		t.Fatalf("GET with Sec-Fetch-Mode: %v", err)
	}
	_ = nodeResp.Body.Close()
	if nodeResp.StatusCode != http.StatusOK {
		t.Fatalf("GET /api/health with Sec-Fetch-Mode status = %d, want 200", nodeResp.StatusCode)
	}

	// Confirm the server's logging middleware recorded the 403 refusals.
	if !strings.Contains(buf.String(), `"status":403`) {
		t.Fatalf("expected 403 request log in serve output, got:\n%s", buf.String())
	}

	stop()
	select {
	case err := <-serveErrCh:
		if err != nil {
			t.Fatalf("serve after cancel: %v", err)
		}
	case <-time.After(30 * time.Second):
		t.Fatalf("serve did not exit after cancel")
	}

	assertNoLockHeld(t, h.dbPath)
	assertPortClosed(t, fmt.Sprintf("127.0.0.1:%d", h.port))
}
