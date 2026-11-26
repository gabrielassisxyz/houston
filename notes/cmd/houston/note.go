package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"os"
	"slices"
	"strings"
	"time"
)

var noteSubs = []string{"list", "read", "write", "append", "delete", "tags"}

var noteCommand = commandMeta{
	Name:    "note",
	Summary: "Read and write vault notes (the same files the editor edits)",
	Usage:   "houston note <list|read|write|append|delete|tags> [args...]",
	Details: `Every path is vault-relative (e.g. "projects/houston.md"); the server
resolves it against vault.root and rejects anything that escapes it.

Run 'houston note <subcommand> --help' for details on each.`,
	Subs: []commandMeta{
		{
			Name:    "list",
			Summary: "List notes with their graph node id, type and title",
			Usage:   "houston note list [--files] [--author ai|me] [--json]",
			Details: `{{flags}}`,
			Flags: []commandFlag{
				{Name: "--files", Description: "List the .md files on disk instead (files the graph has not",
					Continuation: []string{"indexed yet show up here and nowhere else)"}},
				{Name: "--author", Value: "ai|me", Description: "Only list notes by who wrote them: ai (the assistant) or me (you);",
					Continuation: []string{"the raw resolved values (agent:da, human, ...) are also accepted"}},
				{Name: "--json", Description: "Emit the API response verbatim on stdout"},
			},
		},
		{
			Name:    "read",
			Summary: "Print a note's contents",
			Usage:   "houston note read <path> [--json]",
			Details: `Writes the file bytes to stdout unchanged, so it pipes.

{{flags}}`,
			Flags: []commandFlag{
				{Name: "--json", Description: `Emit {"path","content"} instead - the route itself returns`,
					Continuation: []string{"text/plain, so there is no server JSON to pass through"}},
			},
		},
		{
			Name:    "write",
			Summary: "Create or overwrite a note from a file or stdin",
			Usage:   "houston note write <path> [--file <local-path>] [--tags <a,b,c>] [--json]",
			Details: `The body comes from --file, or from stdin when --file is omitted.
Writing a .md note the server does not know yet gets a node id injected
into its frontmatter.

Two frontmatter fields answer two different questions, and writing one in
place of the other is the mistake this paragraph exists to prevent. "origin"
says where the note came from, named after the pipeline that produced it:
prep, ingest, capture. "author" says who created the file, and its only value
is "da" - anything else, absent included, means a person wrote it. A note made
from a capture is the case that keeps them apart: the body is the person's own
words, carried across untouched, so it has an origin and no author at all.

"permission" is a third axis and an override, never a required field: it says
whether the assistant may modify the note. The values are "ask" and "edit".
Absent, the default falls out of author - a note with author "da" is the
assistant's to edit, any other note is the user's and the assistant asks
first. It is an honour system, not enforcement: the assistant obeys it by
instruction, and the revision log remains the record of what actually happened.

{{flags}}

Examples:
  houston note write inbox/idea.md --file ./draft.md
  echo "# Title" | houston note write inbox/idea.md`,
			Flags: []commandFlag{
				{Name: "--file", Value: "<local-path>", Description: "Read the body from a local file instead of stdin"},
				{Name: "--tags", Value: "<a,b,c>", Description: `Replace the frontmatter's tags: block outright (no merge with what is`,
					Continuation: []string{`already there); '--tags ""' removes every tag. Omitting the flag`, `leaves any existing tags untouched`}},
				{Name: "--json", Description: `Emit the server's response (status) on stdout`},
			},
		},
		{
			Name:    "append",
			Summary: "Add a block at one end of an existing note, or under its first rule",
			Usage:   "houston note append <path> [--file <local-path>] [--position <where>] [--json]",
			Details: `The block comes from --file, or from stdin when --file is omitted, and
lands at the bottom of the note separated by one blank line. Nothing
else in the note is rewritten, so a log that only grows in one place no
longer has to be read back and re-uploaded whole to gain one entry.

--position picks where:

  end          the bottom of the note (the default)
  start        the top of the body, under the frontmatter
  after-break  under the note's first thematic break - the first '---'
               line below the frontmatter. This is where a newest-first
               log keeps its entries when it opens with a preamble the
               reader has to see first. The frontmatter's own closing
               fence does not count, and neither does a '---' inside a
               fenced code block. A note with no such line is refused
               rather than written at some other position.

Appending to a note that does not exist fails; create it with
'houston note write' first.

{{flags}}

Examples:
  printf '## 2026-07-29\n\nwhat happened\n' | houston note append journal.md
  houston note append "system log.md" --file ./entry.md --position after-break`,
			Flags: []commandFlag{
				{Name: "--file", Value: "<local-path>", Description: "Read the block from a local file instead of stdin"},
				{Name: "--position", Value: "<where>", Description: "end (default), start or after-break; see above"},
				{Name: "--prepend", Description: "Older spelling of --position start; still works, but",
					Continuation: []string{"--position says which of the three you mean"}},
				{Name: "--json", Description: `Emit {"status","path","position","bytes"} on stdout`},
			},
		},
		{
			Name:    "delete",
			Summary: "Move a note to the trash (requires --yes)",
			Usage:   "houston note delete <path> --yes [--json]",
			Details: `Destructive: the file goes to the vault's trash and the vault watcher
reconciles its graph node away. Without --yes this prints what would be
deleted and exits 0.

{{flags}}`,
			Flags: []commandFlag{
				{Name: "--yes", Description: "Actually delete"},
				{Name: "--json", Description: `Emit {"path","status"} on stdout`},
			},
		},
		{
			Name:    "tags",
			Summary: "List every note tag with the files carrying it",
			Usage:   "houston note tags [--json]",
			Details: `{{flags}}`,
			Flags: []commandFlag{
				{Name: "--json", Description: `Emit {"<tag>":{"files":[...]}} on stdout`},
			},
		},
	},
}

// runNoteCmd runs the note verb: the subcommand plus its flags, against the
// configured server. asJSON from the global --json flag is OR-ed with a local
// --json so both `houston --json note list` and `houston note list --json` work,
// and direct test calls that bypass dispatch.
func runNoteCmd(stdout io.Writer, configPath, serverFlag string, asJSON bool, args []string) error {
	sub, rest, err := requireSub("note", args, noteSubs)
	if err != nil {
		return err
	}
	localJSON, rest := parseBoolFlag(rest, "--json")
	asJSON = asJSON || localJSON
	client := newAPIClient(configPath, serverFlag)
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()

	switch sub {
	case "list":
		return runNoteList(ctx, client, stdout, asJSON, rest)
	case "read":
		return runNoteRead(ctx, client, stdout, asJSON, rest)
	case "write":
		return runNoteWrite(ctx, client, stdout, asJSON, rest)
	case "append":
		return runNoteAppend(ctx, client, stdout, asJSON, rest)
	case "delete":
		return runNoteDelete(ctx, client, stdout, asJSON, rest)
	default:
		return runNoteTags(ctx, client, stdout, asJSON, rest)
	}
}

// notePathArg consumes the one vault-relative path every file verb needs. It
// runs after each verb has taken its own flags, so anything flag-shaped left
// here is a typo and must fail rather than be read as a path.
func notePathArg(sub string, args []string) (string, error) {
	if err := rejectUnknownFlags("note "+sub, args); err != nil {
		return "", err
	}
	if len(args) == 0 {
		return "", usagef("houston: note %s requires a vault-relative note path - example: houston note %s projects/houston.md", sub, sub)
	}
	if len(args) > 1 {
		return "", usagef("houston: note %s takes exactly one path, got %d (%s) - quote paths containing spaces", sub, len(args), strings.Join(args, ", "))
	}
	return args[0], nil
}

func noteFileRoute(path string) string {
	return "/api/vault/file?" + url.Values{"path": {path}}.Encode()
}

func rejectNoteArgs(sub string, args []string) error {
	if err := rejectUnknownFlags("note "+sub, args); err != nil {
		return err
	}
	if len(args) > 0 {
		return usagef("houston: note %s takes no arguments, got %q - run: houston help note %s", sub, args[0], sub)
	}
	return nil
}

func runNoteList(ctx context.Context, c *apiClient, out io.Writer, asJSON bool, args []string) error {
	onlyFiles, args := parseBoolFlag(args, "--files")
	author, hasAuthor, args, err := takeFlag("note list", args, "--author")
	if err != nil {
		return err
	}
	if err := rejectNoteArgs("list", args); err != nil {
		return err
	}
	if onlyFiles {
		if hasAuthor {
			return usagef("houston: note list --author filters the indexed notes, which --files does not list - drop one of the two")
		}
		return runNoteListFiles(ctx, c, out, asJSON)
	}
	raw, err := c.get(ctx, "/api/vault/notes")
	if err != nil {
		return err
	}
	// Without a filter, --json passes the server's own body through untouched,
	// exactly as before the flag existed.
	if asJSON && !hasAuthor {
		return emitJSON(out, raw)
	}
	// The route answers with a bare JSON array, not an envelope object.
	var notes []noteListItem
	if err := decodeInto(raw, "GET /api/vault/notes", &notes); err != nil {
		return err
	}
	if hasAuthor {
		notes = filterNotesByAuthor(notes, author)
	}
	if asJSON {
		encoded, err := json.Marshal(notes)
		if err != nil {
			return wrapLoud("encoding the note list", err)
		}
		return emitJSON(out, encoded)
	}
	if len(notes) == 0 {
		if hasAuthor {
			_, err := fmt.Fprintf(out, "No notes match --author %s.\n", author)
			return err
		}
		_, err := fmt.Fprintln(out, "No notes indexed. Try: houston note list --files")
		return err
	}
	for _, n := range notes {
		if _, err := fmt.Fprintf(out, "%s\t%s\t%s\n", n.Path, n.Type, n.Title); err != nil {
			return err
		}
	}
	return nil
}

// noteListItem is one row of GET /api/vault/notes: the fields the CLI's
// `note list` prints and filters on. Author is the resolved value the server
// already computes, so the CLI never re-derives the rule.
type noteListItem struct {
	Path   string `json:"path"`
	ID     string `json:"id"`
	Type   string `json:"type"`
	Title  string `json:"title"`
	Author string `json:"author"`
}

// filterNotesByAuthor keeps the notes whose resolved author matches the
// --author flag. "ai" and "me" are the human spellings: "ai" means the
// assistant wrote the note (the resolved author carries an "agent:" prefix),
// "me" means a person did. Any other value is matched exactly against the
// resolved author, so the raw spellings ("agent:da", "human") keep working for
// callers that know them.
func filterNotesByAuthor(notes []noteListItem, author string) []noteListItem {
	keep := notes[:0]
	for _, n := range notes {
		if noteAuthorMatches(n.Author, author) {
			keep = append(keep, n)
		}
	}
	return keep
}

// noteAuthorMatches is the one place the --author vocabulary maps to a
// resolved author, so the CLI's "ai"/"me" and the raw spellings cannot drift
// apart.
func noteAuthorMatches(resolved, filter string) bool {
	switch filter {
	case "ai":
		return strings.HasPrefix(resolved, "agent:")
	case "me":
		return !strings.HasPrefix(resolved, "agent:")
	default:
		return resolved == filter
	}
}

func runNoteListFiles(ctx context.Context, c *apiClient, out io.Writer, asJSON bool) error {
	raw, err := c.get(ctx, "/api/vault/list")
	if err != nil {
		return err
	}
	if asJSON {
		return emitJSON(out, raw)
	}
	var payload struct {
		Files []string `json:"files"`
	}
	if err := decodeInto(raw, "GET /api/vault/list", &payload); err != nil {
		return err
	}
	for _, f := range payload.Files {
		if _, err := fmt.Fprintln(out, f); err != nil {
			return err
		}
	}
	return nil
}

func runNoteRead(ctx context.Context, c *apiClient, out io.Writer, asJSON bool, args []string) error {
	path, err := notePathArg("read", args)
	if err != nil {
		return err
	}
	raw, err := c.get(ctx, noteFileRoute(path))
	if err != nil {
		return err
	}
	if asJSON {
		// This route returns text/plain, so there is no server JSON to pass
		// through - the CLI builds the envelope rather than emitting a
		// bare blob that no --json consumer could parse.
		return json.NewEncoder(out).Encode(map[string]string{"path": path, "content": string(raw)})
	}
	// Byte-exact, no added newline: `houston note read x.md > x.md` must round-trip.
	_, err = out.Write(raw)
	return err
}

func runNoteWrite(ctx context.Context, c *apiClient, out io.Writer, asJSON bool, args []string) error {
	source, hasSource, args, err := takeFlag("note write", args, "--file")
	if err != nil {
		return err
	}
	tags, hasTags, args, err := takeFlag("note write", args, "--tags")
	if err != nil {
		return err
	}
	path, err := notePathArg("write", args)
	if err != nil {
		return err
	}
	body, err := readNoteBody("write", "--file", source, hasSource)
	if err != nil {
		return err
	}
	route := noteFileRoute(path)
	if hasTags {
		// Always append, even when tags == "" - that empty value is the
		// clearing signal ('--tags ""' removes every tag), and it must stay
		// distinguishable on the wire from the flag being omitted entirely,
		// which leaves the note's existing tags untouched.
		route += "&tags=" + url.QueryEscape(tags)
	}
	raw, err := c.postRawWithClient(ctx, route, "text/markdown", body, "cli")
	if err != nil {
		if asJSON {
			return noteWriteJSONFailure(out, raw, err)
		}
		return err
	}
	if asJSON {
		return noteWriteJSON(out, raw)
	}
	_, err = fmt.Fprintf(out, "Wrote %s (%d bytes).\n", path, len(body))
	return err
}

// noteWriteResponseHasStatus reports whether a response is a JSON document
// carrying a non-empty status - the one fact every note write answer must
// carry. Anything else (empty body, plain text, status absent) is not a write
// outcome and must never be passed through as one.
func noteWriteResponseHasStatus(raw json.RawMessage) bool {
	var doc struct {
		Status string `json:"status"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return false
	}
	return doc.Status != ""
}

// noteWriteJSON passes a successful write's response through untouched, but
// only when it actually carries a status. A 200 whose body does not say what
// happened would be a silent outcome: the caller could not tell "the write
// failed" from "the response was malformed". Such a response becomes a
// synthesized document saying the outcome is unknown and that a retry is safe
// (note write replaces the whole file, so a second write cannot duplicate or
// corrupt) and exits non-zero instead of pretending success.
func noteWriteJSON(out io.Writer, raw json.RawMessage) error {
	if noteWriteResponseHasStatus(raw) {
		return emitJSON(out, raw)
	}
	detail := string(raw)
	if len(detail) > 200 {
		detail = detail[:200] + "…"
	}
	msg := fmt.Sprintf("the server answered 200 with a response that carries no status (%q); the note may or may not have been written, and retrying is safe because note write replaces the whole file", detail)
	return noteWriteJSONFailure(out, nil, fmt.Errorf("houston: note write answered 200 with a response carrying no status: %s", msg))
}

// noteWriteJSONFailure renders the failure half of the --json contract: a
// document a caller can act on, while the process still exits non-zero (the
// returned error keeps the exit-code mapping: 4xx is 2, 5xx and transport
// failures are 1). The server's own status document passes through verbatim
// when present; anything else is synthesized from the error so stdout is
// never an empty or statusless document. The error is marked already-reported
// so main does not overwrite stdout with its ok:false envelope, which carries
// no status field.
func noteWriteJSONFailure(out io.Writer, raw json.RawMessage, err error) error {
	if noteWriteResponseHasStatus(raw) {
		if emitErr := emitJSON(out, raw); emitErr != nil {
			return emitErr
		}
	} else if synthErr := noteWriteJSONSynth(out, "error", err.Error()); synthErr != nil {
		return synthErr
	}
	return reportedElsewhere(err)
}

// noteWriteJSONSynth builds a status document on the client when the server
// could not produce one - a response the caller can act on, in the same shape
// the server's own documents use.
func noteWriteJSONSynth(out io.Writer, status, message string) error {
	doc, err := json.Marshal(struct {
		Status string `json:"status"`
		Error  string `json:"error"`
	}{Status: status, Error: message})
	if err != nil {
		return err
	}
	return emitJSON(out, doc)
}

// notePositions are the placements 'note append' accepts, each with the line it
// reports on success. The order is the one --help and the error message use.
//
// The confirmation names the placement rather than saying "done": three
// placements share one verb, and a caller reading "appended" when it asked for
// after-break has no way to tell the block did not go where it meant.
type notePlacement struct {
	name   string
	report string // format: bytes, then path
}

var notePositions = []notePlacement{
	{"end", "Appended %d bytes to the end of %s.\n"},
	{"start", "Prepended %d bytes to %s.\n"},
	{"after-break", "Inserted %d bytes under the first thematic break in %s.\n"},
}

func runNoteAppend(ctx context.Context, c *apiClient, out io.Writer, asJSON bool, args []string) error {
	prepend, args := parseBoolFlag(args, "--prepend")
	choice, hasChoice, args, err := takeFlag("note append", args, "--position")
	if err != nil {
		return err
	}
	source, hasSource, args, err := takeFlag("note append", args, "--file")
	if err != nil {
		return err
	}
	path, err := notePathArg("append", args)
	if err != nil {
		return err
	}
	position, err := notePosition(prepend, choice, hasChoice)
	if err != nil {
		return err
	}
	body, err := readNoteBody("append", "--file", source, hasSource)
	if err != nil {
		return err
	}
	route := "/api/vault/append?" + url.Values{"path": {path}, "position": {position.name}}.Encode()
	raw, err := c.postRaw(ctx, route, "text/markdown", body)
	if err != nil {
		return err
	}
	if asJSON {
		return emitJSON(out, raw)
	}
	_, err = fmt.Fprintf(out, position.report, len(body), path)
	return err
}

// notePosition resolves the placement from --position and the older --prepend.
//
// A bad value is caught here rather than round-tripped: the note is on the
// other side of that request, and a typo'd placement must not be one network
// hop away from being written somewhere the caller did not mean.
func notePosition(prepend bool, choice string, hasChoice bool) (notePlacement, error) {
	var zero notePlacement
	if prepend && hasChoice {
		return zero, usagef("houston: note append takes --prepend or --position, not both - --prepend is the older spelling of --position start")
	}
	if prepend {
		return notePositions[1], nil
	}
	if !hasChoice {
		return notePositions[0], nil
	}
	for _, p := range notePositions {
		if p.name == choice {
			return p, nil
		}
	}
	names := make([]string, len(notePositions))
	for i, p := range notePositions {
		names[i] = p.name
	}
	return zero, usagef("houston: note append --position %q is not a placement - use one of: %s", choice, strings.Join(names, ", "))
}

// readNoteBody takes the payload from a local file, or from stdin when the
// flag was omitted - the same arg-or-stdin shape the capture-style verbs use.
func readNoteBody(sub, flag, source string, hasSource bool) ([]byte, error) {
	if hasSource {
		if strings.TrimSpace(source) == "" {
			return nil, usagef("houston: note %s %s requires a readable local file path - example: houston note %s <path> %s ./body.md", sub, flag, sub, flag)
		}
		body, err := os.ReadFile(source)
		if err != nil {
			return nil, wrapLoud(fmt.Sprintf("reading %s from %s", flag, source), err)
		}
		return body, nil
	}
	if stdinIsTerminal() {
		return nil, usagef("houston: note %s reads its body from stdin, but stdin is a terminal - pipe content in (echo ... | houston note %s <path>) or pass %s <local-path>", sub, sub, flag)
	}
	body, err := io.ReadAll(os.Stdin)
	if err != nil {
		return nil, wrapLoud("reading the note body from stdin", err)
	}
	if len(bytes.TrimSpace(body)) == 0 {
		return nil, usagef("houston: note %s got an empty body - pipe content on stdin or pass %s <local-path>", sub, flag)
	}
	return body, nil
}

func runNoteDelete(ctx context.Context, c *apiClient, out io.Writer, asJSON bool, args []string) error {
	confirmed, args := parseBoolFlag(args, "--yes")
	path, err := notePathArg("delete", args)
	if err != nil {
		return err
	}
	if !confirmed {
		if asJSON {
			if err := json.NewEncoder(out).Encode(map[string]string{"path": path, "status": "dry-run"}); err != nil {
				return err
			}
			return refusedWithoutYes("note delete")
		}
		if _, err := fmt.Fprintf(out, "Would delete %s. Re-run with --yes to delete it.\n", path); err != nil {
			return err
		}
		return refusedWithoutYes("note delete")
	}
	raw, err := c.delete(ctx, noteFileRoute(path))
	if err != nil {
		return err
	}
	if asJSON {
		// A 204 carries no body; emit the CLI's own confirmation instead.
		if len(bytes.TrimSpace(raw)) == 0 {
			return json.NewEncoder(out).Encode(map[string]string{"path": path, "status": "deleted"})
		}
		return emitJSON(out, raw)
	}
	_, err = fmt.Fprintf(out, "Deleted %s (moved to trash).\n", path)
	return err
}

func runNoteTags(ctx context.Context, c *apiClient, out io.Writer, asJSON bool, args []string) error {
	if err := rejectNoteArgs("tags", args); err != nil {
		return err
	}
	raw, err := c.get(ctx, "/api/notes/tags")
	if err != nil {
		return err
	}
	if asJSON {
		return emitJSON(out, raw)
	}
	var tree map[string]struct {
		Files []string `json:"files"`
	}
	if err := decodeInto(raw, "GET /api/notes/tags", &tree); err != nil {
		return err
	}
	for _, tag := range sortedKeys(tree) {
		if _, err := fmt.Fprintf(out, "%s\t%d\n", tag, len(tree[tag].Files)); err != nil {
			return err
		}
	}
	return nil
}

func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	slices.Sort(keys)
	return keys
}
