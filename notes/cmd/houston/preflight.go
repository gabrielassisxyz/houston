package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"unicode/utf8"

	"gopkg.in/yaml.v3"

	"github.com/gabrielassisxyz/houston/notes/internal/config"
	"github.com/gabrielassisxyz/houston/notes/internal/vault/frontmatter"
	"github.com/gabrielassisxyz/houston/notes/internal/vault/vaultfile"
)

// Preflight finding kinds. Notices leave the exit code 0; errors make it 1.
// The four names shared with the reconciler's reports keep their spelling:
// duplicate_id, unknown_permission, invalid_utf8, empty_file.
const (
	preflightMissingID         = "missing_id"
	preflightNonUUIDID         = "non_uuid_id"
	preflightUnknownKind       = "unknown_kind"
	preflightEmptyID           = "empty_id"
	preflightDuplicateID       = "duplicate_id"
	preflightInvalidFrontmatter = "invalid_frontmatter"
	preflightInvalidTags       = "invalid_tags"
	preflightInvalidRefs       = "invalid_refs"
	preflightInvalidKind       = "invalid_kind"
	preflightUnknownPermission = "unknown_permission"
	preflightEmptyFile         = "empty_file"
	preflightInvalidUTF8       = "invalid_utf8"
)

// Finding is one preflight line. Path is vault-relative.
type Finding struct {
	Path     string `json:"path"`
	Kind     string `json:"kind"`
	Severity string `json:"severity"`
	Detail   string `json:"detail"`
}

// preflightReport is the --json document: exactly one, even on failure.
type preflightReport struct {
	Errors   int            `json:"errors"`
	Notices  int            `json:"notices"`
	Counts   map[string]int `json:"counts"`
	Findings []Finding      `json:"findings"`
}

// preflightErrorKinds marks which kinds fail the run.
var preflightErrorKinds = map[string]bool{
	preflightEmptyID:           true,
	preflightDuplicateID:       true,
	preflightInvalidFrontmatter: true,
	preflightInvalidTags:       true,
	preflightInvalidRefs:       true,
	preflightInvalidKind:       true,
	preflightUnknownPermission: true,
	preflightEmptyFile:         true,
	preflightInvalidUTF8:       true,
}

// runPreflightCmd runs the preflight verb: it walks the vault, prints one line
// per finding and a count per kind, writes nothing, and exits 1 (via an
// already-reported error, so main prints nothing more) when any error is
// present.
func runPreflightCmd(stdout io.Writer, configPath, serverFlag string, asJSON bool, args []string) error {
	if serverFlag != "" {
		return usagef("houston: --server is for the client verbs - preflight takes no server. Run: houston help preflight")
	}
	if err := rejectUnknownFlags("preflight", args); err != nil {
		return err
	}
	if len(args) != 0 {
		return usagef("houston: preflight takes no arguments - run: houston help preflight")
	}

	cfg, err := config.LoadNotes(configPath)
	if err != nil {
		return err
	}
	vaultRoot := strings.TrimSpace(cfg.Vault.Root)
	if vaultRoot == "" {
		return fmt.Errorf("houston preflight: vault.root is empty - Fix: set vault.root or HOUSTON_VAULT to the vault directory")
	}
	if st, err := os.Stat(vaultRoot); err != nil || !st.IsDir() {
		if err != nil {
			return fmt.Errorf("houston preflight: vault.root %q: %w", vaultRoot, err)
		}
		return fmt.Errorf("houston preflight: vault.root %q is not a directory", vaultRoot)
	}

	findings, err := collectFindings(vaultRoot)
	if err != nil {
		return err
	}

	errors, notices, counts := summarizeFindings(findings)

	if asJSON {
		report := preflightReport{
			Errors:   errors,
			Notices:  notices,
			Counts:   counts,
			Findings: findings,
		}
		if report.Counts == nil {
			report.Counts = map[string]int{}
		}
		if report.Findings == nil {
			report.Findings = []Finding{}
		}
		if err := json.NewEncoder(stdout).Encode(report); err != nil {
			return fmt.Errorf("houston preflight: encoding report: %w", err)
		}
	} else {
		for _, f := range findings {
			fmt.Fprintf(stdout, "%s: %s: %s\n", f.Path, f.Kind, f.Detail)
		}
		kinds := make([]string, 0, len(counts))
		for k := range counts {
			kinds = append(kinds, k)
		}
		sort.Strings(kinds)
		fmt.Fprintln(stdout, "counts:")
		for _, k := range kinds {
			fmt.Fprintf(stdout, "  %s: %d\n", k, counts[k])
		}
		fmt.Fprintf(stdout, "preflight: %d errors, %d notices\n", errors, notices)
	}

	if errors > 0 {
		return reportedElsewhere(fmt.Errorf("houston preflight: %d errors, %d notices", errors, notices))
	}
	return nil
}

// summarizeFindings counts errors, notices and per-kind totals.
func summarizeFindings(findings []Finding) (errors, notices int, counts map[string]int) {
	counts = map[string]int{}
	for _, f := range findings {
		counts[f.Kind]++
		if preflightErrorKinds[f.Kind] {
			errors++
		} else {
			notices++
		}
	}
	return errors, notices, counts
}

// collectFindings walks the vault with the reconciler's own parser and
// note-file helpers and returns every finding, ordered by path and kind. It
// writes nothing.
func collectFindings(vaultRoot string) ([]Finding, error) {
	var findings []Finding
	type idLoc struct {
		rel, id string
	}
	var ids []idLoc

	walkErr := filepath.WalkDir(vaultRoot, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			// Permission errors etc. - skip, do not abort, as the cold start does.
			return nil
		}
		// Skip dot-files and dot-directories relative to the vault root, as
		// the cold start does.
		if strings.HasPrefix(d.Name(), ".") && path != vaultRoot {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if d.IsDir() {
			return nil
		}
		if filepath.Ext(path) != ".md" {
			return nil
		}

		rel, rerr := filepath.Rel(vaultRoot, path)
		if rerr != nil {
			rel = path
		}

		raw, rerr := os.ReadFile(path)
		if rerr != nil {
			return rerr
		}
		if len(raw) == 0 {
			findings = append(findings, Finding{
				Path:     rel,
				Kind:     preflightEmptyFile,
				Severity: "error",
				Detail:   "zero bytes; left untouched until it has content",
			})
			return nil
		}
		if !utf8.Valid(raw) {
			findings = append(findings, Finding{
				Path:     rel,
				Kind:     preflightInvalidUTF8,
				Severity: "error",
				Detail:   "not valid UTF-8; left untouched",
			})
			return nil
		}

		block := vaultfile.ScanFrontmatter(raw)
		if block.State == vaultfile.UnclosedBlock {
			findings = append(findings, Finding{
				Path:     rel,
				Kind:     preflightInvalidFrontmatter,
				Severity: "error",
				Detail:   "unterminated frontmatter block",
			})
			return nil
		}

		fm, perr := frontmatter.Parse(raw)
		if perr != nil {
			for _, kind := range classifyParseError(raw, block, perr) {
				findings = append(findings, Finding{
					Path:     rel,
					Kind:     kind,
					Severity: "error",
					Detail:   preflightInvalidDetail(kind, perr),
				})
			}
			return nil
		}

		if fm.ID == "" {
			if hasTopLevelIDLine(raw, block) {
				findings = append(findings, Finding{
					Path:     rel,
					Kind:     preflightEmptyID,
					Severity: "error",
					Detail:   "empty id: line; the first run fills it",
				})
			} else {
				findings = append(findings, Finding{
					Path:     rel,
					Kind:     preflightMissingID,
					Severity: "notice",
					Detail:   "no id; will get one on the first run",
				})
			}
		} else {
			ids = append(ids, idLoc{rel: rel, id: fm.ID})
			if !isPreflightUUID(fm.ID) {
				findings = append(findings, Finding{
					Path:     rel,
					Kind:     preflightNonUUIDID,
					Severity: "notice",
					Detail:   fmt.Sprintf("id %q is not a UUID; kept as is, never matched as a UUID by wikilinks", fm.ID),
				})
			}
		}

		if present, value := rawKindValue(raw, block); present {
			trimmed := strings.TrimSpace(value)
			if trimmed != "" && !isKnownKind(trimmed) {
				findings = append(findings, Finding{
					Path:     rel,
					Kind:     preflightUnknownKind,
					Severity: "notice",
					Detail:   fmt.Sprintf("kind %q is unknown; indexed as %q", value, "nota"),
				})
			}
		}

		if fm.Permission != "" && fm.Permission != "ask" && fm.Permission != "edit" {
			findings = append(findings, Finding{
				Path:     rel,
				Kind:     preflightUnknownPermission,
				Severity: "error",
				Detail:   fmt.Sprintf("permission %q is unknown; indexed as %q", fm.Permission, "ask"),
			})
		}
		return nil
	})
	if walkErr != nil {
		return nil, fmt.Errorf("houston preflight: walking the vault: %w", walkErr)
	}

	byID := map[string][]string{}
	for _, e := range ids {
		byID[e.id] = append(byID[e.id], e.rel)
	}
	for id, paths := range byID {
		if len(paths) < 2 {
			continue
		}
		sort.Strings(paths)
		for _, p := range paths {
			findings = append(findings, Finding{
				Path:     p,
				Kind:     preflightDuplicateID,
				Severity: "error",
				Detail:   fmt.Sprintf("id %q is shared by %d files", id, len(paths)),
			})
		}
	}

	sort.Slice(findings, func(i, j int) bool {
		if findings[i].Path != findings[j].Path {
			return findings[i].Path < findings[j].Path
		}
		return findings[i].Kind < findings[j].Kind
	})
	return findings, nil
}

// preflightInvalidDetail renders the detail for a parse-classified error.
func preflightInvalidDetail(kind string, perr error) string {
	switch kind {
	case preflightInvalidTags:
		return "tags must be a scalar or a list of scalars"
	case preflightInvalidRefs:
		return "refs must be a scalar or a list of scalars"
	case preflightInvalidKind:
		return "kind must be a scalar"
	default:
		return fmt.Sprintf("frontmatter cannot be parsed: %v", perr)
	}
}

// classifyParseError tells a malformed frontmatter from a well-formed one with
// a mistyped field, using the same YAML parser the frontmatter package uses.
// It returns the error kinds to report: invalid_tags, invalid_refs and/or
// invalid_kind when that field is present and not a scalar or a list of
// scalars (kind: any non-scalar), else invalid_frontmatter.
func classifyParseError(raw []byte, block vaultfile.Frontmatter, perr error) []string {
	if block.State != vaultfile.ClosedBlock {
		return []string{preflightInvalidFrontmatter}
	}
	blockBytes := raw[block.Start:block.Close]
	var doc yaml.Node
	if err := yaml.Unmarshal(blockBytes, &doc); err != nil {
		return []string{preflightInvalidFrontmatter}
	}
	if len(doc.Content) == 0 {
		return []string{preflightInvalidFrontmatter}
	}
	mapping := doc.Content[0]
	fields := map[string]*yaml.Node{}
	for i := 0; i+1 < len(mapping.Content); i += 2 {
		key := mapping.Content[i]
		value := mapping.Content[i+1]
		fields[key.Value] = value
	}

	var out []string
	if node, ok := fields["tags"]; ok && isBadStringList(node) {
		out = append(out, preflightInvalidTags)
	}
	if node, ok := fields["refs"]; ok && isBadStringList(node) {
		out = append(out, preflightInvalidRefs)
	}
	if node, ok := fields["kind"]; ok && node.Kind != yaml.ScalarNode {
		out = append(out, preflightInvalidKind)
	}
	if len(out) == 0 {
		return []string{preflightInvalidFrontmatter}
	}
	return out
}

// isBadStringList reports whether a tags/refs node is neither a scalar nor a
// list of scalars, matching the StringList rule: a scalar (including null) is
// fine, a sequence is fine only when every item is a scalar, anything else is
// bad.
func isBadStringList(node *yaml.Node) bool {
	switch node.Kind {
	case yaml.ScalarNode:
		return false
	case yaml.SequenceNode:
		for _, item := range node.Content {
			if item.Kind != yaml.ScalarNode {
				return true
			}
		}
		return false
	default:
		return true
	}
}

// rawKindValue returns the raw kind string when the frontmatter block carries a
// kind key. A null kind counts as absent. A non-scalar kind is reported by the
// parse-error path, so this returns present=false for it.
func rawKindValue(raw []byte, block vaultfile.Frontmatter) (present bool, value string) {
	if block.State != vaultfile.ClosedBlock {
		return false, ""
	}
	blockBytes := raw[block.Start:block.Close]
	var doc yaml.Node
	if err := yaml.Unmarshal(blockBytes, &doc); err != nil {
		return false, ""
	}
	if len(doc.Content) == 0 {
		return false, ""
	}
	mapping := doc.Content[0]
	for i := 0; i+1 < len(mapping.Content); i += 2 {
		if mapping.Content[i].Value != "kind" {
			continue
		}
		node := mapping.Content[i+1]
		if node.Kind != yaml.ScalarNode {
			return false, ""
		}
		if node.Tag == "!!null" {
			return false, ""
		}
		return true, node.Value
	}
	return false, ""
}

// isKnownKind reports whether a raw kind string names one of the four kinds,
// trimming and lower-casing as the indexer does.
func isKnownKind(s string) bool {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "plano", "implementacao", "evidencia", "nota":
		return true
	default:
		return false
	}
}

// uuidRe matches UUID format (8-4-4-4-12 hex), the same rule the wikilink
// resolver uses to tell a UUID from a stem or title.
var uuidRe = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

func isPreflightUUID(s string) bool {
	return uuidRe.MatchString(s)
}

// hasTopLevelIDLine tells an empty id: line from a missing id key with A7's own
// detection: a line at column 0 holding the key id, bare or quoted. Copied from
// the frontmatter injector (which stays private to its package) so the
// preflight reports exactly what the reconciler would do without editing that
// package.
func hasTopLevelIDLine(raw []byte, block vaultfile.Frontmatter) bool {
	if block.State != vaultfile.ClosedBlock {
		return false
	}
	_, _, found := findPreflightIDLine(raw, block.Start, block.Close)
	return found
}

// findPreflightIDLine locates, within raw[from:to], a line at column 0 holding
// the key id, bare or quoted, and returns that line's span without its line
// ending. An indented id belongs to a nested mapping and is not the note's.
func findPreflightIDLine(raw []byte, from, to int) (start, end int, found bool) {
	for pos := from; pos < to; {
		lineEnd := preflightLineEndAt(raw, pos, to)
		line := bytes.TrimRight(raw[pos:lineEnd], "\r")
		if isPreflightIDKeyLine(line) {
			return pos, pos + len(line), true
		}
		pos = lineEnd
		if pos < to {
			pos++
		}
	}
	return 0, 0, false
}

// isPreflightIDKeyLine reports whether line opens a mapping entry whose key is
// id: the key, optional blanks, a colon, then a blank or the end of the line.
func isPreflightIDKeyLine(line []byte) bool {
	var rest []byte
	switch {
	case bytes.HasPrefix(line, []byte("id")):
		rest = line[2:]
	case bytes.HasPrefix(line, []byte(`"id"`)), bytes.HasPrefix(line, []byte("'id'")):
		rest = line[4:]
	default:
		return false
	}
	rest = bytes.TrimLeft(rest, " \t")
	if len(rest) == 0 || rest[0] != ':' {
		return false
	}
	return len(rest) == 1 || rest[1] == ' ' || rest[1] == '\t'
}

// preflightLineEndAt returns the offset of the next '\n' at or after pos,
// capped at to.
func preflightLineEndAt(raw []byte, pos, to int) int {
	if i := bytes.IndexByte(raw[pos:to], '\n'); i >= 0 {
		return pos + i
	}
	return to
}
