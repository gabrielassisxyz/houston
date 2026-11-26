package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

var linksCommand = commandMeta{
	Name:    "links",
	Summary: "Print what the hub's links route answers for an identifier",
	Usage:   "houston links <id> [--json]",
	Details: `The one verb that talks to the hub instead of the notes service: it
calls GET /api/links/<id> with the identifier path-escaped, at the address
in HOUSTON_HUB_URL (default http://127.0.0.1:3300). In text it prints the
tracker state of the identifier, every bead that carries it with its chain,
the top-level notes, and the projects the hub could not read. The top-level
notes print when the hub answers them and nothing prints for them when the
hub leaves them out, so an identifier no bead carries still returns its
notes.

{{flags}}

Example:
  houston links STRY00000001`,
	Flags: []commandFlag{
		{Name: "--json", Description: `Emit the hub's answer verbatim on stdout`},
	},
}

func linksUsage() string {
	return `houston links - print what the hub's links route answers for an identifier

Usage:
  houston links <id> [--json]

Calls GET /api/links/<id> with the identifier path-escaped, at the address
in HOUSTON_HUB_URL (default http://127.0.0.1:3300, a trailing / dropped).

  --json          Emit the hub's answer verbatim on stdout.
`
}

// linksTimeout bounds the hub call: the hub fans out over every project, so
// it gets the same budget as the other client verbs.
const linksTimeout = 90 * time.Second

// hubBaseURL resolves where the hub lives: HOUSTON_HUB_URL trimmed with one
// trailing slash dropped, defaulting to the hub's own port. The hub is not
// the notes service, so --server/HOUSTON_ADDR and the config file play no
// part here.
func hubBaseURL() (string, error) {
	raw := strings.TrimSpace(os.Getenv("HOUSTON_HUB_URL"))
	if raw == "" {
		return "http://127.0.0.1:3300", nil
	}
	if !strings.Contains(raw, "://") {
		raw = "http://" + raw
	}
	u, err := url.Parse(raw)
	if err != nil || strings.TrimSpace(u.Host) == "" {
		return "", fmt.Errorf("houston: HOUSTON_HUB_URL %q is not a valid URL - for example HOUSTON_HUB_URL=http://127.0.0.1:3300", os.Getenv("HOUSTON_HUB_URL"))
	}
	return strings.TrimSuffix(u.Scheme+"://"+u.Host+u.Path, "/"), nil
}

// runLinksCmd runs the links verb: one identifier against the hub.
func runLinksCmd(stdout io.Writer, configPath, serverFlag string, asJSON bool, args []string) error {
	_ = configPath
	if serverFlag != "" {
		return usagef("houston: --server is for the notes-service verbs - links talks to the hub at HOUSTON_HUB_URL. Run: houston help links")
	}
	localJSON, rest := parseBoolFlag(args, "--json")
	asJSON = asJSON || localJSON
	if err := rejectUnknownFlags("links", rest); err != nil {
		return err
	}
	if len(rest) == 0 {
		return usagef("houston: links requires an identifier - run: houston help links")
	}
	if len(rest) > 1 {
		return usagef("houston: links takes exactly one identifier, got %d (%s) - run: houston help links",
			len(rest), strings.Join(rest, ", "))
	}
	id := rest[0]
	if strings.TrimSpace(id) == "" {
		return usagef("houston: links requires a non-blank identifier - run: houston help links")
	}

	base, err := hubBaseURL()
	if err != nil {
		return err
	}
	path := "/api/links/" + url.PathEscape(id)

	ctx, cancel := context.WithTimeout(context.Background(), linksTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+path, nil)
	if err != nil {
		return fmt.Errorf("houston: building the links request for %s: %w", base, err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("houston: cannot reach the hub at %s - Fix: start it or set HOUSTON_HUB_URL to its address: %w", base, err)
	}
	defer func() { _ = resp.Body.Close() }()

	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("houston: reading the hub answer at %s: %w", base, err)
	}
	if resp.StatusCode >= 400 {
		return httpStatusError(http.MethodGet, path, resp.StatusCode, raw)
	}
	if asJSON {
		return emitJSON(stdout, raw)
	}
	var answer linksResponse
	if err := decodeInto(raw, "GET /api/links/[id]", &answer); err != nil {
		return err
	}
	return printLinksText(stdout, answer)
}

// linksResponse mirrors what GET /api/links/[id] answers: the identifier
// back, whether the snapshot read, the identifier as a tracker item, every
// bead carrying it with its chain, the projects that could not be read, and
// the top-level notes only when the hub answers them. docs/chain.md pins the
// contract; the field names here stay byte-equal to it.
type linksResponse struct {
	ID         string            `json:"id"`
	Snapshot   linksSnapshot     `json:"snapshot"`
	Ticket     *trackerItem      `json:"ticket"`
	Beads      []linksBeadEntry  `json:"beads"`
	Unreadable []linksUnreadable `json:"unreadable"`
	Notes      *chainNotes       `json:"notes"`
}

type linksSnapshot struct {
	Available bool   `json:"available"`
	Reason    string `json:"reason,omitempty"`
}

type linksBeadEntry struct {
	ProjectID   string     `json:"projectId"`
	ProjectName string     `json:"projectName"`
	Chain       linksChain `json:"chain"`
}

type linksUnreadable struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Error string `json:"error"`
}

type linksChain struct {
	Bead        chainBead         `json:"bead"`
	Tracker     *trackerItem      `json:"tracker"`
	Descendants []chainDescendant `json:"descendants,omitempty"`
	Epic        *chainEpic        `json:"epic"`
	Pipeline    *chainPipeline    `json:"pipeline"`
	Notes       *chainNotes       `json:"notes"`
	Snapshot    linksSnapshot     `json:"snapshot"`
}

type chainBead struct {
	ID          string `json:"id"`
	ProjectID   string `json:"projectId"`
	Type        string `json:"type"`
	Status      string `json:"status"`
	Title       string `json:"title"`
	ExternalRef string `json:"externalRef,omitempty"`
}

type chainDescendant struct {
	ID          string       `json:"id"`
	Type        string       `json:"type"`
	Status      string       `json:"status"`
	Title       string       `json:"title"`
	ExternalRef string       `json:"externalRef,omitempty"`
	Tracker     *trackerItem `json:"tracker"`
}

type chainEpic struct {
	ID          string       `json:"id"`
	Status      string       `json:"status"`
	Title       string       `json:"title"`
	ExternalRef string       `json:"externalRef,omitempty"`
	Tracker     *trackerItem `json:"tracker"`
}

type trackerItem struct {
	State           string          `json:"state"`
	Source          string          `json:"source,omitempty"`
	Number          string          `json:"number,omitempty"`
	Title           string          `json:"title,omitempty"`
	Status          string          `json:"status,omitempty"`
	Sprint          string          `json:"sprint,omitempty"`
	Link            *string         `json:"link,omitempty"`
	Reason          string          `json:"reason,omitempty"`
	Approvals       []chainApproval `json:"approvals"`
	Freshness       string          `json:"freshness,omitempty"`
	LastConfirmedAt string          `json:"lastConfirmedAt,omitempty"`
}

type chainApproval struct {
	Number          string  `json:"number"`
	Title           string  `json:"title"`
	RecordType      string  `json:"recordType"`
	State           string  `json:"state"`
	Link            *string `json:"link,omitempty"`
	Freshness       string  `json:"freshness,omitempty"`
	LastConfirmedAt string  `json:"lastConfirmedAt,omitempty"`
}

type chainRun struct {
	ID          int          `json:"id"`
	CreatedAt   string       `json:"createdAt"`
	Status      string       `json:"status"`
	Conclusion  *string      `json:"conclusion"`
	Head        *string      `json:"head"`
	Link        *string      `json:"link"`
	ExistingPrs []chainPrRef `json:"existingPrs,omitempty"`
}

type chainPrRef struct {
	Number int     `json:"number"`
	Link   *string `json:"link"`
}

type chainPullRequest struct {
	Number    int      `json:"number"`
	Base      string   `json:"base"`
	Head      string   `json:"head"`
	Anomalies []string `json:"anomalies,omitempty"`
	Link      *string  `json:"link"`
}

type chainIssue struct {
	Part  string `json:"part"`
	Repo  string `json:"repo,omitempty"`
	RunID *int   `json:"runId,omitempty"`
	Error string `json:"error,omitempty"`
	Limit *int   `json:"limit,omitempty"`
}

type chainChange struct {
	Number string  `json:"number"`
	Link   *string `json:"link"`
}

type chainPipeline struct {
	State           string             `json:"state"`
	Reason          string             `json:"reason,omitempty"`
	Freshness       string             `json:"freshness,omitempty"`
	LastConfirmedAt string             `json:"lastConfirmedAt,omitempty"`
	Runs            []chainRun         `json:"runs,omitempty"`
	PRs             []chainPullRequest `json:"prs,omitempty"`
	Issues          []chainIssue       `json:"issues,omitempty"`
	Changes         []chainChange      `json:"changes,omitempty"`
}

type chainDirectNote struct {
	ID          string   `json:"id"`
	Title       string   `json:"title"`
	Path        string   `json:"path"`
	Kind        string   `json:"kind"`
	Tags        []string `json:"tags,omitempty"`
	MatchedRefs []string `json:"matchedRefs,omitempty"`
}

type chainLinkedNote struct {
	ID    string   `json:"id"`
	Title string   `json:"title"`
	Path  string   `json:"path"`
	Kind  string   `json:"kind"`
	Tags  []string `json:"tags,omitempty"`
}

type chainNotes struct {
	State         string            `json:"state"`
	Reason        string            `json:"reason,omitempty"`
	Plano         []chainDirectNote `json:"plano,omitempty"`
	Implementacao []chainDirectNote `json:"implementacao,omitempty"`
	Evidencia     []chainDirectNote `json:"evidencia,omitempty"`
	Nota          []chainDirectNote `json:"nota,omitempty"`
	Linked        []chainLinkedNote `json:"linked,omitempty"`
	LinkedOmitted int               `json:"linkedOmitted,omitempty"`
}

func linkOrNone(s *string) string {
	if s == nil || strings.TrimSpace(*s) == "" {
		return "(none)"
	}
	return *s
}

// printLinksText renders the hub answer as sections: the identifier, the
// snapshot, the ticket, each bead with its chain, the top-level notes when
// present, and the unreadable projects. A nil notes or pipeline part prints
// nothing at all, matching the hub leaving the key out when unconfigured.
func printLinksText(out io.Writer, answer linksResponse) error {
	if _, err := fmt.Fprintf(out, "id: %s\n", answer.ID); err != nil {
		return err
	}
	if err := printLinksSnapshot(out, answer.Snapshot); err != nil {
		return err
	}
	if err := printLinksTicket(out, answer.Ticket); err != nil {
		return err
	}
	if _, err := fmt.Fprintf(out, "beads (%d):\n", len(answer.Beads)); err != nil {
		return err
	}
	for _, entry := range answer.Beads {
		if err := printLinksBead(out, entry); err != nil {
			return err
		}
	}
	if answer.Notes != nil {
		if _, err := fmt.Fprintln(out, "notes:"); err != nil {
			return err
		}
		if err := printChainNotes(out, "  ", answer.Notes); err != nil {
			return err
		}
	}
	if _, err := fmt.Fprintf(out, "unreadable (%d):\n", len(answer.Unreadable)); err != nil {
		return err
	}
	for _, u := range answer.Unreadable {
		if _, err := fmt.Fprintf(out, "- %s (%s): %s\n", u.ID, u.Name, u.Error); err != nil {
			return err
		}
	}
	return nil
}

func printLinksSnapshot(out io.Writer, s linksSnapshot) error {
	if s.Available {
		_, err := fmt.Fprintln(out, "snapshot: available")
		return err
	}
	if strings.TrimSpace(s.Reason) == "" {
		_, err := fmt.Fprintln(out, "snapshot: unavailable")
		return err
	}
	_, err := fmt.Fprintf(out, "snapshot: unavailable: %s\n", s.Reason)
	return err
}

func printLinksTicket(out io.Writer, t *trackerItem) error {
	if t == nil {
		_, err := fmt.Fprintln(out, "ticket: none")
		return err
	}
	_, err := fmt.Fprintf(out, "ticket: %s\n", trackerOneLine(t))
	if err != nil {
		return err
	}
	return printTrackerApprovals(out, "  ", t)
}

// trackerOneLine condenses a tracker item to one greppable line. Found keeps
// the number, title, status, source and freshness; absent and unconfirmed
// keep the reason; approvals travel on the lines after it.
func trackerOneLine(t *trackerItem) string {
	switch t.State {
	case "found":
		var sb strings.Builder
		sb.WriteString("found " + t.Number + " \"" + t.Title + "\" [" + t.Status + "]")
		if t.Source != "" {
			sb.WriteString(" source:" + t.Source)
		}
		if t.Freshness != "" {
			sb.WriteString(" freshness:" + t.Freshness)
		}
		if t.Sprint != "" {
			sb.WriteString(" sprint:" + t.Sprint)
		}
		sb.WriteString(" link:" + linkOrNone(t.Link))
		return sb.String()
	case "absent":
		return "absent"
	case "unconfirmed":
		if strings.TrimSpace(t.Reason) == "" {
			return "unconfirmed"
		}
		return "unconfirmed: " + t.Reason
	default:
		if t.State == "" {
			return "none"
		}
		return t.State
	}
}

func printTrackerApprovals(out io.Writer, prefix string, t *trackerItem) error {
	if len(t.Approvals) == 0 {
		return nil
	}
	if _, err := fmt.Fprintf(out, "%sapprovals (%d):\n", prefix, len(t.Approvals)); err != nil {
		return err
	}
	for _, a := range t.Approvals {
		line := fmt.Sprintf("%s- %s \"%s\" [%s] type:%s freshness:%s link:%s",
			prefix, a.Number, a.Title, a.State, a.RecordType, a.Freshness, linkOrNone(a.Link))
		if _, err := fmt.Fprintln(out, line); err != nil {
			return err
		}
	}
	return nil
}

func printLinksBead(out io.Writer, entry linksBeadEntry) error {
	b := entry.Chain.Bead
	ref := b.ExternalRef
	if strings.TrimSpace(ref) == "" {
		ref = "(none)"
	}
	if _, err := fmt.Fprintf(out, "- %s (%s): %s \"%s\" [%s/%s] ref:%s\n",
		entry.ProjectName, entry.ProjectID, b.ID, b.Title, b.Type, b.Status, ref); err != nil {
		return err
	}
	const pad = "  "
	if entry.Chain.Tracker == nil {
		if _, err := fmt.Fprintf(out, "%stracker: none\n", pad); err != nil {
			return err
		}
	} else {
		if _, err := fmt.Fprintf(out, "%stracker: %s\n", pad, trackerOneLine(entry.Chain.Tracker)); err != nil {
			return err
		}
		if err := printTrackerApprovals(out, pad+"  ", entry.Chain.Tracker); err != nil {
			return err
		}
	}
	if entry.Chain.Epic != nil {
		e := entry.Chain.Epic
		eref := e.ExternalRef
		if strings.TrimSpace(eref) == "" {
			eref = "(none)"
		}
		if _, err := fmt.Fprintf(out, "%sepic: %s \"%s\" [%s] ref:%s\n", pad, e.ID, e.Title, e.Status, eref); err != nil {
			return err
		}
		if e.Tracker != nil {
			if _, err := fmt.Fprintf(out, "%s  tracker: %s\n", pad, trackerOneLine(e.Tracker)); err != nil {
				return err
			}
		}
	}
	if entry.Chain.Descendants != nil {
		if _, err := fmt.Fprintf(out, "%sdescendants (%d):\n", pad, len(entry.Chain.Descendants)); err != nil {
			return err
		}
		for _, d := range entry.Chain.Descendants {
			dref := d.ExternalRef
			if strings.TrimSpace(dref) == "" {
				dref = "(none)"
			}
			if _, err := fmt.Fprintf(out, "%s  - %s \"%s\" [%s/%s] ref:%s\n", pad, d.ID, d.Title, d.Type, d.Status, dref); err != nil {
				return err
			}
			if d.Tracker != nil {
				if _, err := fmt.Fprintf(out, "%s    tracker: %s\n", pad, trackerOneLine(d.Tracker)); err != nil {
					return err
				}
			}
		}
	}
	if entry.Chain.Pipeline != nil {
		if err := printChainPipeline(out, pad, entry.Chain.Pipeline); err != nil {
			return err
		}
	}
	if entry.Chain.Notes != nil {
		if _, err := fmt.Fprintf(out, "%snotes:\n", pad); err != nil {
			return err
		}
		if err := printChainNotes(out, pad+"  ", entry.Chain.Notes); err != nil {
			return err
		}
	}
	if _, err := fmt.Fprintf(out, "%ssnapshot: %s\n", pad, snapshotOneLine(entry.Chain.Snapshot)); err != nil {
		return err
	}
	return nil
}

func snapshotOneLine(s linksSnapshot) string {
	if s.Available {
		return "available"
	}
	if strings.TrimSpace(s.Reason) == "" {
		return "unavailable"
	}
	return "unavailable: " + s.Reason
}

func printChainPipeline(out io.Writer, prefix string, p *chainPipeline) error {
	switch p.State {
	case "found":
		if _, err := fmt.Fprintf(out, "%spipeline: found freshness:%s runs:%d prs:%d issues:%d changes:%d\n",
			prefix, p.Freshness, len(p.Runs), len(p.PRs), len(p.Issues), len(p.Changes)); err != nil {
			return err
		}
		for _, r := range p.Runs {
			conclusion := "(none)"
			if r.Conclusion != nil && strings.TrimSpace(*r.Conclusion) != "" {
				conclusion = *r.Conclusion
			}
			if _, err := fmt.Fprintf(out, "%s  run %d [%s/%s] link:%s\n", prefix, r.ID, r.Status, conclusion, linkOrNone(r.Link)); err != nil {
				return err
			}
		}
		for _, pr := range p.PRs {
			if _, err := fmt.Fprintf(out, "%s  pr %d %s->%s link:%s\n", prefix, pr.Number, pr.Base, pr.Head, linkOrNone(pr.Link)); err != nil {
				return err
			}
		}
	case "absent":
		if _, err := fmt.Fprintf(out, "%spipeline: absent\n", prefix); err != nil {
			return err
		}
	case "unconfirmed":
		if strings.TrimSpace(p.Reason) == "" {
			_, err := fmt.Fprintf(out, "%spipeline: unconfirmed\n", prefix)
			return err
		}
		if _, err := fmt.Fprintf(out, "%spipeline: unconfirmed: %s\n", prefix, p.Reason); err != nil {
			return err
		}
	default:
		if _, err := fmt.Fprintf(out, "%spipeline: %s\n", prefix, p.State); err != nil {
			return err
		}
	}
	return nil
}

// printChainNotes renders one notes part: the state, then each direct group
// with its matched refs, then the linked notes and the omitted count. An
// unavailable part keeps only its reason; everything else is unchanged.
func printChainNotes(out io.Writer, prefix string, n *chainNotes) error {
	if n.State == "unavailable" {
		if strings.TrimSpace(n.Reason) == "" {
			_, err := fmt.Fprintf(out, "%sunavailable\n", prefix)
			return err
		}
		_, err := fmt.Fprintf(out, "%sunavailable: %s\n", prefix, n.Reason)
		return err
	}
	if n.State != "" && n.State != "available" {
		_, err := fmt.Fprintf(out, "%s%s\n", prefix, n.State)
		return err
	}
	groups := []struct {
		name  string
		notes []chainDirectNote
	}{
		{"plano", n.Plano},
		{"implementacao", n.Implementacao},
		{"evidencia", n.Evidencia},
		{"nota", n.Nota},
	}
	for _, g := range groups {
		if _, err := fmt.Fprintf(out, "%s%s (%d):\n", prefix, g.name, len(g.notes)); err != nil {
			return err
		}
		for _, note := range g.notes {
			refs := strings.Join(note.MatchedRefs, ",")
			if strings.TrimSpace(refs) == "" {
				refs = "(none)"
			}
			if _, err := fmt.Fprintf(out, "%s  - %s \"%s\" (%s) refs:%s\n", prefix, note.ID, note.Title, note.Path, refs); err != nil {
				return err
			}
		}
	}
	if _, err := fmt.Fprintf(out, "%slinked (%d, omitted %d):\n", prefix, len(n.Linked), n.LinkedOmitted); err != nil {
		return err
	}
	for _, note := range n.Linked {
		if _, err := fmt.Fprintf(out, "%s  - %s \"%s\" (%s)\n", prefix, note.ID, note.Title, note.Path); err != nil {
			return err
		}
	}
	return nil
}

// linksResponseForTest decodes a hub answer in tests that assert the envelope
// survives the round trip.
func linksResponseForTest(raw json.RawMessage) (linksResponse, error) {
	var answer linksResponse
	err := json.Unmarshal(raw, &answer)
	return answer, err
}
