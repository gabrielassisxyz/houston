package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"strconv"
	"strings"
	"time"
)

var searchCommand = commandMeta{
	Name:    "search",
	Summary: "Search note bodies, titles and refs with snippets and filters",
	Usage:   "houston search <query...> [--tag <tag>] [--folder <folder>] [--kind <kind>] [--limit <n>] [--offset <n>] [--json]",
	Details: `Ranked full-text search over the vault: titles, bodies and wikilink
refs. The positional words are joined with spaces into one query, as
'houston graph search' does.

{{flags}}

Example:
  houston search rollout plan --tag alpha --kind plano --limit 5`,
	Flags: []commandFlag{
		{Name: "--tag", Value: "<tag>", Description: "Only hits carrying this tag"},
		{Name: "--folder", Value: "<folder>", Description: "Only hits under this vault folder"},
		{Name: "--kind", Value: "<kind>", Description: "Only hits of this kind: plano, implementacao, evidencia, nota"},
		{Name: "--limit", Value: "<n>", Description: "Maximum hits in the page (server default: 20; it caps at 100)"},
		{Name: "--offset", Value: "<n>", Description: "Skip this many hits before the page (default: 0)"},
		{Name: "--json", Description: `Emit {"hits","total","limit","offset"} verbatim on stdout`},
	},
}

// searchHit is one ranked result of GET /api/search. Tags is [] when empty,
// never null; Snippet carries STX/ETX around the matched terms.
type searchHit struct {
	ID      string   `json:"id"`
	Title   string   `json:"title"`
	Path    string   `json:"path"`
	Kind    string   `json:"kind"`
	Tags    []string `json:"tags"`
	Snippet string   `json:"snippet"`
}

// searchResponse is the pinned answer shape the CLI renders: the page of hits,
// the exact total before paging, and the limit and offset that produced it.
type searchResponse struct {
	Hits   []searchHit `json:"hits"`
	Total  int         `json:"total"`
	Limit  int         `json:"limit"`
	Offset int         `json:"offset"`
}

// runSearchCmd runs the search verb: the query words plus its filters, against
// the configured server.
func runSearchCmd(stdout io.Writer, configPath, serverFlag string, asJSON bool, args []string) error {
	tag, _, rest, err := takeFlag("search", args, "--tag")
	if err != nil {
		return err
	}
	folder, _, rest, err := takeFlag("search", rest, "--folder")
	if err != nil {
		return err
	}
	kind, _, rest, err := takeFlag("search", rest, "--kind")
	if err != nil {
		return err
	}
	limit, rest, err := takeSearchLimit(rest)
	if err != nil {
		return err
	}
	offset, rest, err := takeSearchOffset(rest)
	if err != nil {
		return err
	}
	localJSON, rest := parseBoolFlag(rest, "--json")
	asJSON = asJSON || localJSON
	if err := rejectUnknownFlags("search", rest); err != nil {
		return err
	}
	if len(rest) == 0 {
		return usagef("houston: search requires a query - run: houston help search")
	}
	if kind != "" {
		switch strings.ToLower(strings.TrimSpace(kind)) {
		case "plano", "implementacao", "evidencia", "nota":
		default:
			return usagef("houston: search --kind must be one of plano, implementacao, evidencia, nota, got %q - run: houston help search", kind)
		}
	}

	query := url.Values{"q": {strings.Join(rest, " ")}}
	if tag != "" {
		query.Set("tag", tag)
	}
	if folder != "" {
		query.Set("folder", folder)
	}
	if kind != "" {
		query.Set("kind", strings.ToLower(strings.TrimSpace(kind)))
	}
	if limit != "" {
		query.Set("limit", limit)
	}
	if offset != "" {
		query.Set("offset", offset)
	}

	client := newAPIClient(configPath, serverFlag)
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	raw, err := client.get(ctx, "/api/search?"+query.Encode())
	if err != nil {
		return err
	}
	if asJSON {
		return emitJSON(stdout, raw)
	}
	var resp searchResponse
	if err := decodeInto(raw, "GET /api/search", &resp); err != nil {
		return err
	}
	return printSearchHits(stdout, resp)
}

// takeSearchLimit validates --limit: a positive integer, forwarded verbatim.
// The server caps at 100 and reports the limit that produced the page.
func takeSearchLimit(args []string) (string, []string, error) {
	raw, present, rest, err := takeFlag("search", args, "--limit")
	if err != nil {
		return "", nil, err
	}
	if !present {
		return "", rest, nil
	}
	n, err := strconv.Atoi(strings.TrimSpace(raw))
	if err != nil || n < 1 {
		return "", nil, usagef("houston: search --limit must be a positive integer, got %q - run: houston help search", raw)
	}
	return strconv.Itoa(n), rest, nil
}

// takeSearchOffset validates --offset: a non-negative integer, forwarded
// verbatim.
func takeSearchOffset(args []string) (string, []string, error) {
	raw, present, rest, err := takeFlag("search", args, "--offset")
	if err != nil {
		return "", nil, err
	}
	if !present {
		return "", rest, nil
	}
	n, err := strconv.Atoi(strings.TrimSpace(raw))
	if err != nil || n < 0 {
		return "", nil, usagef("houston: search --offset must not be negative, got %q - run: houston help search", raw)
	}
	return strconv.Itoa(n), rest, nil
}

// stripSnippetMarkers removes the STX/ETX markers the route wraps around the
// matched terms, so text output reads as prose.
func stripSnippetMarkers(s string) string {
	s = strings.ReplaceAll(s, "\x02", "")
	s = strings.ReplaceAll(s, "\x03", "")
	return s
}

// printSearchHits renders one block per hit - title, path, kind, tags and the
// snippet with its markers stripped - and a last line with the total before
// paging, so a caller can tell "no more pages" from "no results".
func printSearchHits(out io.Writer, resp searchResponse) error {
	if len(resp.Hits) == 0 {
		if _, err := fmt.Fprintln(out, "No matches."); err != nil {
			return err
		}
		_, err := fmt.Fprintf(out, "%d total\n", resp.Total)
		return err
	}
	for _, h := range resp.Hits {
		tags := strings.Join(h.Tags, ", ")
		if strings.TrimSpace(tags) == "" {
			tags = "(none)"
		}
		if _, err := fmt.Fprintf(out, "%s [%s] %s\n", h.Title, h.Kind, h.Path); err != nil {
			return err
		}
		if _, err := fmt.Fprintf(out, "tags: %s\n", tags); err != nil {
			return err
		}
		if _, err := fmt.Fprintf(out, "%s\n\n", stripSnippetMarkers(h.Snippet)); err != nil {
			return err
		}
	}
	_, err := fmt.Fprintf(out, "%d total\n", resp.Total)
	return err
}

// searchResponseForTest decodes a search document in tests that assert the
// envelope survives the round trip.
func searchResponseForTest(raw json.RawMessage) (searchResponse, error) {
	var resp searchResponse
	err := json.Unmarshal(raw, &resp)
	return resp, err
}
