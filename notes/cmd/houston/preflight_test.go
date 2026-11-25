package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// expectedFixtureCounts pins the testdata vault: one file per finding of the
// Specification, with the duplicate id carried by two files.
var expectedFixtureCounts = map[string]int{
	"missing_id":          1,
	"non_uuid_id":         1,
	"unknown_kind":        1,
	"empty_id":            1,
	"duplicate_id":        2,
	"invalid_frontmatter": 1,
	"invalid_tags":        1,
	"invalid_refs":        1,
	"invalid_kind":        1,
	"unknown_permission":  1,
	"empty_file":          1,
	"invalid_utf8":        1,
}

func fixtureVault(t *testing.T) string {
	t.Helper()
	abs, err := filepath.Abs("testdata")
	if err != nil {
		t.Fatalf("resolving testdata: %v", err)
	}
	return abs
}

func findingsByPathKind(findings []Finding) map[string]string {
	out := map[string]string{}
	for _, f := range findings {
		out[f.Path+"|"+f.Kind] = f.Severity
	}
	return out
}

// TestPreflightReportsEveryFinding drives the collector over the fixture vault
// and asserts the report, the count per kind and the exit rule.
func TestPreflightReportsEveryFinding(t *testing.T) {
	vault := fixtureVault(t)
	findings, err := collectFindings(vault)
	if err != nil {
		t.Fatalf("collectFindings: %v", err)
	}

	errorsCount, noticesCount, counts := summarizeFindings(findings)
	if errorsCount != 10 {
		t.Errorf("errors = %d, want 10", errorsCount)
	}
	if noticesCount != 3 {
		t.Errorf("notices = %d, want 3", noticesCount)
	}
	for kind, want := range expectedFixtureCounts {
		if got := counts[kind]; got != want {
			t.Errorf("counts[%q] = %d, want %d", kind, got, want)
		}
	}
	if len(counts) != len(expectedFixtureCounts) {
		t.Errorf("counts has %d kinds, want %d: %v", len(counts), len(expectedFixtureCounts), counts)
	}

	byPK := findingsByPathKind(findings)
	expected := map[string]string{
		"01-missing-id.md|missing_id":          "notice",
		"02-non-uuid.md|non_uuid_id":          "notice",
		"03-unknown-kind.md|unknown_kind":     "notice",
		"04-empty-id.md|empty_id":             "error",
		"05-duplicate-a.md|duplicate_id":      "error",
		"05-duplicate-b.md|duplicate_id":      "error",
		"06-bad-frontmatter.md|invalid_frontmatter": "error",
		"07-bad-tags.md|invalid_tags":         "error",
		"08-bad-refs.md|invalid_refs":         "error",
		"09-bad-kind.md|invalid_kind":         "error",
		"10-bad-permission.md|unknown_permission": "error",
		"11-invalid-utf8.md|invalid_utf8":     "error",
		"12-empty.md|empty_file":              "error",
	}
	for key, wantSeverity := range expected {
		got, ok := byPK[key]
		if !ok {
			t.Errorf("missing finding %q", key)
			continue
		}
		if got != wantSeverity {
			t.Errorf("finding %q severity = %q, want %q", key, got, wantSeverity)
		}
	}
	if len(findings) != len(expected) {
		t.Errorf("findings = %d, want %d", len(findings), len(expected))
	}
}

// runPreflightOnVault writes a minimal config pointing at vault and runs the
// verb, returning stdout and the returned error.
func runPreflightOnVault(t *testing.T, vault string, asJSON bool, extraArgs []string) (bytes.Buffer, error) {
	t.Helper()
	cfgPath := filepath.Join(t.TempDir(), "notes.yaml")
	cfg := "vault:\n  root: " + vault + "\n"
	if err := os.WriteFile(cfgPath, []byte(cfg), 0o644); err != nil {
		t.Fatalf("writing config: %v", err)
	}
	var out bytes.Buffer
	err := runPreflightCmd(&out, cfgPath, "", asJSON, extraArgs)
	return out, err
}

// TestPreflightHumanReportAndExitCode asserts the human output carries one line
// per finding plus counts, and the failure is already-reported (exit 1, main
// prints nothing more).
func TestPreflightHumanReportAndExitCode(t *testing.T) {
	vault := fixtureVault(t)
	out, err := runPreflightOnVault(t, vault, false, nil)
	if err == nil {
		t.Fatalf("expected an error, got nil")
	}
	var reported alreadyReported
	if !errors.As(err, &reported) {
		t.Fatalf("expected alreadyReported, got %T: %v", err, err)
	}
	if code := exitCode(err); code != 1 {
		t.Fatalf("exitCode = %d, want 1", code)
	}
	text := out.String()
	for kind := range expectedFixtureCounts {
		if !strings.Contains(text, kind) {
			t.Errorf("human output misses kind %q:\n%s", kind, text)
		}
	}
	if !strings.Contains(text, "counts:") {
		t.Errorf("human output misses counts:\n%s", text)
	}
	if !strings.Contains(text, "preflight: 10 errors, 3 notices") {
		t.Errorf("human output misses summary:\n%s", text)
	}
	// One line per finding: every fixture file name appears.
	for _, name := range []string{"01-missing-id.md", "05-duplicate-a.md", "12-empty.md"} {
		if !strings.Contains(text, name) {
			t.Errorf("human output misses file %q", name)
		}
	}
}

// TestPreflightMissingIDOnlyExitsZero proves a vault where every note only
// lacks an id exits 0.
func TestPreflightMissingIDOnlyExitsZero(t *testing.T) {
	vault := t.TempDir()
	for _, name := range []string{"a.md", "b.md"} {
		raw := "---\ntitle: " + name + "\n---\n\nBody.\n"
		if err := os.WriteFile(filepath.Join(vault, name), []byte(raw), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	// Dot-files, dot-directories and non-markdown files are skipped like the
	// cold start skips them: even with bad bytes they produce no findings.
	if err := os.WriteFile(filepath.Join(vault, ".hidden.md"), []byte("\xff\xfe"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(vault, ".obsidian"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(vault, ".obsidian", "bad.md"), []byte("\xff"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(vault, "notes.txt"), []byte("\xff\xfe"), 0o644); err != nil {
		t.Fatal(err)
	}

	findings, err := collectFindings(vault)
	if err != nil {
		t.Fatalf("collectFindings: %v", err)
	}
	errorsCount, noticesCount, counts := summarizeFindings(findings)
	if errorsCount != 0 {
		t.Fatalf("errors = %d, want 0: %+v", errorsCount, findings)
	}
	if noticesCount != 2 {
		t.Fatalf("notices = %d, want 2: %+v", noticesCount, findings)
	}
	if counts["missing_id"] != 2 || len(counts) != 1 {
		t.Fatalf("counts = %v, want map[missing_id:2]", counts)
	}

	out, err := runPreflightOnVault(t, vault, false, nil)
	if err != nil {
		t.Fatalf("missing-id-only vault must exit 0, got: %v", err)
	}
	if !strings.Contains(out.String(), "missing_id") {
		t.Errorf("human output misses missing_id:\n%s", out.String())
	}

	jsonOut, err := runPreflightOnVault(t, vault, true, nil)
	if err != nil {
		t.Fatalf("missing-id-only --json must exit 0, got: %v", err)
	}
	var doc preflightReport
	if err := json.Unmarshal(jsonOut.Bytes(), &doc); err != nil {
		t.Fatalf("--json is not JSON: %v\n%s", err, jsonOut.String())
	}
	if doc.Errors != 0 || doc.Notices != 2 {
		t.Errorf("document = %+v, want errors 0 notices 2", doc)
	}
}

// TestPreflightJSONIsSingleDocument proves --json with an error prints exactly
// one JSON document and nothing after it, with the failure already-reported.
func TestPreflightJSONIsSingleDocument(t *testing.T) {
	vault := fixtureVault(t)
	out, err := runPreflightOnVault(t, vault, true, nil)
	if err == nil {
		t.Fatalf("expected an error, got nil")
	}
	var reported alreadyReported
	if !errors.As(err, &reported) {
		t.Fatalf("expected alreadyReported, got %T: %v", err, err)
	}

	raw := out.Bytes()
	dec := json.NewDecoder(bytes.NewReader(raw))
	var doc preflightReport
	if err := dec.Decode(&doc); err != nil {
		t.Fatalf("first JSON document does not decode: %v\n%s", err, out.String())
	}
	if dec.More() {
		t.Fatalf("more than one JSON value in stdout:\n%s", out.String())
	}
	// Trailing whitespace (the encoder's newline) is fine; trailing JSON is not.
	rest := bytes.TrimSpace(raw[dec.InputOffset():])
	if len(rest) != 0 {
		t.Fatalf("bytes after the JSON document: %q", rest)
	}
	if doc.Errors != 10 || doc.Notices != 3 {
		t.Errorf("document errors/notices = %d/%d, want 10/3", doc.Errors, doc.Notices)
	}
	for kind, want := range expectedFixtureCounts {
		if got := doc.Counts[kind]; got != want {
			t.Errorf("counts[%q] = %d, want %d", kind, got, want)
		}
	}
	if len(doc.Findings) != 13 {
		t.Errorf("findings = %d, want 13", len(doc.Findings))
	}
}

// TestPreflightWritesNothing compares the bytes and modification time of every
// fixture file before and after the run.
func TestPreflightWritesNothing(t *testing.T) {
	vault := fixtureVault(t)
	type snapshot struct {
		bytes []byte
		mtime int64
		mode os.FileMode
	}
	before := map[string]snapshot{}
	entries, err := os.ReadDir(vault)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		p := filepath.Join(vault, e.Name())
		raw, err := os.ReadFile(p)
		if err != nil {
			t.Fatal(err)
		}
		info, err := os.Stat(p)
		if err != nil {
			t.Fatal(err)
		}
		before[e.Name()] = snapshot{bytes: raw, mtime: info.ModTime().UnixNano(), mode: info.Mode()}
	}

	if _, err := collectFindings(vault); err != nil {
		t.Fatalf("collectFindings: %v", err)
	}
	if _, err := runPreflightOnVault(t, vault, false, nil); err == nil {
		t.Fatalf("expected an error")
	}
	if _, err := runPreflightOnVault(t, vault, true, nil); err == nil {
		t.Fatalf("expected an error")
	}

	for name, snap := range before {
		p := filepath.Join(vault, name)
		raw, err := os.ReadFile(p)
		if err != nil {
			t.Fatal(err)
		}
		if string(raw) != string(snap.bytes) {
			t.Errorf("file %q changed bytes", name)
		}
		info, err := os.Stat(p)
		if err != nil {
			t.Fatal(err)
		}
		if got := info.ModTime().UnixNano(); got != snap.mtime {
			t.Errorf("file %q mtime changed: %d vs %d", name, got, snap.mtime)
		}
	}
}

// TestPreflightRejectsServerArgsAndFlags pins the verb's argument contract.
func TestPreflightRejectsServerArgsAndFlags(t *testing.T) {
	vault := fixtureVault(t)
	cfgPath := filepath.Join(t.TempDir(), "notes.yaml")
	if err := os.WriteFile(cfgPath, []byte("vault:\n  root: "+vault+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := runPreflightCmd(&out, cfgPath, "127.0.0.1:3301", false, nil); err == nil {
		t.Errorf("--server must be refused")
	} else if code := exitCode(err); code != 2 {
		t.Errorf("--server exit = %d, want 2: %v", code, err)
	}
	if err := runPreflightCmd(&out, cfgPath, "", false, []string{"extra"}); err == nil {
		t.Errorf("positional args must be refused")
	} else if code := exitCode(err); code != 2 {
		t.Errorf("args exit = %d, want 2: %v", code, err)
	}
	if err := runPreflightCmd(&out, cfgPath, "", false, []string{"--bogus"}); err == nil {
		t.Errorf("unknown flags must be refused")
	} else if code := exitCode(err); code != 2 {
		t.Errorf("flag exit = %d, want 2: %v", code, err)
	}
}

// TestExitCodeDictionary pins the ported exit-code contract.
func TestExitCodeDictionary(t *testing.T) {
	if got := exitCode(nil); got != 0 {
		t.Errorf("nil = %d, want 0", got)
	}
	if got := exitCode(errors.New("boom")); got != 1 {
		t.Errorf("plain error = %d, want 1", got)
	}
	if got := exitCode(usagef("bad invocation")); got != 2 {
		t.Errorf("usage error = %d, want 2", got)
	}
	if got := exitCode(reportedElsewhere(errors.New("already written"))); got != 1 {
		t.Errorf("alreadyReported runtime = %d, want 1", got)
	}
	if got := exitCode(reportedElsewhere(usagef("already written usage"))); got != 2 {
		t.Errorf("alreadyReported usage = %d, want 2", got)
	}
}
