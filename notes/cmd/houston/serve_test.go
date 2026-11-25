package main

// Integration test for houston serve and houston health.
//
// serve is driven in-process through runServe with a cancellable signal
// context, and the "signal" is a real SIGTERM sent to the test's own
// process: runServe builds no signal handling of its own, so the test owns
// the signal context the same way dispatch does in production. A backup
// Notify subscription keeps the process alive even if the SIGTERM lands
// after serve already exited (a failure the test must report, not die from).
//
// The first index is held open deterministically through runServe's
// startVault parameter: the fake blocks until the test has probed
// /api/health, proving the server answers while the vault is still being
// indexed. Without the hold the index of a small vault finishes in
// milliseconds and the overlap could never be observed reliably.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/gabrielassisxyz/houston/notes/internal/graph/dbfile"
	"github.com/gabrielassisxyz/houston/notes/internal/logging"
	"github.com/gabrielassisxyz/houston/notes/internal/vault"
)

func TestMain(m *testing.M) {
	// Quiet the request logs the health polls would otherwise write: the
	// assertions speak for the traffic.
	logging.Init("error")
	os.Exit(m.Run())
}

// serveHarness is a temporary vault plus a database path in a directory that
// does not exist yet, served on a reserved loopback port.
type serveHarness struct {
	vaultDir string
	dbPath   string
	port     int
	baseURL  string
}

func newServeHarness(t *testing.T) *serveHarness {
	t.Helper()
	tmp := t.TempDir()
	vaultDir := filepath.Join(tmp, "vault")
	if err := os.MkdirAll(vaultDir, 0o755); err != nil {
		t.Fatalf("creating vault dir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(vaultDir, "note-a.md"), []byte("# Hello\n\nA test note.\n"), 0o644); err != nil {
		t.Fatalf("writing fixture note: %v", err)
	}
	// The database directory is left uncreated on purpose: Acquire must
	// create it, and the test proves a fresh machine works.
	dbPath := filepath.Join(tmp, "db-dir", "notes.db")
	port := reservePort(t)

	t.Setenv("XDG_CONFIG_HOME", filepath.Join(tmp, "config-home"))
	t.Setenv("HOUSTON_VAULT", vaultDir)
	t.Setenv("HOUSTON_DB", dbPath)
	t.Setenv("HOUSTON_ADDR", fmt.Sprintf("127.0.0.1:%d", port))

	return &serveHarness{
		vaultDir: vaultDir,
		dbPath:   dbPath,
		port:     port,
		baseURL:  fmt.Sprintf("http://127.0.0.1:%d", port),
	}
}

func reservePort(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("reserving a port: %v", err)
	}
	defer func() { _ = ln.Close() }()
	return ln.Addr().(*net.TCPAddr).Port
}

// signalContext builds the signal context dispatch builds in production.
func signalContext() (context.Context, context.CancelFunc) {
	return signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
}

// selfSIGTERM sends a real SIGTERM to this process. The backup subscription
// keeps the process alive if serve already exited: the Kill must turn the
// test red, never kill the test binary.
func selfSIGTERM(t *testing.T) {
	t.Helper()
	backup := make(chan os.Signal, 1)
	signal.Notify(backup, syscall.SIGTERM)
	defer signal.Stop(backup)
	if err := syscall.Kill(syscall.Getpid(), syscall.SIGTERM); err != nil {
		t.Fatalf("sending SIGTERM to self: %v", err)
	}
	select {
	case <-backup:
	case <-time.After(5 * time.Second):
		t.Fatalf("self SIGTERM was not delivered")
	}
}

// waitHealth polls /api/health until it answers 200 or the timeout runs out,
// and returns the decoded document. A timeout fails the test: with the index
// held open, health must answer while indexing, which is the whole point.
func waitHealth(t *testing.T, baseURL string, timeout time.Duration) map[string]any {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for {
		resp, err := http.Get(baseURL + "/api/health")
		if err == nil {
			body, readErr := io.ReadAll(resp.Body)
			_ = resp.Body.Close()
			if readErr == nil && resp.StatusCode == http.StatusOK {
				var doc map[string]any
				if jerr := json.Unmarshal(body, &doc); jerr == nil {
					return doc
				}
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("GET %s/api/health did not answer 200 within %v", baseURL, timeout)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func assertNoLockHeld(t *testing.T, dbPath string) {
	t.Helper()
	release, err := dbfile.Acquire(dbPath)
	if err != nil {
		t.Fatalf("lock is still held after serve exited: %v", err)
	}
	if err := release(); err != nil {
		t.Fatalf("releasing the re-acquired lock: %v", err)
	}
}

func assertPortClosed(t *testing.T, addr string) {
	t.Helper()
	conn, err := net.DialTimeout("tcp", addr, 2*time.Second)
	if err == nil {
		_ = conn.Close()
		t.Fatalf("server still listens on %s after serve exited", addr)
	}
}

// TestServeAnswersHealthDuringFirstIndex holds the first index open and
// proves GET /api/health answers while it runs, then lets the index finish
// and stops the server cleanly with SIGTERM.
func TestServeAnswersHealthDuringFirstIndex(t *testing.T) {
	h := newServeHarness(t)
	cfg, err := loadServeConfig("", "")
	if err != nil {
		t.Fatalf("loadServeConfig: %v", err)
	}

	started := make(chan struct{})
	releaseIndex := make(chan struct{})
	indexDone := make(chan struct{})
	fakeStart := func(ctx context.Context, svc *vault.Service) error {
		close(started)
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-releaseIndex:
		}
		err := svc.Start(ctx)
		close(indexDone)
		return err
	}

	ctx, stop := signalContext()
	defer stop()
	serveErrCh := make(chan error, 1)
	go func() {
		serveErrCh <- runServe(ctx, io.Discard, io.Discard, cfg, fakeStart)
	}()

	select {
	case <-started:
	case <-time.After(10 * time.Second):
		t.Fatalf("serve did not reach the vault start")
	}

	// The index is still held open here: a 200 proves health answers while
	// the vault is being indexed.
	doc := waitHealth(t, h.baseURL, 10*time.Second)
	if doc["status"] != "ok" {
		t.Fatalf("health status = %v, want ok", doc["status"])
	}
	if doc["vaultRoot"] != h.vaultDir {
		t.Fatalf("health vaultRoot = %v, want %v", doc["vaultRoot"], h.vaultDir)
	}
	if label, _ := doc["vaultLabel"].(string); strings.TrimSpace(label) == "" {
		t.Fatalf("health vaultLabel is empty: %v", doc)
	}

	close(releaseIndex)
	select {
	case <-indexDone:
	case <-time.After(30 * time.Second):
		t.Fatalf("the released first index did not finish")
	}
	// Health still answers once the index is done.
	doc = waitHealth(t, h.baseURL, 10*time.Second)
	if doc["status"] != "ok" {
		t.Fatalf("health status after index = %v, want ok", doc["status"])
	}

	selfSIGTERM(t)
	select {
	case err := <-serveErrCh:
		if err != nil {
			t.Fatalf("serve after SIGTERM: %v", err)
		}
	case <-time.After(30 * time.Second):
		t.Fatalf("serve did not exit after SIGTERM")
	}

	assertNoLockHeld(t, h.dbPath)
	assertPortClosed(t, fmt.Sprintf("127.0.0.1:%d", h.port))
}

// TestServeSIGTERMDuringFirstIndexIsCleanStop keeps the first index blocked
// and proves SIGTERM in the middle of it is a clean stop: serve returns nil
// and leaves no lock held. Returning Start's context error without the
// shutdown would turn this case red.
func TestServeSIGTERMDuringFirstIndexIsCleanStop(t *testing.T) {
	h := newServeHarness(t)
	cfg, err := loadServeConfig("", "")
	if err != nil {
		t.Fatalf("loadServeConfig: %v", err)
	}

	started := make(chan struct{})
	fakeStart := func(ctx context.Context, svc *vault.Service) error {
		close(started)
		<-ctx.Done()
		return ctx.Err()
	}

	ctx, stop := signalContext()
	defer stop()
	serveErrCh := make(chan error, 1)
	go func() {
		serveErrCh <- runServe(ctx, io.Discard, io.Discard, cfg, fakeStart)
	}()

	select {
	case <-started:
	case <-time.After(10 * time.Second):
		t.Fatalf("serve did not reach the vault start")
	}

	// Health answers while the first index is still blocked.
	doc := waitHealth(t, h.baseURL, 10*time.Second)
	if doc["status"] != "ok" {
		t.Fatalf("health status during blocked index = %v, want ok", doc["status"])
	}

	selfSIGTERM(t)
	select {
	case err := <-serveErrCh:
		if err != nil {
			t.Fatalf("SIGTERM during the first index must be a clean stop, got: %v", err)
		}
	case <-time.After(30 * time.Second):
		t.Fatalf("serve did not exit after SIGTERM during the first index")
	}

	assertNoLockHeld(t, h.dbPath)
	assertPortClosed(t, fmt.Sprintf("127.0.0.1:%d", h.port))
}

// TestHealthPrintsAnswer starts a real service and proves houston health
// prints its answer, in human form and with --json.
func TestHealthPrintsAnswer(t *testing.T) {
	h := newServeHarness(t)
	cfg, err := loadServeConfig("", "")
	if err != nil {
		t.Fatalf("loadServeConfig: %v", err)
	}

	ctx, stop := signalContext()
	defer stop()
	serveErrCh := make(chan error, 1)
	go func() {
		serveErrCh <- runServe(ctx, io.Discard, io.Discard, cfg, realStartVault)
	}()
	waitHealth(t, h.baseURL, 30*time.Second)

	var human bytes.Buffer
	if err := runHealthCmd(&human, "", h.baseURL, false, nil); err != nil {
		t.Fatalf("health: %v", err)
	}
	out := human.String()
	if !strings.Contains(out, "ok") || !strings.Contains(out, h.baseURL) {
		t.Fatalf("human health output names neither status nor server: %q", out)
	}
	if !strings.Contains(out, h.vaultDir) && !strings.Contains(out, "~") {
		t.Fatalf("human health output names no vault: %q", out)
	}

	var asJSON bytes.Buffer
	if err := runHealthCmd(&asJSON, "", h.baseURL, true, nil); err != nil {
		t.Fatalf("health --json: %v", err)
	}
	var doc map[string]any
	if err := json.Unmarshal(asJSON.Bytes(), &doc); err != nil {
		t.Fatalf("health --json is not JSON: %v\n%s", err, asJSON.String())
	}
	if doc["status"] != "ok" || doc["vaultRoot"] != h.vaultDir {
		t.Fatalf("health --json document = %v, want status ok and vaultRoot %v", doc, h.vaultDir)
	}

	stop()
	select {
	case err := <-serveErrCh:
		if err != nil {
			t.Fatalf("serve after stop: %v", err)
		}
	case <-time.After(30 * time.Second):
		t.Fatalf("serve did not exit after stop")
	}
	assertNoLockHeld(t, h.dbPath)
}

// TestResolveHealthURLPrecedence pins the address order until A12 gives it:
// --server, then HOUSTON_ADDR, then the config file, then 127.0.0.1:3301.
func TestResolveHealthURLPrecedence(t *testing.T) {
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

// TestSplitHostPortRefusesScheme pins the shared contract of --addr and
// HOUSTON_ADDR: host:port, never a URL.
func TestSplitHostPortRefusesScheme(t *testing.T) {
	if _, _, err := splitHostPort("http://127.0.0.1:3301", "--addr"); err == nil {
		t.Fatalf("a value with a scheme must be refused")
	}
	host, port, err := splitHostPort("127.0.0.1:3311", "--addr")
	if err != nil || host != "127.0.0.1" || port != 3311 {
		t.Fatalf("host:port must parse: host=%q port=%d err=%v", host, port, err)
	}
}
