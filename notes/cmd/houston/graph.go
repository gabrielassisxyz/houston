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

var graphSubcommands = []string{"nodes", "search", "related", "edges"}

var graphCommand = commandMeta{
	Name:    "graph",
	Summary: "Read the knowledge graph (nodes, edges, search, relatedness)",
	Usage:   "houston graph <nodes|search|related|edges> [args...]",
	Details: `Every subcommand is read-only. They talk to a running server over the
REST API, so 'houston serve' must be up (or point elsewhere with
--server <url> / HOUSTON_ADDR).

Run 'houston graph <subcommand> --help' for details on each.`,
	Subs: []commandMeta{
		{
			Name:    "nodes",
			Summary: "List every live node in the graph",
			Usage:   "houston graph nodes [--json]",
			Details: `The whole graph, tombstones excluded. The route takes no filters, so
narrow it with 'houston graph search' rather than expecting flags here.

{{flags}}`,
			Flags: []commandFlag{
				{Name: "--json", Description: `Emit [{"id","title","type"}] verbatim on stdout`},
			},
		},
		{
			Name:    "search",
			Summary: "Search node titles",
			Usage:   "houston graph search <query> [--type <node-type>] [--limit <n>] [--json]",
			Details: `Matches node titles only, not bodies or tags (this is the editor's
wikilink autocomplete). The last word is matched as a prefix, so a
partial word still matches.

This is not the content-search verb: to find notes by a phrase in
their body, use 'houston search <query>' instead.

{{flags}}

Example:
  houston graph search backup --type note --limit 5`,
			Flags: []commandFlag{
				{Name: "--type", Value: "<node-type>", Description: "Restrict to one node type, e.g. note, task, project"},
				{Name: "--limit", Value: "<n>", Description: "Maximum hits, 1-50 (server default: 10; it clamps at 50)"},
				{Name: "--json", Description: `Emit [{"id","title","type"}] verbatim on stdout`},
			},
		},
		{
			Name:    "related",
			Summary: "Show the nodes a node is related to",
			Usage:   "houston graph related <node-id> [--limit <n>] [--json]",
			Details: `Computed relevance, not stored edges - use 'houston graph edges' for the
connections as persisted.

{{flags}}`,
			Flags: []commandFlag{
				{Name: "--limit", Value: "<n>", Description: "Maximum results (server default: 10)"},
				{Name: "--json", Description: `Emit [{"id","title","type"}] verbatim on stdout`},
			},
		},
		{
			Name:    "edges",
			Summary: "List stored edges: the whole graph, or one node's",
			Usage:   "houston graph edges [<node-id>] [--resolve] [--label <label>] [--type <node-type>] [--json]",
			Details: `Without a node ID: every edge in the graph, {id,src,dst,label}.
With a node ID: only that node's edges, in the same shape.

--resolve swaps the raw endpoints for the neighbour at the far end:
{id,title,type,path,label,direction,via,depth}. Direction is "out" when
the node is the edge source and "in" when it is the destination; via is
the node the hop came from; depth is always 1. One hop only - it does not
walk further, because where to stop is the caller's call, not the
command's guess.

{{flags}}`,
			Flags: []commandFlag{
				{Name: "--resolve", Description: `Resolve each edge to its neighbour (direction, title, type, path)`},
				{Name: "--label", Value: "<label>", Description: "Only edges with this label (e.g. links_to, part_of)"},
				{Name: "--type", Value: "<node-type>", Description: "Only edges whose neighbour is this node type (e.g. note, task)"},
				{Name: "--json", Description: `Emit the API body verbatim on stdout`},
			},
		},
	},
}

// graphNodeView is the shape both /api/nodes and the two node-listing routes
// answer with; --json passes the server's body through, so this stays a
// display-only subset.
type graphNodeView struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	Type  string `json:"type"`
}

type graphEdgeView struct {
	ID    string `json:"id"`
	Src   string `json:"src"`
	Dst   string `json:"dst"`
	Label string `json:"label"`
}

// resolvedNodeEdgeView mirrors the server's resolve=true shape: every field
// except label describes the neighbour, direction says which way the hop
// points, and via/depth are the constants the route guarantees for now.
type resolvedNodeEdgeView struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	Type      string `json:"type"`
	Path      string `json:"path"`
	Label     string `json:"label"`
	Direction string `json:"direction"`
	Via       string `json:"via"`
	Depth     int    `json:"depth"`
}

// runGraphCmd runs the graph verb: the subcommand plus its flags, against the
// configured server.
func runGraphCmd(stdout io.Writer, configPath, serverFlag string, asJSON bool, args []string) error {
	sub, rest, err := requireSub("graph", args, graphSubcommands)
	if err != nil {
		return err
	}
	localJSON, rest := parseBoolFlag(rest, "--json")
	asJSON = asJSON || localJSON
	client := newAPIClient(configPath, serverFlag)
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()

	switch sub {
	case "nodes":
		return runGraphNodes(ctx, client, stdout, asJSON, rest)
	case "search":
		return runGraphSearch(ctx, client, stdout, asJSON, rest)
	case "related":
		return runGraphRelated(ctx, client, stdout, asJSON, rest)
	default:
		return runGraphEdges(ctx, client, stdout, asJSON, rest)
	}
}

func runGraphNodes(ctx context.Context, c *apiClient, out io.Writer, asJSON bool, args []string) error {
	if err := noGraphArgs("graph nodes", args); err != nil {
		return err
	}
	raw, err := c.get(ctx, "/api/nodes")
	if err != nil {
		return err
	}
	if asJSON {
		return emitJSON(out, raw)
	}
	return printGraphNodes(out, raw, "GET /api/nodes",
		"The graph is empty. Put something in it with: houston note write <path>")
}

func runGraphSearch(ctx context.Context, c *apiClient, out io.Writer, asJSON bool, args []string) error {
	nodeType, _, rest, err := takeFlag("graph search", args, "--type")
	if err != nil {
		return err
	}
	limit, rest, err := takeGraphLimit(rest, "graph search")
	if err != nil {
		return err
	}
	if err := rejectUnknownFlags("graph search", rest); err != nil {
		return err
	}
	if len(rest) == 0 {
		return usagef("houston: graph search requires a query - run: houston help graph search")
	}

	query := url.Values{"q": {strings.Join(rest, " ")}}
	if nodeType != "" {
		query.Set("type", nodeType)
	}
	if limit != "" {
		query.Set("limit", limit)
	}
	raw, err := c.get(ctx, "/api/nodes/search?"+query.Encode())
	if err != nil {
		return err
	}
	if asJSON {
		return emitJSON(out, raw)
	}
	return printGraphNodes(out, raw, "GET /api/nodes/search",
		"No matches. Search is over node titles only - try a different word.")
}

func runGraphRelated(ctx context.Context, c *apiClient, out io.Writer, asJSON bool, args []string) error {
	limit, rest, err := takeGraphLimit(args, "graph related")
	if err != nil {
		return err
	}
	if err := rejectUnknownFlags("graph related", rest); err != nil {
		return err
	}
	id, err := singleGraphNodeID("graph related", rest)
	if err != nil {
		return err
	}

	path := "/api/nodes/" + url.PathEscape(id) + "/related"
	if limit != "" {
		path += "?limit=" + url.QueryEscape(limit)
	}
	raw, err := c.get(ctx, path)
	if err != nil {
		return err
	}
	if asJSON {
		return emitJSON(out, raw)
	}
	return printGraphNodes(out, raw, "GET /api/nodes/{id}/related",
		"Nothing related yet. Relatedness needs tags, links or shared context to work from.")
}

func runGraphEdges(ctx context.Context, c *apiClient, out io.Writer, asJSON bool, args []string) error {
	label, _, rest, err := takeFlag("graph edges", args, "--label")
	if err != nil {
		return err
	}
	typ, _, rest, err := takeFlag("graph edges", rest, "--type")
	if err != nil {
		return err
	}
	resolve, rest := parseBoolFlag(rest, "--resolve")
	if err := rejectUnknownFlags("graph edges", rest); err != nil {
		return err
	}

	// No node id: the unscoped form, byte-compatible with today's output.
	if len(rest) == 0 {
		if resolve {
			return usagef("houston: graph edges --resolve requires a node ID: direction and via describe a hop relative to that node - run: houston help graph edges")
		}
		if label != "" || typ != "" {
			return usagef("houston: graph edges --label/--type filter one node's edges and require a node ID - run: houston help graph edges")
		}
		return runGraphEdgesUnscoped(ctx, c, out, asJSON)
	}

	id, err := singleGraphNodeID("graph edges", rest)
	if err != nil {
		return err
	}
	path := "/api/nodes/" + url.PathEscape(id) + "/edges"
	query := url.Values{}
	if label != "" {
		query.Set("label", label)
	}
	if typ != "" {
		query.Set("type", typ)
	}
	if resolve {
		query.Set("resolve", "true")
	}
	if len(query) > 0 {
		path += "?" + query.Encode()
	}
	raw, err := c.get(ctx, path)
	if err != nil {
		return err
	}
	if asJSON {
		return emitJSON(out, raw)
	}
	if resolve {
		return printResolvedNodeEdges(out, raw)
	}
	return printGraphEdges(out, raw, "GET /api/nodes/{id}/edges")
}

// runGraphEdgesUnscoped keeps the no-argument form exactly as it was: one GET
// to /api/edges, printed in the original shape.
func runGraphEdgesUnscoped(ctx context.Context, c *apiClient, out io.Writer, asJSON bool) error {
	raw, err := c.get(ctx, "/api/edges")
	if err != nil {
		return err
	}
	if asJSON {
		return emitJSON(out, raw)
	}
	return printGraphEdges(out, raw, "GET /api/edges")
}

func printGraphEdges(w io.Writer, raw json.RawMessage, route string) error {
	var edges []graphEdgeView
	if err := decodeInto(raw, route, &edges); err != nil {
		return err
	}
	if len(edges) == 0 {
		fmt.Fprintln(w, "No edges. Nothing in the graph is connected yet.")
		return nil
	}
	for _, e := range edges {
		fmt.Fprintf(w, "%-38s --%s--> %s\n", e.Src, e.Label, e.Dst)
	}
	fmt.Fprintf(w, "\n%d edge(s)\n", len(edges))
	return nil
}

func printResolvedNodeEdges(w io.Writer, raw json.RawMessage) error {
	var edges []resolvedNodeEdgeView
	if err := decodeInto(raw, "GET /api/nodes/{id}/edges?resolve=true", &edges); err != nil {
		return err
	}
	if len(edges) == 0 {
		fmt.Fprintln(w, "No edges. Nothing in the graph is connected yet.")
		return nil
	}
	for _, e := range edges {
		line := fmt.Sprintf("%-4s %-14s %-38s [%-12s] %s", e.Direction, e.Label, e.ID, e.Type, e.Title)
		if e.Path != "" {
			line += "  " + e.Path
		}
		fmt.Fprintln(w, line)
	}
	fmt.Fprintf(w, "\n%d edge(s)\n", len(edges))
	return nil
}

// takeGraphLimit validates --limit here rather than letting the handlers ignore
// an unparseable value: silently serving the default is exactly the kind of
// quiet wrong answer a scripted caller cannot detect.
func takeGraphLimit(args []string, verb string) (string, []string, error) {
	raw, present, rest, err := takeFlag(verb, args, "--limit")
	if err != nil {
		return "", nil, err
	}
	if !present {
		return "", rest, nil
	}
	n, err := strconv.Atoi(strings.TrimSpace(raw))
	if err != nil || n < 1 {
		return "", nil, usagef("houston: %s --limit must be a positive integer, got %q - run: houston help %s", verb, raw, verb)
	}
	return strconv.Itoa(n), rest, nil
}

func noGraphArgs(verb string, args []string) error {
	if err := rejectUnknownFlags(verb, args); err != nil {
		return err
	}
	if len(args) > 0 {
		return usagef("houston: %s takes no positional arguments, got %q - run: houston help %s", verb, args[0], verb)
	}
	return nil
}

func singleGraphNodeID(verb string, args []string) (string, error) {
	if len(args) == 0 {
		return "", usagef("houston: %s requires a node ID - run: houston help %s. Find one with: houston graph search <query>", verb, verb)
	}
	if len(args) > 1 {
		return "", usagef("houston: %s takes exactly one node ID, got %d (%s) - run: houston help %s",
			verb, len(args), strings.Join(args, ", "), verb)
	}
	return args[0], nil
}

func printGraphNodes(w io.Writer, raw json.RawMessage, route, emptyHint string) error {
	var nodes []graphNodeView
	if err := decodeInto(raw, route, &nodes); err != nil {
		return err
	}
	if len(nodes) == 0 {
		fmt.Fprintln(w, emptyHint)
		return nil
	}
	for _, n := range nodes {
		fmt.Fprintf(w, "%-38s [%-12s] %s\n", n.ID, n.Type, n.Title)
	}
	fmt.Fprintf(w, "\n%d node(s)\n", len(nodes))
	return nil
}
