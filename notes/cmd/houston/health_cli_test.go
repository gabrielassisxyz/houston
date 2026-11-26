package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// healthCall records the route the CLI hit.
type healthCall struct {
	method string
	path   string
}

type fakeHealthAPI struct {
	server *httptest.Server
	calls  []healthCall
	status int
	body   string
}

func newFakeHealthAPI(t *testing.T, status int, body string) *fakeHealthAPI {
	t.Helper()
	f := &fakeHealthAPI{status: status, body: body}
	f.server = httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(f.server.Close)
	return f
}

func (f *fakeHealthAPI) serve(w http.ResponseWriter, r *http.Request) {
	f.calls = append(f.calls, healthCall{method: r.Method, path: r.URL.Path})
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(f.status)
	if f.body != "" {
		_, _ = io.WriteString(w, f.body)
	}
}

func (f *fakeHealthAPI) run(args ...string) (string, error) {
	var out bytes.Buffer
	err := runHealthCmd(&out, "", f.server.URL, false, args)
	return out.String(), err
}

func (f *fakeHealthAPI) only(t *testing.T) healthCall {
	t.Helper()
	if len(f.calls) != 1 {
		t.Fatalf("want exactly 1 API call, got %d: %+v", len(f.calls), f.calls)
	}
	return f.calls[0]
}

func TestHealthReportsStatus(t *testing.T) {
	body := `{"status":"ok","vaultRoot":"/home/u/vault","vaultLabel":"~/vault","indexing":false,"reports":{}}`

	fake := newFakeHealthAPI(t, http.StatusOK, body)
	out, err := fake.run()
	if err != nil {
		t.Fatalf("health: %v", err)
	}
	if call := fake.only(t); call.method != http.MethodGet || call.path != "/api/health" {
		t.Errorf("want GET /api/health, got %s %s", call.method, call.path)
	}
	for _, want := range []string{"ok", "~/vault", fake.server.URL} {
		if !strings.Contains(out, want) {
			t.Errorf("summary missing %q, got: %s", want, out)
		}
	}

	jsonFake := newFakeHealthAPI(t, http.StatusOK, body)
	var jsonOut bytes.Buffer
	if err := runHealthCmd(&jsonOut, "", jsonFake.server.URL, true, nil); err != nil {
		t.Fatalf("health --json: %v", err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(jsonOut.Bytes(), &decoded); err != nil {
		t.Fatalf("--json output must be the API body verbatim, got %q: %v", jsonOut.String(), err)
	}
	if decoded["vaultRoot"] != "/home/u/vault" {
		t.Errorf("--json lost fields: %v", decoded)
	}
}

func TestHealthPrintsIndexingAndReports(t *testing.T) {
	body := `{"status":"ok","vaultRoot":"/v","vaultLabel":"/v","indexing":true,"reports":{"empty_file":2,"duplicate_id":1}}`
	fake := newFakeHealthAPI(t, http.StatusOK, body)
	out, err := fake.run()
	if err != nil {
		t.Fatalf("health: %v", err)
	}
	if !strings.Contains(out, "indexing  true") {
		t.Errorf("health must print the indexing readiness, got: %q", out)
	}
	for _, want := range []string{"empty_file: 2", "duplicate_id: 1"} {
		if !strings.Contains(out, want) {
			t.Errorf("health must print the skipped-file counts (%q), got: %q", want, out)
		}
	}
}

func TestHealthWithoutAVaultSaysHowToSetOne(t *testing.T) {
	fake := newFakeHealthAPI(t, http.StatusOK, `{"status":"ok","vaultRoot":"","vaultLabel":"","indexing":false}`)
	out, err := fake.run()
	if err != nil {
		t.Fatalf("health: %v", err)
	}
	if strings.Contains(out, "kernl") {
		t.Fatalf("unconfigured vault hint must not name kernl, got: %q", out)
	}
	if !strings.Contains(out, "notes.yaml") || !strings.Contains(out, "HOUSTON_VAULT") {
		t.Errorf("a server with no vault must point at the houston fix, got: %s", out)
	}
}

func TestHealthAPIErrorsMapToExitCodes(t *testing.T) {
	missing := newFakeHealthAPI(t, http.StatusNotFound, `{"error":"no such route"}`)
	_, err := missing.run()
	if err == nil || exitCode(err) != 2 {
		t.Fatalf("a 404 must exit 2, got exit %d from %v", exitCode(err), err)
	}
	if !strings.Contains(err.Error(), "houston") {
		t.Errorf("API errors must carry the marker, got: %v", err)
	}
	if strings.Contains(strings.ToLower(err.Error()), "kernl") {
		t.Errorf("API error must not name kernl, got: %v", err)
	}

	broken := newFakeHealthAPI(t, http.StatusInternalServerError, `{"error":"boom"}`)
	if _, err := broken.run(); err == nil || exitCode(err) != 1 {
		t.Fatalf("a 500 must exit 1, got exit %d from %v", exitCode(err), err)
	}
}

func TestHealthUnreachableServerNamesTheFix(t *testing.T) {
	// A dead address is the case this verb exists for: the message has to say
	// where it looked and how to start a server there.
	var out bytes.Buffer
	err := runHealthCmd(&out, "", "http://127.0.0.1:1", false, nil)
	if err == nil {
		t.Fatal("an unreachable server must fail")
	}
	for _, want := range []string{"houston serve", "127.0.0.1:1"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("unreachable error missing %q, got: %v", want, err)
		}
	}
	if !strings.Contains(err.Error(), "no server answers") && !strings.Contains(err.Error(), "cannot reach") {
		t.Errorf("unreachable error must say nobody is home, got: %v", err)
	}
	if strings.Contains(strings.ToLower(err.Error()), "kernl") {
		t.Errorf("unreachable error must not name kernl, got: %v", err)
	}
}

func TestHealthRejectsStrayArguments(t *testing.T) {
	fake := newFakeHealthAPI(t, http.StatusOK, `{"status":"ok"}`)
	_, err := fake.run("extra")
	if err == nil {
		t.Fatalf("a stray argument must fail, got nil")
	}
	if exitCode(err) != 2 {
		t.Errorf("want usage error, got exit %d", exitCode(err))
	}
	if len(fake.calls) != 0 {
		t.Errorf("a rejected invocation must not reach the API: %+v", fake.calls)
	}
}
