package frontmatter

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// fencedNotes are the fence shapes every frontmatter reader must agree on.
// Each carries a title, so a reader that missed the block reads none.
var fencedNotes = []struct {
	name  string
	raw   string
	title string
	// tail is the closing fence line and the body, which no writer may touch.
	tail string
}{
	{"spaces after both fences", "--- \ntitle: Spaced\n---  \nbody\n", "Spaced", "\n---  \nbody\n"},
	{"tab after the closing fence", "---\ntitle: Tabbed\n---\t\nbody\n", "Tabbed", "\n---\t\nbody\n"},
	{"four dashes inside the block", "---\ntitle: \"a\n----\nb\"\n---\nbody\n", "a ---- b", "\nb\"\n---\nbody\n"},
	{"CRLF", "---\r\ntitle: Crlf\r\n---\r\nbody\r\n", "Crlf", "\r\n---\r\nbody\r\n"},
	{"BOM", "\xEF\xBB\xBF---\ntitle: Bom\n---\nbody\n", "Bom", "\n---\nbody\n"},
}

const unterminatedNote = "---\ntitle: never closed\nbody\n"

func TestParseReadsEveryFenceShape(t *testing.T) {
	for _, tc := range fencedNotes {
		t.Run(tc.name, func(t *testing.T) {
			fm, err := Parse([]byte(tc.raw))
			if err != nil {
				t.Fatalf("Parse: %v", err)
			}
			if fm.Title != tc.title {
				t.Errorf("title = %q, want %q", fm.Title, tc.title)
			}
		})
	}
}

func TestParseRefusesAnUnterminatedBlock(t *testing.T) {
	if _, err := Parse([]byte(unterminatedNote)); err == nil {
		t.Fatal("Parse accepted a block that is never closed")
	}
}

// assertSingleBlock fails when got does not open with the same fence line as
// raw, which is what a second block prepended above the first looks like.
func assertSingleBlock(t *testing.T, raw, got []byte) {
	t.Helper()
	firstLine := func(b []byte) []byte {
		if i := bytes.IndexByte(b, '\n'); i >= 0 {
			return b[:i+1]
		}
		return b
	}
	if !bytes.Equal(firstLine(got), firstLine(raw)) {
		t.Errorf("the result opens with %q instead of the note's own fence %q:\n%q", firstLine(got), firstLine(raw), got)
	}
}

func TestInjectIDUsesTheExistingBlockForEveryFenceShape(t *testing.T) {
	for _, tc := range fencedNotes {
		t.Run(tc.name, func(t *testing.T) {
			raw := []byte(tc.raw)
			got, err := InjectID(raw, "u-1")
			if err != nil {
				t.Fatalf("InjectID: %v", err)
			}
			assertSingleBlock(t, raw, got)
			fm, err := Parse(got)
			if err != nil {
				t.Fatalf("the injected note does not parse: %v\n%q", err, got)
			}
			if fm.ID != "u-1" || fm.Title != tc.title {
				t.Errorf("parsed back id=%q title=%q, want u-1 and %q", fm.ID, fm.Title, tc.title)
			}
			if !bytes.HasSuffix(got, []byte(tc.tail)) {
				t.Errorf("the closing fence or the body changed: %q", got)
			}
		})
	}
}

func TestInjectIDRefusesAnUnterminatedBlock(t *testing.T) {
	if _, err := InjectID([]byte(unterminatedNote), "u-1"); err == nil {
		t.Fatal("InjectID wrote into a block that is never closed")
	}
}

func TestInjectTagsUsesTheExistingBlockForEveryFenceShape(t *testing.T) {
	for _, tc := range fencedNotes {
		t.Run(tc.name, func(t *testing.T) {
			raw := []byte(tc.raw)
			got, err := InjectTags(raw, []string{"alpha"})
			if err != nil {
				t.Fatalf("InjectTags: %v", err)
			}
			assertSingleBlock(t, raw, got)
			fm, err := Parse(got)
			if err != nil {
				t.Fatalf("the tagged note does not parse: %v\n%q", err, got)
			}
			if fm.Title != tc.title || len(fm.Tags) != 1 || fm.Tags[0] != "alpha" {
				t.Errorf("parsed back title=%q tags=%v, want %q and [alpha]", fm.Title, fm.Tags, tc.title)
			}
			if !strings.HasSuffix(string(got), tc.tail[strings.Index(tc.tail, "---"):]) {
				t.Errorf("the closing fence or the body changed: %q", got)
			}
		})
	}
}

func TestInjectTagsRefusesAnUnterminatedBlock(t *testing.T) {
	if _, err := InjectTags([]byte(unterminatedNote), []string{"alpha"}); err == nil {
		t.Fatal("InjectTags wrote into a block that is never closed")
	}
}

// TestGoldensKeepTheirAnswers pins the two goldens the fence scanner could
// have changed: an empty file still gets a block injected into it (the
// reconciler, not the injector, is what declines to touch an empty file), and
// an unterminated block is still refused.
func TestGoldensKeepTheirAnswers(t *testing.T) {
	const goldenUUID = "00000000-0000-0000-0000-000000000001"
	empty, err := os.ReadFile(filepath.Join("testdata", "empty_file.md"))
	if err != nil {
		t.Fatal(err)
	}
	want, err := os.ReadFile(filepath.Join("testdata", "empty_file_expected.md"))
	if err != nil {
		t.Fatal(err)
	}
	got, err := InjectID(empty, goldenUUID)
	if err != nil {
		t.Fatalf("InjectID(empty_file.md): %v", err)
	}
	if !bytes.Equal(got, want) {
		t.Errorf("InjectID(empty_file.md) = %q, want %q", got, want)
	}

	malformed, err := os.ReadFile(filepath.Join("testdata", "malformed_unterminated.md"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Parse(malformed); err == nil || !strings.Contains(err.Error(), "unterminated") {
		t.Errorf("Parse(malformed_unterminated.md) error = %v, want the unterminated-block refusal", err)
	}
	if _, err := InjectID(malformed, goldenUUID); err == nil {
		t.Error("InjectID(malformed_unterminated.md) must refuse")
	}
}
