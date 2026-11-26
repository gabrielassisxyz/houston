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

// linksCall records what the fake hub saw: the escaped path proves the
// identifier travelled path-escaped, not raw.
type linksCall struct {
	method      string
	path        string
	escapedPath string
}

type fakeLinksAPI struct {
	server *httptest.Server
	calls  []linksCall
	status int
	body   string
}

func newFakeLinksAPI(t *testing.T, status int, body string) *fakeLinksAPI {
	t.Helper()
	f := &fakeLinksAPI{status: status, body: body}
	f.server = httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(f.server.Close)
	return f
}

func (f *fakeLinksAPI) serve(w http.ResponseWriter, r *http.Request) {
	f.calls = append(f.calls, linksCall{method: r.Method, path: r.URL.Path, escapedPath: r.URL.EscapedPath()})
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(f.status)
	if f.body != "" {
		_, _ = io.WriteString(w, f.body)
	}
}

func (f *fakeLinksAPI) run(t *testing.T, args ...string) (string, error) {
	t.Helper()
	t.Setenv("HOUSTON_HUB_URL", f.server.URL)
	var out bytes.Buffer
	err := runLinksCmd(&out, "", "", false, args)
	return out.String(), err
}

func (f *fakeLinksAPI) runJSON(t *testing.T, args ...string) (string, error) {
	t.Helper()
	t.Setenv("HOUSTON_HUB_URL", f.server.URL)
	var out bytes.Buffer
	err := runLinksCmd(&out, "", "", true, args)
	return out.String(), err
}

func (f *fakeLinksAPI) only(t *testing.T) linksCall {
	t.Helper()
	if len(f.calls) != 1 {
		t.Fatalf("want exactly 1 hub call, got %d: %+v", len(f.calls), f.calls)
	}
	return f.calls[0]
}

// linksBodyWithNotes answers the phase-2 contract: the ticket, one bead with
// its chain, the top-level notes, and one unreadable project.
func linksBodyWithNotes() string {
	return `{
		"id": "STRY00000001",
		"snapshot": {"available": true},
		"ticket": {"state": "found", "source": "stories", "number": "STRY00000001", "title": "Synthetic story", "status": "open", "link": "https://example.com/STRY00000001", "approvals": [], "freshness": "live"},
		"beads": [{
			"projectId": "proj-a",
			"projectName": "Example A",
			"chain": {
				"bead": {"id": "hou-1", "projectId": "proj-a", "type": "epic", "status": "open", "title": "The epic", "externalRef": "STRY00000001"},
				"tracker": {"state": "found", "source": "stories", "number": "STRY00000001", "title": "Synthetic story", "status": "open", "link": "https://example.com/STRY00000001", "approvals": [], "freshness": "live"},
				"descendants": [{"id": "hou-2", "type": "task", "status": "open", "title": "The child", "tracker": null}],
				"pipeline": {"state": "found", "freshness": "live", "runs": [{"id": 7, "createdAt": "2026-01-01T00:00:00Z", "status": "completed", "conclusion": "success", "head": "abc", "link": "https://github.com/org/repo-a/actions/runs/7", "existingPrs": []}], "prs": [], "issues": [], "changes": []},
				"notes": {"state": "available", "plano": [{"id": "stub-plano", "title": "Stub plan", "path": "plans/stub.md", "kind": "plano", "tags": [], "matchedRefs": ["STRY00000001"]}], "implementacao": [], "evidencia": [], "nota": [], "linked": [], "linkedOmitted": 0},
				"snapshot": {"available": true}
			}
		}],
		"unreadable": [{"id": "proj-c", "name": "Broken project", "error": "boom"}],
		"notes": {"state": "available", "plano": [{"id": "stub-plano", "title": "Stub plan", "path": "plans/stub.md", "kind": "plano", "tags": [], "matchedRefs": ["STRY00000001"]}], "implementacao": [], "evidencia": [], "nota": [], "linked": [], "linkedOmitted": 0}
	}`
}

// linksBodyWithoutNotes is the same answer with both notes parts left out,
// as the hub sends them when no notes service is configured.
func linksBodyWithoutNotes() string {
	return `{
		"id": "STRY00000001",
		"snapshot": {"available": true},
		"ticket": {"state": "found", "source": "stories", "number": "STRY00000001", "title": "Synthetic story", "status": "open", "link": "https://example.com/STRY00000001", "approvals": [], "freshness": "live"},
		"beads": [{
			"projectId": "proj-a",
			"projectName": "Example A",
			"chain": {
				"bead": {"id": "hou-1", "projectId": "proj-a", "type": "epic", "status": "open", "title": "The epic", "externalRef": "STRY00000001"},
				"tracker": {"state": "found", "source": "stories", "number": "STRY00000001", "title": "Synthetic story", "status": "open", "link": "https://example.com/STRY00000001", "approvals": [], "freshness": "live"},
				"descendants": [],
				"snapshot": {"available": true}
			}
		}],
		"unreadable": []
	}`
}

func TestLinksPrintsTicketBeadsNotesUnreadable(t *testing.T) {
	fake := newFakeLinksAPI(t, http.StatusOK, linksBodyWithNotes())
	out, err := fake.run(t, "STRY00000001")
	if err != nil {
		t.Fatalf("links: %v", err)
	}
	call := fake.only(t)
	if call.method != http.MethodGet || call.escapedPath != "/api/links/STRY00000001" {
		t.Fatalf("want GET /api/links/STRY00000001, got %s %s", call.method, call.escapedPath)
	}
	for _, want := range []string{
		"STRY00000001", "Synthetic story", "snapshot: available",
		"hou-1", "The epic", "Example A", "hou-2", "The child",
		"stub-plano", "Broken project", "boom",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("text output missing %q, got:\n%s", want, out)
		}
	}
}

func TestLinksWithoutTopLevelNotesPrintsWithoutError(t *testing.T) {
	fake := newFakeLinksAPI(t, http.StatusOK, linksBodyWithoutNotes())
	out, err := fake.run(t, "STRY00000001")
	if err != nil {
		t.Fatalf("links without notes: %v", err)
	}
	for _, want := range []string{"STRY00000001", "hou-1", "The epic"} {
		if !strings.Contains(out, want) {
			t.Errorf("text output missing %q, got:\n%s", want, out)
		}
	}
	if strings.Contains(out, "stub-plano") {
		t.Errorf("no notes were answered, none must print, got:\n%s", out)
	}
}

func TestLinksEscapesTheIdentifier(t *testing.T) {
	fake := newFakeLinksAPI(t, http.StatusOK, linksBodyWithoutNotes())
	_, err := fake.run(t, "a/b c")
	if err != nil {
		t.Fatalf("links with an escapable id: %v", err)
	}
	call := fake.only(t)
	if call.escapedPath != "/api/links/a%2Fb%20c" {
		t.Fatalf("identifier must travel path-escaped, got %q", call.escapedPath)
	}
}

func TestLinksUnreachableNamesHubVar(t *testing.T) {
	t.Setenv("HOUSTON_HUB_URL", "http://127.0.0.1:1")
	var out bytes.Buffer
	err := runLinksCmd(&out, "", "", false, []string{"STRY00000001"})
	if err == nil {
		t.Fatal("a missing hub must fail")
	}
	if !strings.Contains(err.Error(), "HOUSTON_HUB_URL") {
		t.Fatalf("unreachable error must name HOUSTON_HUB_URL, got: %v", err)
	}
	if exitCode(err) != 1 {
		t.Errorf("an unreachable hub is a runtime error, got exit %d", exitCode(err))
	}
}

func TestLinksJSONPassesThrough(t *testing.T) {
	fake := newFakeLinksAPI(t, http.StatusOK, linksBodyWithNotes())
	out, err := fake.runJSON(t, "STRY00000001")
	if err != nil {
		t.Fatalf("links --json: %v", err)
	}
	var decoded map[string]any
	if err := json.Unmarshal([]byte(out), &decoded); err != nil {
		t.Fatalf("--json must emit the hub body verbatim, got %q: %v", out, err)
	}
	if decoded["id"] != "STRY00000001" {
		t.Errorf("id lost: %v", decoded)
	}
	if _, ok := decoded["ticket"]; !ok {
		t.Errorf("ticket lost: %v", decoded)
	}
}

func TestLinksLocalJSONFlagPassesThrough(t *testing.T) {
	fake := newFakeLinksAPI(t, http.StatusOK, linksBodyWithNotes())
	out, err := fake.run(t, "STRY00000001", "--json")
	if err != nil {
		t.Fatalf("links --json: %v", err)
	}
	var decoded map[string]any
	if err := json.Unmarshal([]byte(out), &decoded); err != nil {
		t.Fatalf("--json must emit JSON, got %q: %v", out, err)
	}
}

func TestLinksRequiresExactlyOneIdentifier(t *testing.T) {
	fake := newFakeLinksAPI(t, http.StatusOK, linksBodyWithNotes())
	for _, args := range [][]string{{}, {"a", "b"}, {"   "}} {
		var out bytes.Buffer
		t.Setenv("HOUSTON_HUB_URL", fake.server.URL)
		err := runLinksCmd(&out, "", "", false, args)
		if err == nil || exitCode(err) != 2 {
			t.Fatalf("%v must be a usage error, got: %v", args, err)
		}
	}
	if len(fake.calls) != 0 {
		t.Errorf("rejected invocations must not reach the hub: %+v", fake.calls)
	}
}

func TestLinksRejectsUnknownFlags(t *testing.T) {
	fake := newFakeLinksAPI(t, http.StatusOK, linksBodyWithNotes())
	var out bytes.Buffer
	t.Setenv("HOUSTON_HUB_URL", fake.server.URL)
	err := runLinksCmd(&out, "", "", false, []string{"STRY00000001", "--bogus"})
	if err == nil || !strings.Contains(err.Error(), "unknown flag") {
		t.Fatalf("unknown flag must fail loud, got: %v", err)
	}
	if exitCode(err) != 2 {
		t.Errorf("want usage error, got exit %d", exitCode(err))
	}
	if len(fake.calls) != 0 {
		t.Errorf("a rejected invocation must not reach the hub: %+v", fake.calls)
	}
}

func TestLinksRejectsServerFlag(t *testing.T) {
	fake := newFakeLinksAPI(t, http.StatusOK, linksBodyWithNotes())
	var out bytes.Buffer
	t.Setenv("HOUSTON_HUB_URL", fake.server.URL)
	err := runLinksCmd(&out, "", "http://127.0.0.1:3301", false, []string{"STRY00000001"})
	if err == nil || exitCode(err) != 2 {
		t.Fatalf("--server must be refused for the hub verb, got: %v", err)
	}
	if !strings.Contains(err.Error(), "HOUSTON_HUB_URL") {
		t.Fatalf("refusal must point at HOUSTON_HUB_URL, got: %v", err)
	}
	if len(fake.calls) != 0 {
		t.Errorf("a rejected invocation must not reach the hub: %+v", fake.calls)
	}
}

func TestLinksHubAPIErrorsMapToExitCodes(t *testing.T) {
	badRequest := newFakeLinksAPI(t, http.StatusBadRequest, `{"error":"bad id"}`)
	t.Setenv("HOUSTON_HUB_URL", badRequest.server.URL)
	var out bytes.Buffer
	err := runLinksCmd(&out, "", "", false, []string{"STRY00000001"})
	if err == nil || exitCode(err) != 2 {
		t.Fatalf("a 400 must exit 2, got exit %d from %v", exitCode(err), err)
	}

	broken := newFakeLinksAPI(t, http.StatusInternalServerError, `{"error":"boom"}`)
	t.Setenv("HOUSTON_HUB_URL", broken.server.URL)
	if err := runLinksCmd(&out, "", "", false, []string{"STRY00000001"}); err == nil || exitCode(err) != 1 {
		t.Fatalf("a 500 must exit 1, got exit %d from %v", exitCode(err), err)
	}
}

func TestLinksDefaultAddressAndTrailingSlash(t *testing.T) {
	t.Setenv("HOUSTON_HUB_URL", "")
	got, err := hubBaseURL()
	if err != nil {
		t.Fatalf("empty HOUSTON_HUB_URL: %v", err)
	}
	if got != "http://127.0.0.1:3300" {
		t.Errorf("default hub address wrong, got %q", got)
	}

	t.Setenv("HOUSTON_HUB_URL", "http://127.0.0.1:3300/")
	got, err = hubBaseURL()
	if err != nil {
		t.Fatalf("trailing slash: %v", err)
	}
	if got != "http://127.0.0.1:3300" {
		t.Errorf("trailing / must be dropped, got %q", got)
	}

	t.Setenv("HOUSTON_HUB_URL", "http://[::1")
	if _, err := hubBaseURL(); err == nil {
		t.Fatal("a malformed HOUSTON_HUB_URL must fail")
	}
}

func TestLinksUnavailableSnapshotAndTicketPrint(t *testing.T) {
	body := `{
		"id": "INC00000001",
		"snapshot": {"available": false, "reason": "no snapshot file"},
		"ticket": {"state": "unconfirmed", "reason": "no snapshot file", "approvals": []},
		"beads": [],
		"unreadable": []
	}`
	fake := newFakeLinksAPI(t, http.StatusOK, body)
	out, err := fake.run(t, "INC00000001")
	if err != nil {
		t.Fatalf("links with an unavailable snapshot: %v", err)
	}
	for _, want := range []string{"unavailable", "no snapshot file", "unconfirmed", "beads (0)", "unreadable (0)"} {
		if !strings.Contains(out, want) {
			t.Errorf("text output missing %q, got:\n%s", want, out)
		}
	}
}
