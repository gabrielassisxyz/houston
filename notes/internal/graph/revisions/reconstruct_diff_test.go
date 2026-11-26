package revisions_test

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"strconv"
	"strings"
	"testing"

	"github.com/gabrielassisxyz/houston/notes/internal/graph"
	"github.com/gabrielassisxyz/houston/notes/internal/graph/nodes"
	"github.com/gabrielassisxyz/houston/notes/internal/graph/revisions"
	"github.com/gabrielassisxyz/houston/notes/internal/graph/testutil"
	"pgregory.net/rapid"
)

// minPropertyChecks is the number of generated cases the property test must
// run, whatever -rapid.checks says.
const minPropertyChecks = 200

// recordedVersion is a revision of a note and the body the note had when that
// revision was written.
type recordedVersion struct {
	revID string
	body  string
	diff  json.RawMessage
}

// writeVersions creates a note with the first body and updates it to each of
// the following ones, recording after every write the newest revision of the
// note. An update that changes nothing writes no revision, so its entry
// repeats the previous revision, which holds the same body.
func writeVersions(g *graph.Graph, bodies []string) (string, []recordedVersion, error) {
	ctx := context.Background()
	author := nodes.Author{Name: "human"}
	var nodeID string
	var versions []recordedVersion
	for i, body := range bodies {
		err := g.DoWrite(ctx, func(tx *graph.WriteTx) error {
			if i == 0 {
				var err error
				nodeID, err = nodes.CreateNote(ctx, tx, nodes.Note{Title: "Edited", Body: body}, author)
				return err
			}
			return nodes.UpdateNote(ctx, tx, nodes.Note{ID: nodeID, Title: "Edited", Body: body}, author)
		})
		if err != nil {
			return "", nil, fmt.Errorf("write version %d: %w", i, err)
		}
		var newest revisions.Revision
		err = g.DoRead(ctx, func(tx *graph.ReadTx) error {
			revs, err := revisions.List(ctx, tx, nodeID)
			if err != nil {
				return err
			}
			if len(revs) == 0 {
				return fmt.Errorf("note %s has no revision", nodeID)
			}
			newest = revs[0]
			return nil
		})
		if err != nil {
			return "", nil, fmt.Errorf("read revision of version %d: %w", i, err)
		}
		versions = append(versions, recordedVersion{revID: newest.ID, body: body, diff: newest.Diff})
	}
	return nodeID, versions, nil
}

func reconstructBody(g *graph.Graph, nodeID, revID string) (string, error) {
	ctx := context.Background()
	var body string
	err := g.DoRead(ctx, func(tx *graph.ReadTx) error {
		var err error
		body, err = revisions.ReconstructBody(ctx, tx, nodeID, revID)
		return err
	})
	return body, err
}

// lineDiffOps returns how many line operations a stored diff carries; zero
// means the revision is a snapshot.
func lineDiffOps(diff json.RawMessage) int {
	var payload struct {
		Ops []json.RawMessage `json:"ops"`
	}
	if err := json.Unmarshal(diff, &payload); err != nil {
		return 0
	}
	return len(payload.Ops)
}

// assertEditReconstructs writes before and then after, and checks that the
// update was stored as a line diff and that it rebuilds to after exactly.
func assertEditReconstructs(t *testing.T, before, after string) {
	t.Helper()
	g := testutil.NewInMemoryTestGraph(t)
	nodeID, versions, err := writeVersions(g, []string{before, after})
	if err != nil {
		t.Fatal(err)
	}
	update := versions[1]
	if lineDiffOps(update.diff) == 0 {
		t.Fatalf("the update was stored as a snapshot, so it does not exercise the line diff: %s", update.diff)
	}
	got, err := reconstructBody(g, nodeID, update.revID)
	if err != nil {
		t.Fatalf("ReconstructBody: %v", err)
	}
	if got != after {
		t.Errorf("line diff %s\nreconstructs to\n%q\nwant\n%q", update.diff, got, after)
	}
}

func numberedBody(count int) []string {
	lines := make([]string, count)
	for i := range lines {
		lines[i] = "line " + strconv.Itoa(i+1)
	}
	return lines
}

func joinLines(lines []string) string { return strings.Join(lines, "\n") }

// The defect as it was found: replacing line 10 of a 20-line note stored a
// "+" and a "-" at the same index, and the replay inserted the new line and
// then deleted it, bringing back the unedited text.
func TestReconstructAfterReplacingLineTenOfTwenty(t *testing.T) {
	before := numberedBody(20)
	after := numberedBody(20)
	after[9] = "line ten"
	assertEditReconstructs(t, joinLines(before), joinLines(after))
}

func TestLineDiffReconstructsEditShapes(t *testing.T) {
	cases := []struct {
		name string
		edit func(lines []string) []string
	}{
		{"insertion only", func(lines []string) []string {
			// Two insertions apart, so that the second one's index depends
			// on the first one having been applied.
			out := append([]string{"inserted near the top"}, lines[:7]...)
			out = append(out, "inserted further down")
			return append(out, lines[7:]...)
		}},
		{"deletion only", func(lines []string) []string {
			out := append([]string{}, lines[:2]...)
			out = append(out, lines[3:8]...)
			return append(out, lines[9:]...)
		}},
		{"replacement at the first line", func(lines []string) []string {
			lines[0] = "first, replaced"
			return lines
		}},
		{"replacement at the last line", func(lines []string) []string {
			lines[len(lines)-1] = "last, replaced"
			return lines
		}},
		{"replacement in the middle", func(lines []string) []string {
			lines[5] = "middle, replaced"
			return lines
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			before := joinLines(numberedBody(12))
			after := joinLines(tc.edit(numberedBody(12)))
			assertEditReconstructs(t, before, after)
		})
	}
}

// raiseRapidChecks makes rapid run at least minimum checks in this test, and
// puts the flag back when the test ends. testing.Short divides the count by
// five inside rapid, so the floor is raised to survive that.
func raiseRapidChecks(t *testing.T, minimum int) {
	t.Helper()
	if testing.Short() {
		minimum *= 5
	}
	f := flag.Lookup("rapid.checks")
	if f == nil {
		t.Fatal("rapid registered no -rapid.checks flag")
	}
	previous := f.Value.String()
	current, err := strconv.Atoi(previous)
	if err != nil {
		t.Fatalf("-rapid.checks is %q: %v", previous, err)
	}
	if current >= minimum {
		return
	}
	if err := flag.Set("rapid.checks", strconv.Itoa(minimum)); err != nil {
		t.Fatalf("set -rapid.checks: %v", err)
	}
	t.Cleanup(func() { _ = flag.Set("rapid.checks", previous) })
}

// bodyLines is a small alphabet, so that equal lines repeat and the longest
// common subsequence has many ways to match. The empty line puts blank lines
// and trailing newlines into the generated bodies.
var bodyLines = []string{"a", "b", "c", ""}

func drawBody(rt *rapid.T, label string) string {
	return joinLines(rapid.SliceOfN(rapid.SampledFrom(bodyLines), 0, 40).Draw(rt, label))
}

// Every version of a note, written through create and update, rebuilds to the
// body it had. Each generated case is a creation followed by one to three
// updates, and every revision of the case is reconstructed.
func TestLineDiffReconstructsAnyEdit(t *testing.T) {
	raiseRapidChecks(t, minPropertyChecks)
	g := testutil.NewInMemoryTestGraph(t)

	var checks, updates, lineDiffs int
	rapid.Check(t, func(rt *rapid.T) {
		bodies := []string{drawBody(rt, "created")}
		edits := rapid.IntRange(1, 3).Draw(rt, "updates")
		for i := 1; i <= edits; i++ {
			bodies = append(bodies, drawBody(rt, fmt.Sprintf("update %d", i)))
		}

		nodeID, versions, err := writeVersions(g, bodies)
		if err != nil {
			rt.Fatal(err)
		}
		for i, v := range versions {
			got, err := reconstructBody(g, nodeID, v.revID)
			if err != nil {
				rt.Fatalf("version %d: ReconstructBody: %v", i, err)
			}
			if got != v.body {
				rt.Fatalf("version %d, stored as %s\nreconstructs to\n%q\nwant\n%q", i, v.diff, got, v.body)
			}
			if i > 0 && v.revID != versions[i-1].revID && lineDiffOps(v.diff) > 0 {
				lineDiffs++
			}
		}
		checks++
		updates += edits
	})
	if t.Failed() {
		return
	}

	if checks < minPropertyChecks {
		t.Errorf("the property ran %d checks, want at least %d", checks, minPropertyChecks)
	}
	// Most generated pairs stay under MaxChangeRatio. If almost none is
	// stored as a line diff, the cases only exercise snapshots and prove
	// nothing about lineDiff.
	if lineDiffs*4 < updates {
		t.Errorf("only %d of %d updates were stored as a line diff, want at least a quarter", lineDiffs, updates)
	}
	t.Logf("%d checks, %d updates, %d stored as a line diff", checks, updates, lineDiffs)
}
