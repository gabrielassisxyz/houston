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

// searchCall records what the fake search API saw.
type searchCall struct {
	method string
	path   string
	query  string
}

type fakeSearchAPI struct {
	server *httptest.Server
	calls  []searchCall
	status int
	body   string
}

func newFakeSearchAPI(t *testing.T, status int, body string) *fakeSearchAPI {
	t.Helper()
	f := &fakeSearchAPI{status: status, body: body}
	f.server = httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(f.server.Close)
	return f
}

func (f *fakeSearchAPI) serve(w http.ResponseWriter, r *http.Request) {
	f.calls = append(f.calls, searchCall{method: r.Method, path: r.URL.Path, query: r.URL.RawQuery})
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(f.status)
	if f.body != "" {
		_, _ = io.WriteString(w, f.body)
	}
}

func (f *fakeSearchAPI) run(args ...string) (string, error) {
	var out bytes.Buffer
	err := runSearchCmd(&out, "", f.server.URL, false, args)
	return out.String(), err
}

func (f *fakeSearchAPI) only(t *testing.T) searchCall {
	t.Helper()
	if len(f.calls) != 1 {
		t.Fatalf("want exactly 1 API call, got %d: %+v", len(f.calls), f.calls)
	}
	return f.calls[0]
}

func TestSearchJoinsWordsAndStripsMarkers(t *testing.T) {
	// The snippet carries STX/ETX around the matched terms; text output reads
	// as prose.
	body := `{"hits":[{"id":"n1","title":"Rollout plan","path":"ops/rollout.md","kind":"plano","tags":["alpha"],"snippet":"the \u0002rollout\u0003 plan ships"}],"total":1,"limit":20,"offset":0}`
	fake := newFakeSearchAPI(t, http.StatusOK, body)
	out, err := fake.run("rollout", "plan")
	if err != nil {
		t.Fatalf("search: %v", err)
	}
	call := fake.only(t)
	if call.method != http.MethodGet || call.path != "/api/search" {
		t.Fatalf("want GET /api/search, got %s %s", call.method, call.path)
	}
	if !strings.Contains(call.query, "q=rollout+plan") {
		t.Errorf("words must join with spaces, got query %q", call.query)
	}
	for _, want := range []string{"Rollout plan", "ops/rollout.md", "plano", "alpha", "the rollout plan ships"} {
		if !strings.Contains(out, want) {
			t.Errorf("text block missing %q, got: %q", want, out)
		}
	}
	if strings.Contains(out, "\x02") || strings.Contains(out, "\x03") {
		t.Errorf("markers must be stripped in text output, got: %q", out)
	}
	if !strings.Contains(out, "1 total") {
		t.Errorf("last line must carry the total, got: %q", out)
	}
}

func TestSearchSendsFilters(t *testing.T) {
	fake := newFakeSearchAPI(t, http.StatusOK, `{"hits":[],"total":0,"limit":5,"offset":2}`)
	out, err := fake.run("common", "--tag", "alpha", "--folder", "ops", "--kind", "plano", "--limit", "5", "--offset", "2")
	if err != nil {
		t.Fatalf("search with filters: %v", err)
	}
	call := fake.only(t)
	for _, want := range []string{"q=common", "tag=alpha", "folder=ops", "kind=plano", "limit=5", "offset=2"} {
		if !strings.Contains(call.query, want) {
			t.Errorf("query missing %q, got %q", want, call.query)
		}
	}
	if !strings.Contains(out, "0 total") {
		t.Errorf("empty result must still print the total, got: %q", out)
	}
}

func TestSearchJSONPassesThrough(t *testing.T) {
	body := `{"hits":[{"id":"n1","title":"A","path":"a.md","kind":"nota","tags":[],"snippet":"x"}],"total":1,"limit":20,"offset":0}`
	fake := newFakeSearchAPI(t, http.StatusOK, body)
	var out bytes.Buffer
	if err := runSearchCmd(&out, "", fake.server.URL, true, []string{"a"}); err != nil {
		t.Fatalf("search --json: %v", err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(out.Bytes(), &decoded); err != nil {
		t.Fatalf("--json must emit JSON, got %q", out.String())
	}
	if decoded["total"] != float64(1) {
		t.Errorf("total lost: %v", decoded)
	}
}

func TestSearchRequiresAQuery(t *testing.T) {
	fake := newFakeSearchAPI(t, http.StatusOK, `{"hits":[],"total":0,"limit":20,"offset":0}`)
	_, err := fake.run("--tag", "alpha")
	if err == nil || !strings.Contains(err.Error(), "requires a query") {
		t.Fatalf("missing query must fail loud, got: %v", err)
	}
	if exitCode(err) != 2 {
		t.Errorf("want usage error, got exit %d", exitCode(err))
	}
	if len(fake.calls) != 0 {
		t.Errorf("a rejected invocation must not reach the API: %+v", fake.calls)
	}
}

func TestSearchRejectsBadKindLimitOffset(t *testing.T) {
	fake := newFakeSearchAPI(t, http.StatusOK, `{"hits":[],"total":0,"limit":20,"offset":0}`)
	for _, args := range [][]string{
		{"q", "--kind", "bogus"},
		{"q", "--limit", "0"},
		{"q", "--limit", "abc"},
		{"q", "--offset", "-1"},
	} {
		_, err := fake.run(args...)
		if err == nil || exitCode(err) != 2 {
			t.Fatalf("%v must be a usage error, got: %v", args, err)
		}
	}
	if len(fake.calls) != 0 {
		t.Errorf("rejected invocations must not reach the API: %+v", fake.calls)
	}
}
