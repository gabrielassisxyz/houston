package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// noteAPI is a stand-in for a running `houston serve`: it records what the verb
// asked for so a test can assert the method, path and body the CLI produced.
type noteAPI struct {
	server   *httptest.Server
	requests []recordedRequest
}

type recordedRequest struct {
	method string
	path   string
	query  string
	body   string
	client string // X-Houston-Client header value
}

func newNoteAPI(t *testing.T, respond func(w http.ResponseWriter, r *http.Request)) *noteAPI {
	t.Helper()
	api := &noteAPI{}
	api.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		api.requests = append(api.requests, recordedRequest{
			method: r.Method, path: r.URL.Path, query: r.URL.RawQuery, body: string(body),
			client: r.Header.Get("X-Houston-Client"),
		})
		respond(w, r)
	}))
	t.Cleanup(api.server.Close)
	return api
}

func (a *noteAPI) run(t *testing.T, args ...string) (string, error) {
	t.Helper()
	var out bytes.Buffer
	err := runNoteCmd(&out, "", a.server.URL, false, args)
	return out.String(), err
}

func jsonResponse(payload string) func(http.ResponseWriter, *http.Request) {
	return func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, payload)
	}
}

// requireRefusedWithoutYes asserts the shared contract of the --yes gate: the
// verb previewed, wrote nothing, and ended at exit 2 rather than 0.
func requireRefusedWithoutYes(t *testing.T, err error, verb string) {
	t.Helper()
	if err == nil {
		t.Fatalf("%s without --yes must not exit 0 - an agent branching on $? reads that as done", verb)
	}
	if got := exitCode(err); got != 2 {
		t.Fatalf("%s without --yes must exit 2, got %d (%v)", verb, got, err)
	}
	var reported alreadyReported
	if !errors.As(err, &reported) {
		t.Fatalf("%s refusal must be marked already-reported so main does not print past the preview, got %v", verb, err)
	}
	if !strings.Contains(err.Error(), "--yes") {
		t.Errorf("%s refusal must name the flag that unblocks it, got: %v", verb, err)
	}
}

func TestNoteListPrintsPathTypeAndTitle(t *testing.T) {
	api := newNoteAPI(t, jsonResponse(`[{"path":"a.md","id":"1","type":"note","title":"A"}]`))
	out, err := api.run(t, "list")
	if err != nil {
		t.Fatalf("note list: %v", err)
	}
	if api.requests[0].method != http.MethodGet || api.requests[0].path != "/api/vault/notes" {
		t.Fatalf("wrong call: %+v", api.requests[0])
	}
	if !strings.Contains(out, "a.md\tnote\tA") {
		t.Fatalf("unexpected output: %q", out)
	}
}

func TestNoteListFilesUsesVaultList(t *testing.T) {
	api := newNoteAPI(t, jsonResponse(`{"files":["a.md","sub/b.md"]}`))
	out, err := api.run(t, "list", "--files")
	if err != nil {
		t.Fatalf("note list --files: %v", err)
	}
	if api.requests[0].path != "/api/vault/list" {
		t.Fatalf("wrong route: %+v", api.requests[0])
	}
	if !strings.Contains(out, "sub/b.md") {
		t.Fatalf("unexpected output: %q", out)
	}
}

// --author ai keeps only the notes the assistant wrote (resolved author with
// an "agent:" prefix). Removing the filter would print both notes, so this
// test is the guard that fails when the filter is removed.
func TestNoteListAuthorFilterAI(t *testing.T) {
	api := newNoteAPI(t, jsonResponse(`[
		{"path":"a.md","id":"1","type":"note","title":"A","author":"agent:da"},
		{"path":"b.md","id":"2","type":"note","title":"B","author":"human"}
	]`))
	out, err := api.run(t, "list", "--author", "ai")
	if err != nil {
		t.Fatalf("note list --author ai: %v", err)
	}
	if !strings.Contains(out, "a.md") || strings.Contains(out, "b.md") {
		t.Fatalf("--author ai must list only assistant notes, got %q", out)
	}
}

// --author me is the complement: everything the assistant did not write.
func TestNoteListAuthorFilterMe(t *testing.T) {
	api := newNoteAPI(t, jsonResponse(`[
		{"path":"a.md","id":"1","type":"note","title":"A","author":"agent:da"},
		{"path":"b.md","id":"2","type":"note","title":"B","author":"human"}
	]`))
	out, err := api.run(t, "list", "--author", "me")
	if err != nil {
		t.Fatalf("note list --author me: %v", err)
	}
	if strings.Contains(out, "a.md") || !strings.Contains(out, "b.md") {
		t.Fatalf("--author me must list only user notes, got %q", out)
	}
}

// The raw resolved spellings stay accepted for callers that know them: an
// exact match, not the ai/me vocabulary.
func TestNoteListAuthorFilterRawValue(t *testing.T) {
	api := newNoteAPI(t, jsonResponse(`[
		{"path":"a.md","id":"1","type":"note","title":"A","author":"agent:da"},
		{"path":"b.md","id":"2","type":"note","title":"B","author":"human"}
	]`))
	out, err := api.run(t, "list", "--author", "agent:da")
	if err != nil {
		t.Fatalf("note list --author agent:da: %v", err)
	}
	if !strings.Contains(out, "a.md") || strings.Contains(out, "b.md") {
		t.Fatalf("--author agent:da must match exactly, got %q", out)
	}
}

// --author and --files answer different questions (indexed notes vs files on
// disk), so asking for both at once is a usage error rather than a silent
// ignore.
func TestNoteListAuthorRejectsFiles(t *testing.T) {
	api := newNoteAPI(t, jsonResponse(`{"files":[]}`))
	_, err := api.run(t, "list", "--files", "--author", "ai")
	if err == nil || exitCode(err) != 2 {
		t.Fatalf("--author with --files must be a usage error, got: %v", err)
	}
	if len(api.requests) != 0 {
		t.Fatalf("nothing must reach the server, got %d requests", len(api.requests))
	}
}

func TestNoteReadWritesRawBytes(t *testing.T) {
	api := newNoteAPI(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		_, _ = io.WriteString(w, "# Title\nbody\n")
	})
	out, err := api.run(t, "read", "notes/x.md")
	if err != nil {
		t.Fatalf("note read: %v", err)
	}
	if out != "# Title\nbody\n" {
		t.Fatalf("read must pipe byte-exact, got %q", out)
	}
	if api.requests[0].query != "path=notes%2Fx.md" {
		t.Fatalf("path must travel as a query param, got %q", api.requests[0].query)
	}
}

func TestNoteReadJSONWrapsTheTextBody(t *testing.T) {
	api := newNoteAPI(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, "hello")
	})
	out, err := api.run(t, "read", "x.md", "--json")
	if err != nil {
		t.Fatalf("note read --json: %v", err)
	}
	var decoded map[string]string
	if err := json.Unmarshal([]byte(out), &decoded); err != nil {
		t.Fatalf("--json must emit JSON, got %q", out)
	}
	if decoded["content"] != "hello" || decoded["path"] != "x.md" {
		t.Fatalf("unexpected envelope: %v", decoded)
	}
}

// A successful write's --json output is the server's own document, status
// field included - a caller must be able to read the outcome from the
// response alone.
func TestNoteWriteJSONCarriesStatusOnSuccess(t *testing.T) {
	api := newNoteAPI(t, jsonResponse(`{"status":"saved","suggestions":null,"accepted":null,"rejected":null}`))
	local := filepath.Join(t.TempDir(), "draft.md")
	if err := os.WriteFile(local, []byte("# Draft\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	out, err := api.run(t, "write", "notes/x.md", "--file", local, "--json")
	if err != nil {
		t.Fatalf("note write --json: %v", err)
	}
	var doc struct {
		Status string `json:"status"`
	}
	if err := json.Unmarshal([]byte(out), &doc); err != nil {
		t.Fatalf("--json must emit JSON, got %q", out)
	}
	if doc.Status != "saved" {
		t.Fatalf("status = %q, want %q", doc.Status, "saved")
	}
}

// A 200 response whose body carries no status must not be printed as a success
// document with exit 0. The CLI turns it into a document whose status says the
// outcome is unknown and exits non-zero, so no caller can mistake it for a
// landed write.
func TestNoteWriteJSONStatusless200IsNeverASilentSuccess(t *testing.T) {
	for _, body := range []string{`{}`, ``} {
		t.Run(fmt.Sprintf("body=%q", body), func(t *testing.T) {
			api := newNoteAPI(t, func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				_, _ = io.WriteString(w, body)
			})
			local := filepath.Join(t.TempDir(), "draft.md")
			if err := os.WriteFile(local, []byte("# Draft\n"), 0o644); err != nil {
				t.Fatal(err)
			}
			out, err := api.run(t, "write", "notes/x.md", "--file", local, "--json")
			if err == nil {
				t.Fatalf("a statusless response must not exit 0, got %q", out)
			}
			var doc struct {
				Status string `json:"status"`
				Error  string `json:"error"`
			}
			if err := json.Unmarshal([]byte(out), &doc); err != nil {
				t.Fatalf("--json must emit a JSON document, got %q", out)
			}
			if doc.Status == "" || doc.Status == "saved" {
				t.Fatalf("a statusless response must not claim saved; got status %q, error %q", doc.Status, doc.Error)
			}
			if !strings.Contains(doc.Error, "retry") {
				t.Errorf("the document must tell the caller a retry is safe, got: %q", doc.Error)
			}
			if exitCode(err) != 1 {
				t.Errorf("a statusless response must exit 1, got %d", exitCode(err))
			}
			var reported alreadyReported
			if !errors.As(err, &reported) {
				t.Error("the failure must be marked already-reported so main does not overwrite stdout")
			}
		})
	}
}

// The server's failure document (a status-carrying JSON error) passes through
// on stdout, and the process still exits non-zero.
func TestNoteWriteJSONServerErrorDocumentPassesThrough(t *testing.T) {
	api := newNoteAPI(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = io.WriteString(w, `{"status":"error","error":"boom"}`)
	})
	local := filepath.Join(t.TempDir(), "draft.md")
	if err := os.WriteFile(local, []byte("# Draft\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	out, err := api.run(t, "write", "notes/x.md", "--file", local, "--json")
	if err == nil {
		t.Fatal("a failed write must not exit 0")
	}
	var doc struct {
		Status string `json:"status"`
		Error  string `json:"error"`
	}
	if err := json.Unmarshal([]byte(out), &doc); err != nil {
		t.Fatalf("--json must emit the server's document, got %q", out)
	}
	if doc.Status != "error" || !strings.Contains(doc.Error, "boom") {
		t.Fatalf("the server's error document must pass through, got %q", out)
	}
	if strings.Contains(doc.Error, "houston:") {
		t.Fatalf("the server's document must not be re-wrapped by the CLI, got %q", out)
	}
	if exitCode(err) != 1 {
		t.Errorf("a 5xx write must exit 1, got %d", exitCode(err))
	}
	var reported alreadyReported
	if !errors.As(err, &reported) {
		t.Error("the failure must be marked already-reported so main does not overwrite stdout")
	}
}

// A failure whose body is not a status document must still produce a document
// a caller can act on - synthesized from the error, never an empty stdout.
func TestNoteWriteJSONPlainTextErrorSynthesizesDocument(t *testing.T) {
	api := newNoteAPI(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = io.WriteString(w, "disk full\n")
	})
	local := filepath.Join(t.TempDir(), "draft.md")
	if err := os.WriteFile(local, []byte("# Draft\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	out, err := api.run(t, "write", "notes/x.md", "--file", local, "--json")
	if err == nil {
		t.Fatal("a failed write must not exit 0")
	}
	var doc struct {
		Status string `json:"status"`
	}
	if err := json.Unmarshal([]byte(out), &doc); err != nil {
		t.Fatalf("--json must emit a JSON document, got %q", out)
	}
	if doc.Status != "error" {
		t.Fatalf("status = %q, want %q", doc.Status, "error")
	}
}

// A write that cannot reach the server at all still speaks the contract: a
// synthesized error document on stdout, exit 1 - never a silent success.
func TestNoteWriteJSONUnreachableSynthesizesDocument(t *testing.T) {
	// A port nothing listens on: dial fails, no response ever exists.
	var out bytes.Buffer
	local := filepath.Join(t.TempDir(), "draft.md")
	if err := os.WriteFile(local, []byte("# Draft\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	c := &apiClient{baseURL: "http://127.0.0.1:1", http: http.DefaultClient}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	err := runNoteWrite(ctx, c, &out, true, []string{"notes/x.md", "--file", local})
	if err == nil {
		t.Fatal("an unreachable server must not exit 0")
	}
	var doc struct {
		Status string `json:"status"`
	}
	if err := json.Unmarshal(out.Bytes(), &doc); err != nil {
		t.Fatalf("--json must emit a JSON document, got %q", out.String())
	}
	if doc.Status != "error" {
		t.Fatalf("status = %q, want %q", doc.Status, "error")
	}
	if exitCode(err) != 1 {
		t.Errorf("an unreachable server must exit 1, got %d", exitCode(err))
	}
}

func TestNoteWriteSendsFileBodyVerbatim(t *testing.T) {
	api := newNoteAPI(t, jsonResponse(`{"status":"saved"}`))
	local := filepath.Join(t.TempDir(), "draft.md")
	if err := os.WriteFile(local, []byte("# Draft\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := api.run(t, "write", "notes/x.md", "--file", local); err != nil {
		t.Fatalf("note write: %v", err)
	}
	req := api.requests[0]
	if req.method != http.MethodPost || req.path != "/api/vault/file" {
		t.Fatalf("wrong call: %+v", req)
	}
	// The markdown must arrive raw - JSON-encoding it would write a quoted
	// string into the vault.
	if req.body != "# Draft\n" {
		t.Fatalf("body must be verbatim markdown, got %q", req.body)
	}
}

// The CLI is the assistant's write path, so it must identify itself as cli: the
// header stays so a suggestion step wired back in can tell cli from the UI.
func TestNoteWriteSendsCLIClientHeader(t *testing.T) {
	api := newNoteAPI(t, jsonResponse(`{"status":"saved"}`))
	local := filepath.Join(t.TempDir(), "draft.md")
	if err := os.WriteFile(local, []byte("# Draft\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := api.run(t, "write", "notes/x.md", "--file", local); err != nil {
		t.Fatalf("note write: %v", err)
	}
	if api.requests[0].client != "cli" {
		t.Fatalf("X-Houston-Client = %q, want %q", api.requests[0].client, "cli")
	}
}

// --tags must reach the server as a query param, comma-list encoded verbatim.
func TestNoteWriteTagsTravelsOnTheWire(t *testing.T) {
	api := newNoteAPI(t, jsonResponse(`{"status":"saved"}`))
	local := filepath.Join(t.TempDir(), "draft.md")
	if err := os.WriteFile(local, []byte("# Draft\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := api.run(t, "write", "notes/x.md", "--file", local, "--tags", "handoff,checkpoint"); err != nil {
		t.Fatalf("note write: %v", err)
	}
	if !strings.Contains(api.requests[0].query, "tags=handoff%2Ccheckpoint") {
		t.Fatalf("tags must travel as a query param, got %q", api.requests[0].query)
	}
}

// '--tags ""' (clear every tag) must reach the server as the param being
// PRESENT with an empty value, never as the param being absent.
func TestNoteWriteEmptyTagsStillTravelsAsPresent(t *testing.T) {
	api := newNoteAPI(t, jsonResponse(`{"status":"saved"}`))
	local := filepath.Join(t.TempDir(), "draft.md")
	if err := os.WriteFile(local, []byte("# Draft\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := api.run(t, "write", "notes/x.md", "--file", local, "--tags", ""); err != nil {
		t.Fatalf("note write: %v", err)
	}
	if !strings.Contains(api.requests[0].query, "tags=") {
		t.Fatalf("an empty --tags must still send the param, got %q", api.requests[0].query)
	}
}

// Omitting --tags entirely must leave the note's existing tags untouched, which
// only works if the param is never sent at all.
func TestNoteWriteWithoutTagsOmitsTheParam(t *testing.T) {
	api := newNoteAPI(t, jsonResponse(`{"status":"saved"}`))
	local := filepath.Join(t.TempDir(), "draft.md")
	if err := os.WriteFile(local, []byte("# Draft\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := api.run(t, "write", "notes/x.md", "--file", local); err != nil {
		t.Fatalf("note write: %v", err)
	}
	if strings.Contains(api.requests[0].query, "tags") {
		t.Fatalf("omitting --tags must not send the param at all, got %q", api.requests[0].query)
	}
}

func TestNoteWriteWithoutSourceOrStdinFailsLoud(t *testing.T) {
	api := newNoteAPI(t, jsonResponse(`{}`))
	_, err := api.run(t, "write", "notes/x.md", "--file", "  ")
	if err == nil || exitCode(err) != 2 {
		t.Fatalf("empty --file must be a usage error, got: %v", err)
	}
	if len(api.requests) != 0 {
		t.Fatalf("nothing must be written, got %d requests", len(api.requests))
	}
}

func TestNoteAppendSendsOnlyTheBlockToTheEnd(t *testing.T) {
	api := newNoteAPI(t, jsonResponse(`{"status":"appended","path":"log.md","position":"end","bytes":9}`))
	local := filepath.Join(t.TempDir(), "entry.md")
	if err := os.WriteFile(local, []byte("## entry\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	out, err := api.run(t, "append", "log.md", "--file", local)
	if err != nil {
		t.Fatalf("note append: %v", err)
	}
	req := api.requests[0]
	if req.method != http.MethodPost || req.path != "/api/vault/append" {
		t.Fatalf("wrong call: %+v", req)
	}
	// Only the new block travels - shipping the whole note back is the cost the
	// verb exists to remove.
	if req.body != "## entry\n" {
		t.Fatalf("body must be the block verbatim, got %q", req.body)
	}
	if !strings.Contains(req.query, "position=end") || !strings.Contains(req.query, "path=log.md") {
		t.Fatalf("path and position must travel as query params, got %q", req.query)
	}
	if !strings.Contains(out, "Appended 9 bytes to the end of log.md") {
		t.Fatalf("unexpected output: %q", out)
	}
}

func TestNoteAppendPrependAsksForTheStart(t *testing.T) {
	api := newNoteAPI(t, jsonResponse(`{"status":"appended","position":"start"}`))
	local := filepath.Join(t.TempDir(), "entry.md")
	if err := os.WriteFile(local, []byte("## entry\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	out, err := api.run(t, "append", "log.md", "--prepend", "--file", local)
	if err != nil {
		t.Fatalf("note append --prepend: %v", err)
	}
	if !strings.Contains(api.requests[0].query, "position=start") {
		t.Fatalf("--prepend must ask for the start, got %q", api.requests[0].query)
	}
	if !strings.Contains(out, "Prepended 9 bytes to log.md") {
		t.Fatalf("unexpected output: %q", out)
	}
}

func TestNoteAppendJSONPassesTheServerEnvelopeThrough(t *testing.T) {
	api := newNoteAPI(t, jsonResponse(`{"status":"appended","path":"log.md","position":"end","bytes":9}`))
	local := filepath.Join(t.TempDir(), "entry.md")
	if err := os.WriteFile(local, []byte("## entry\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	out, err := api.run(t, "append", "log.md", "--file", local, "--json")
	if err != nil {
		t.Fatalf("note append --json: %v", err)
	}
	var decoded map[string]any
	if err := json.Unmarshal([]byte(out), &decoded); err != nil {
		t.Fatalf("--json must emit JSON, got %q", out)
	}
	if decoded["status"] != "appended" || decoded["position"] != "end" {
		t.Fatalf("unexpected envelope: %v", decoded)
	}
}

// A 404 from the server is the "that note does not exist" case, and it must
// reach the caller as a failure instead of a cheerful confirmation.
func TestNoteAppendSurfacesAMissingNote(t *testing.T) {
	api := newNoteAPI(t, func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "no such note: log.md", http.StatusNotFound)
	})
	local := filepath.Join(t.TempDir(), "entry.md")
	if err := os.WriteFile(local, []byte("## entry\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	out, err := api.run(t, "append", "log.md", "--file", local)
	if err == nil {
		t.Fatal("appending to a missing note must fail")
	}
	if strings.Contains(out, "Appended") {
		t.Fatalf("nothing may be reported as written, got %q", out)
	}
}

func TestNoteDeleteRequiresYes(t *testing.T) {
	api := newNoteAPI(t, func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })
	out, err := api.run(t, "delete", "notes/x.md")
	requireRefusedWithoutYes(t, err, "note delete")
	if len(api.requests) != 0 {
		t.Fatalf("delete without --yes must not call the API, got %+v", api.requests)
	}
	if !strings.Contains(out, "Would delete notes/x.md") {
		t.Fatalf("preview must name the file, got %q", out)
	}
}

func TestNoteDeleteWithYesIssuesDelete(t *testing.T) {
	api := newNoteAPI(t, func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })
	out, err := api.run(t, "delete", "notes/x.md", "--yes")
	if err != nil {
		t.Fatalf("note delete --yes: %v", err)
	}
	if api.requests[0].method != http.MethodDelete || api.requests[0].path != "/api/vault/file" {
		t.Fatalf("wrong call: %+v", api.requests[0])
	}
	if !strings.Contains(out, "Deleted notes/x.md") {
		t.Fatalf("unexpected output: %q", out)
	}
}

func TestNoteTagsListsTagAndCount(t *testing.T) {
	api := newNoteAPI(t, jsonResponse(`{"work":{"files":["a.md","b.md"]},"idea":{"files":["c.md"]}}`))
	out, err := api.run(t, "tags")
	if err != nil {
		t.Fatalf("note tags: %v", err)
	}
	if api.requests[0].path != "/api/notes/tags" {
		t.Fatalf("wrong route: %+v", api.requests[0])
	}
	// Sorted, so repeated runs diff cleanly.
	if !strings.HasPrefix(out, "idea\t1\nwork\t2\n") {
		t.Fatalf("unexpected output: %q", out)
	}
}

func TestNoteAPI404ExitsTwo(t *testing.T) {
	api := newNoteAPI(t, func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "no such file", http.StatusNotFound)
	})
	_, err := api.run(t, "read", "missing.md")
	if err == nil {
		t.Fatal("a 404 must surface as an error")
	}
	if exitCode(err) != 2 {
		t.Fatalf("a 4xx is an invocation problem (exit 2), got %d: %v", exitCode(err), err)
	}
}

func TestNoteUnknownSubcommandHints(t *testing.T) {
	var out bytes.Buffer
	err := runNoteCmd(&out, "", "http://127.0.0.1:1", false, []string{"lst"})
	if err == nil || !strings.Contains(err.Error(), `did you mean "list"?`) {
		t.Fatalf("typo'd subcommand must hint, got: %v", err)
	}
	if exitCode(err) != 2 {
		t.Fatalf("want usage error, got %d", exitCode(err))
	}
}

func TestNoteAppendPositionAfterBreakTravelsOnTheWire(t *testing.T) {
	api := newNoteAPI(t, jsonResponse(`{"status":"appended","position":"after-break","bytes":9}`))
	local := filepath.Join(t.TempDir(), "entry.md")
	if err := os.WriteFile(local, []byte("## entry\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	out, err := api.run(t, "append", "log.md", "--position", "after-break", "--file", local)
	if err != nil {
		t.Fatalf("note append --position after-break: %v", err)
	}
	if !strings.Contains(api.requests[0].query, "position=after-break") {
		t.Fatalf("the placement must travel verbatim, got %q", api.requests[0].query)
	}
	if !strings.Contains(out, "Inserted 9 bytes under the first thematic break in log.md") {
		t.Fatalf("unexpected output: %q", out)
	}
}

// --prepend predates --position and is documented; removing it silently would
// break every caller that already spells it that way.
func TestNoteAppendPrependStillMeansPositionStart(t *testing.T) {
	api := newNoteAPI(t, jsonResponse(`{"status":"appended","position":"start"}`))
	local := filepath.Join(t.TempDir(), "entry.md")
	if err := os.WriteFile(local, []byte("## entry\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := api.run(t, "append", "log.md", "--prepend", "--file", local); err != nil {
		t.Fatalf("note append --prepend: %v", err)
	}
	if !strings.Contains(api.requests[0].query, "position=start") {
		t.Fatalf("--prepend must still ask for the start, got %q", api.requests[0].query)
	}
}

// A typo'd placement must die here, not one network hop away from the note.
func TestNoteAppendRejectsAnUnknownPositionWithoutCallingTheAPI(t *testing.T) {
	api := newNoteAPI(t, jsonResponse(`{}`))
	local := filepath.Join(t.TempDir(), "entry.md")
	if err := os.WriteFile(local, []byte("## entry\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	_, err := api.run(t, "append", "log.md", "--position", "top", "--file", local)
	if err == nil || exitCode(err) != 2 {
		t.Fatalf("an unknown placement must be a usage error, got: %v", err)
	}
	if !strings.Contains(err.Error(), "after-break") {
		t.Fatalf("the error must list the accepted placements, got: %v", err)
	}
	if len(api.requests) != 0 {
		t.Fatalf("nothing must reach the server, got %d requests", len(api.requests))
	}
}

func TestNoteAppendRefusesPrependAndPositionTogether(t *testing.T) {
	api := newNoteAPI(t, jsonResponse(`{}`))
	local := filepath.Join(t.TempDir(), "entry.md")
	if err := os.WriteFile(local, []byte("## entry\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	_, err := api.run(t, "append", "log.md", "--prepend", "--position", "after-break", "--file", local)
	if err == nil || exitCode(err) != 2 {
		t.Fatalf("two ways of naming the placement at once must be a usage error, got: %v", err)
	}
	if len(api.requests) != 0 {
		t.Fatalf("nothing must reach the server, got %d requests", len(api.requests))
	}
}

// A note with no rule comes back 409, and that has to read as a failure rather
// than as a block written somewhere else.
func TestNoteAppendSurfacesAMissingThematicBreak(t *testing.T) {
	api := newNoteAPI(t, func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "no thematic break in log.md", http.StatusConflict)
	})
	local := filepath.Join(t.TempDir(), "entry.md")
	if err := os.WriteFile(local, []byte("## entry\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	out, err := api.run(t, "append", "log.md", "--position", "after-break", "--file", local)
	if err == nil {
		t.Fatal("a 409 must surface as a failure")
	}
	if strings.Contains(out, "Inserted") {
		t.Fatalf("nothing may be reported as written, got %q", out)
	}
}
