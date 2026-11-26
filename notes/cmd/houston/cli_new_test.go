package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// New per-verb tests: one for each verb the bead adds or changes, distinct
// from the ported cases. Each asserts behaviour the Specification pins.

func TestNewNoteListJSONWithAuthorFilter(t *testing.T) {
	api := newNoteAPI(t, jsonResponse(`[
		{"path":"a.md","id":"1","type":"note","title":"A","author":"agent:da"},
		{"path":"b.md","id":"2","type":"note","title":"B","author":"human"}
	]`))
	var out bytes.Buffer
	if err := runNoteCmd(&out, "", api.server.URL, true, []string{"list", "--author", "me"}); err != nil {
		t.Fatalf("note list --author me --json: %v", err)
	}
	var decoded []noteListItem
	if err := json.Unmarshal(out.Bytes(), &decoded); err != nil {
		t.Fatalf("--json must emit JSON, got %q", out.String())
	}
	if len(decoded) != 1 || decoded[0].Path != "b.md" {
		t.Fatalf("filter must apply before --json emit, got %v", decoded)
	}
}

func TestNewNoteReadMissingPathIsUsage(t *testing.T) {
	api := newNoteAPI(t, jsonResponse(`[]`))
	_, err := api.run(t, "read")
	if err == nil || exitCode(err) != 2 {
		t.Fatalf("note read with no path must be a usage error, got: %v", err)
	}
	if len(api.requests) != 0 {
		t.Fatalf("nothing must reach the server, got %d requests", len(api.requests))
	}
}

// The service suggests no links, so the flag the old CLI carried is gone:
// passing it must fail as an unknown flag, not as a silent ignore.
func TestNewNoteWriteRefusesNoLinksReason(t *testing.T) {
	api := newNoteAPI(t, jsonResponse(`{"status":"saved"}`))
	local := filepath.Join(t.TempDir(), "draft.md")
	if err := os.WriteFile(local, []byte("# Draft\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	_, err := api.run(t, "write", "notes/x.md", "--file", local, "--no-links-reason", "scratch")
	if err == nil || exitCode(err) != 2 {
		t.Fatalf("--no-links-reason must be refused, got: %v", err)
	}
	if !strings.Contains(err.Error(), "unknown flag") {
		t.Fatalf("refusal must name the unknown flag, got: %v", err)
	}
	if len(api.requests) != 0 {
		t.Fatalf("nothing must reach the server, got %d requests", len(api.requests))
	}
}

func TestNewNoteAppendDefaultsToEnd(t *testing.T) {
	api := newNoteAPI(t, jsonResponse(`{"status":"appended","position":"end"}`))
	local := filepath.Join(t.TempDir(), "entry.md")
	if err := os.WriteFile(local, []byte("## entry\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := api.run(t, "append", "log.md", "--file", local); err != nil {
		t.Fatalf("note append: %v", err)
	}
	if !strings.Contains(api.requests[0].query, "position=end") {
		t.Fatalf("default placement must be end, got %q", api.requests[0].query)
	}
}

func TestNewNoteDeleteJSONDryRun(t *testing.T) {
	api := newNoteAPI(t, func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })
	var out bytes.Buffer
	err := runNoteCmd(&out, "", api.server.URL, true, []string{"delete", "notes/x.md"})
	requireRefusedWithoutYes(t, err, "note delete")
	var doc map[string]string
	if err := json.Unmarshal(out.Bytes(), &doc); err != nil {
		t.Fatalf("dry-run --json must emit JSON, got %q", out.String())
	}
	if doc["status"] != "dry-run" || doc["path"] != "notes/x.md" {
		t.Fatalf("unexpected dry-run document: %v", doc)
	}
}

func TestNewNoteTagsEmptyPrintsNothing(t *testing.T) {
	api := newNoteAPI(t, jsonResponse(`{}`))
	out, err := api.run(t, "tags")
	if err != nil {
		t.Fatalf("note tags on empty tree: %v", err)
	}
	if strings.TrimSpace(out) != "" {
		t.Fatalf("empty tag tree must print nothing, got %q", out)
	}
}

func TestNewGraphNodesTextCountsNodes(t *testing.T) {
	fake := newFakeGraphAPI(t, http.StatusOK, `[{"id":"n1","title":"A","type":"note"}]`)
	out, err := fake.run("nodes")
	if err != nil {
		t.Fatalf("graph nodes: %v", err)
	}
	if !strings.Contains(out, "1 node(s)") {
		t.Fatalf("text output must count the nodes, got: %q", out)
	}
}

func TestNewGraphSearchForwardsLimitOne(t *testing.T) {
	fake := newFakeGraphAPI(t, http.StatusOK, `[]`)
	if _, err := fake.run("search", "--limit", "1", "back"); err != nil {
		t.Fatalf("graph search --limit 1: %v", err)
	}
	if call := fake.only(t); !strings.Contains(call.query, "limit=1") {
		t.Errorf("limit=1 must travel, got %q", call.query)
	}
}

func TestNewGraphRelatedMissingIDIsUsage(t *testing.T) {
	fake := newFakeGraphAPI(t, http.StatusOK, `[]`)
	_, err := fake.run("related")
	if err == nil || exitCode(err) != 2 {
		t.Fatalf("graph related with no id must be a usage error, got: %v", err)
	}
	if len(fake.calls) != 0 {
		t.Fatalf("nothing must reach the server, got %d calls", len(fake.calls))
	}
}

func TestNewGraphEdgesUnscopedJSONPassthrough(t *testing.T) {
	body := `[{"id":"e1","src":"n1","dst":"n2","label":"links_to"}]`
	fake := newFakeGraphAPI(t, http.StatusOK, body)
	var out bytes.Buffer
	if err := runGraphCmd(&out, "", fake.server.URL, true, []string{"edges"}); err != nil {
		t.Fatalf("graph edges --json: %v", err)
	}
	var decoded []map[string]any
	if err := json.Unmarshal(out.Bytes(), &decoded); err != nil {
		t.Fatalf("--json must emit the API body verbatim, got %q", out.String())
	}
	if len(decoded) != 1 || decoded[0]["label"] != "links_to" {
		t.Fatalf("unexpected body: %v", decoded)
	}
}

func TestNewSearchUppercaseKindTravelsLowercased(t *testing.T) {
	fake := newFakeSearchAPI(t, http.StatusOK, `{"hits":[],"total":0,"limit":20,"offset":0}`)
	if _, err := fake.run("q", "--kind", "Plano"); err != nil {
		t.Fatalf("search --kind Plano: %v", err)
	}
	if call := fake.only(t); !strings.Contains(call.query, "kind=plano") {
		t.Errorf("kind must travel lowercased, got %q", call.query)
	}
}

func TestNewHealthPrintsIndexingWhenServerOmitsIt(t *testing.T) {
	// An old or minimal server may answer without readiness fields; the CLI
	// still prints the line, as false.
	fake := newFakeHealthAPI(t, http.StatusOK, `{"status":"ok","vaultRoot":"/v","vaultLabel":"/v"}`)
	out, err := fake.run()
	if err != nil {
		t.Fatalf("health: %v", err)
	}
	if !strings.Contains(out, "indexing  false") {
		t.Errorf("health must print indexing even when the server omits it, got: %q", out)
	}
}

func TestNewErrorEnvelopeContract(t *testing.T) {
	err := dispatchForTest(t, []string{"note"})
	if err == nil {
		t.Fatal("expected an error")
	}
	if !wantsJSONOutput([]string{"note", "--json"}) {
		t.Fatal("wantsJSONOutput must see --json anywhere")
	}
	env := errorEnvelope(err)
	var doc struct {
		OK       bool   `json:"ok"`
		Error    string `json:"error"`
		ExitCode int    `json:"exitCode"`
	}
	if err := json.Unmarshal([]byte(env), &doc); err != nil {
		t.Fatalf("envelope must be JSON, got %q", env)
	}
	if doc.OK || doc.ExitCode != 2 || strings.TrimSpace(doc.Error) == "" {
		t.Fatalf("unexpected envelope: %q", env)
	}
	if strings.Contains(strings.ToLower(env), "kernl") {
		t.Fatalf("envelope must not name kernl, got: %q", env)
	}
}

func TestNewUsageListsAllVerbs(t *testing.T) {
	out := usage()
	for _, verb := range []string{"serve", "health", "preflight", "note", "graph", "search"} {
		if !strings.Contains(out, verb) {
			t.Errorf("usage must list %q, got:\n%s", verb, out)
		}
	}
	if strings.Contains(strings.ToLower(out), "kernl") {
		t.Errorf("usage must not name kernl, got:\n%s", out)
	}
}

func TestNewWrapLoudSingleMarker(t *testing.T) {
	inner := usagef("houston: inner")
	if got := wrapLoud("ctx", inner).Error(); strings.Count(got, "houston:") != 1 {
		t.Errorf("marker must appear once, got: %s", got)
	}
}

// No houston message names kernl: one table over the five failure surfaces the
// Specification lists (unknown flag, missing subcommand, unreachable server,
// empty graph, unconfigured vault).
func TestNewNoMessageNamesKernl(t *testing.T) {
	t.Run("unknown flag", func(t *testing.T) {
		api := newNoteAPI(t, jsonResponse(`[]`))
		_, err := api.run(t, "list", "--bogus")
		if err == nil {
			t.Fatal("expected an error")
		}
		assertNoKernl(t, err.Error())
	})

	t.Run("missing subcommand", func(t *testing.T) {
		var out bytes.Buffer
		err := runNoteCmd(&out, "", "http://127.0.0.1:1", false, nil)
		if err == nil {
			t.Fatal("expected an error")
		}
		assertNoKernl(t, err.Error())
	})

	t.Run("unreachable server", func(t *testing.T) {
		var out bytes.Buffer
		err := runNoteCmd(&out, "", "http://127.0.0.1:1", false, []string{"list"})
		if err == nil {
			t.Fatal("expected an error")
		}
		assertNoKernl(t, err.Error())
	})

	t.Run("empty graph", func(t *testing.T) {
		fake := newFakeGraphAPI(t, http.StatusOK, `null`)
		out, err := fake.run("nodes")
		if err != nil {
			t.Fatalf("empty graph must not error, got: %v", err)
		}
		assertNoKernl(t, out)
	})

	t.Run("unconfigured vault", func(t *testing.T) {
		fake := newFakeHealthAPI(t, http.StatusOK, `{"status":"ok","vaultRoot":"","vaultLabel":""}`)
		out, err := fake.run()
		if err != nil {
			t.Fatalf("health must not error, got: %v", err)
		}
		if strings.Contains(strings.ToLower(out), "kernl") {
			t.Errorf("message must not name kernl, got: %q", out)
		}
		if !strings.Contains(out, "notes.yaml") || !strings.Contains(out, "HOUSTON_VAULT") {
			t.Errorf("unconfigured vault must point at the houston fix, got: %q", out)
		}
	})
}

func assertNoKernl(t *testing.T, s string) {
	t.Helper()
	if strings.Contains(strings.ToLower(s), "kernl") {
		t.Errorf("message must not name kernl, got: %q", s)
	}
	if !strings.Contains(s, "houston") {
		t.Errorf("message must name houston, got: %q", s)
	}
}
