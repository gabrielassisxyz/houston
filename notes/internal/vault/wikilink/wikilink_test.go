package wikilink

import (
	"testing"
)

// TestParsePlain verifies that a bare [[Target]] link is extracted.
func TestParsePlain(t *testing.T) {
	links := Parse("See [[Roadmap]] for details.")
	if len(links) != 1 {
		t.Fatalf("expected 1 link, got %d", len(links))
	}
	if links[0].Target != "Roadmap" {
		t.Errorf("expected target 'Roadmap', got %q", links[0].Target)
	}
	if links[0].Alias != "" {
		t.Errorf("expected empty alias, got %q", links[0].Alias)
	}
}

// TestParseAliased verifies that [[Target|Alias]] yields correct Target and Alias.
func TestParseAliased(t *testing.T) {
	links := Parse("See [[Roadmap|The Plan]] for details.")
	if len(links) != 1 {
		t.Fatalf("expected 1 link, got %d", len(links))
	}
	if links[0].Target != "Roadmap" {
		t.Errorf("expected target 'Roadmap', got %q", links[0].Target)
	}
	if links[0].Alias != "The Plan" {
		t.Errorf("expected alias 'The Plan', got %q", links[0].Alias)
	}
}

// TestParseUUIDAliased verifies that [[uuid|Alias]] is parsed with UUID as target.
func TestParseUUIDAliased(t *testing.T) {
	uuid := "550e8400-e29b-41d4-a716-446655440000"
	links := Parse("See [[" + uuid + "|My Note]] here.")
	if len(links) != 1 {
		t.Fatalf("expected 1 link, got %d", len(links))
	}
	if links[0].Target != uuid {
		t.Errorf("expected target %q, got %q", uuid, links[0].Target)
	}
	if links[0].Alias != "My Note" {
		t.Errorf("expected alias 'My Note', got %q", links[0].Alias)
	}
}

// TestParseMultiple verifies that multiple distinct links on one line are all extracted.
func TestParseMultiple(t *testing.T) {
	links := Parse("[[Alpha]] and [[Beta]] and [[Gamma]].")
	if len(links) != 3 {
		t.Fatalf("expected 3 links, got %d: %+v", len(links), links)
	}
	targets := []string{"Alpha", "Beta", "Gamma"}
	for i, want := range targets {
		if links[i].Target != want {
			t.Errorf("link[%d]: expected %q, got %q", i, want, links[i].Target)
		}
	}
}

// TestParseDeduplicated verifies that duplicate [[Target|Alias]] pairs appear only once.
func TestParseDeduplicated(t *testing.T) {
	links := Parse("[[Roadmap]] and again [[Roadmap]] and [[Roadmap|Plan]].")
	// "Roadmap|" and "Roadmap|Plan" are distinct keys; the second "Roadmap" is a dup.
	if len(links) != 2 {
		t.Fatalf("expected 2 deduplicated links, got %d: %+v", len(links), links)
	}
	if links[0].Target != "Roadmap" || links[0].Alias != "" {
		t.Errorf("link[0]: expected Roadmap/'', got %q/%q", links[0].Target, links[0].Alias)
	}
	if links[1].Target != "Roadmap" || links[1].Alias != "Plan" {
		t.Errorf("link[1]: expected Roadmap/Plan, got %q/%q", links[1].Target, links[1].Alias)
	}
}

// TestParseFencedCodeSkipped verifies that [[...]] inside fenced code blocks are not extracted.
func TestParseFencedCodeSkipped(t *testing.T) {
	content := "Before.\n```\n[[InsideFence]]\n```\nAfter."
	links := Parse(content)
	if len(links) != 0 {
		t.Errorf("expected 0 links (all inside fence), got %d: %+v", len(links), links)
	}
}

// TestParseFencedCodeSkippedWithOutsideLinks verifies links outside fences are still extracted.
func TestParseFencedCodeSkippedWithOutsideLinks(t *testing.T) {
	content := "See [[Outside]].\n```\n[[InsideFence]]\n```\nEnd."
	links := Parse(content)
	if len(links) != 1 {
		t.Fatalf("expected 1 link (only Outside), got %d: %+v", len(links), links)
	}
	if links[0].Target != "Outside" {
		t.Errorf("expected target 'Outside', got %q", links[0].Target)
	}
}

// TestParseInlineCodeSkipped verifies that [[...]] inside inline code is not extracted.
func TestParseInlineCodeSkipped(t *testing.T) {
	content := "Use `[[InlineCode]]` or [[Real]]."
	links := Parse(content)
	if len(links) != 1 {
		t.Fatalf("expected 1 link, got %d: %+v", len(links), links)
	}
	if links[0].Target != "Real" {
		t.Errorf("expected target 'Real', got %q", links[0].Target)
	}
}

// TestParseEmptyContent verifies that empty content yields no links.
func TestParseEmptyContent(t *testing.T) {
	links := Parse("")
	if len(links) != 0 {
		t.Errorf("expected 0 links, got %d", len(links))
	}
}

// TestParseNoLinks verifies content with no wikilinks yields an empty slice.
func TestParseNoLinks(t *testing.T) {
	links := Parse("This is plain text with no wikilinks.")
	if len(links) != 0 {
		t.Errorf("expected 0 links, got %d", len(links))
	}
}

// TestParseLineNumbers verifies that line numbers are 0-indexed.
func TestParseLineNumbers(t *testing.T) {
	content := "line0\nline1 [[Target]]"
	links := Parse(content)
	if len(links) != 1 {
		t.Fatalf("expected 1 link, got %d", len(links))
	}
	if links[0].Line != 1 {
		t.Errorf("expected line 1, got %d", links[0].Line)
	}
}

// TestClassifyTargetUUID verifies that a UUID string is classified as KindUUID.
func TestClassifyTargetUUID(t *testing.T) {
	uuid := "550e8400-e29b-41d4-a716-446655440000"
	if ClassifyTarget(uuid) != KindUUID {
		t.Errorf("expected KindUUID for %q, got %v", uuid, ClassifyTarget(uuid))
	}
}

// TestClassifyTargetStem verifies that a plain name is classified as KindStem.
func TestClassifyTargetStem(t *testing.T) {
	if ClassifyTarget("Roadmap") != KindStem {
		t.Errorf("expected KindStem for 'Roadmap', got %v", ClassifyTarget("Roadmap"))
	}
}

// TestClassifyTargetStemNotUUID verifies that a string with UUID-like parts but wrong format is a stem.
func TestClassifyTargetStemNotUUID(t *testing.T) {
	// Too short, not UUID
	if ClassifyTarget("abc-def-ghi") != KindStem {
		t.Errorf("expected KindStem for 'abc-def-ghi'")
	}
}

// TestParseRawText verifies the RawText field contains the full [[...]] text.
func TestParseRawText(t *testing.T) {
	links := Parse("See [[Roadmap|Plan]].")
	if len(links) != 1 {
		t.Fatalf("expected 1 link, got %d", len(links))
	}
	if links[0].RawText != "[[Roadmap|Plan]]" {
		t.Errorf("expected RawText '[[Roadmap|Plan]]', got %q", links[0].RawText)
	}
}

// TestParseMultipleLines verifies links across multiple lines.
func TestParseMultipleLines(t *testing.T) {
	content := "[[A]]\n[[B]]\n[[C]]"
	links := Parse(content)
	if len(links) != 3 {
		t.Fatalf("expected 3 links, got %d", len(links))
	}
	for i, want := range []string{"A", "B", "C"} {
		if links[i].Target != want {
			t.Errorf("link[%d]: expected %q, got %q", i, want, links[i].Target)
		}
		if links[i].Line != i {
			t.Errorf("link[%d]: expected line %d, got %d", i, i, links[i].Line)
		}
	}
}

// TestParseEmbedsIgnored verifies that ![[...]] embeds are not treated as note links.
func TestParseEmbedsIgnored(t *testing.T) {
	content := "![[image.png]] and ![[OtherNote]] and ![[Note|Alias]] and [[RealNote]] and bang! [[AfterBang]]."
	links := Parse(content)
	if len(links) != 2 {
		t.Fatalf("expected 2 non-embed links, got %d: %+v", len(links), links)
	}
	if links[0].Target != "RealNote" {
		t.Errorf("link[0]: expected 'RealNote', got %q", links[0].Target)
	}
	if links[1].Target != "AfterBang" {
		t.Errorf("link[1]: expected 'AfterBang', got %q", links[1].Target)
	}
}

// TestParseNonNoteExtensionsIgnored verifies every known attachment extension is
// ignored (case-insensitively and with anchors), while dotted note names are kept.
func TestParseNonNoteExtensionsIgnored(t *testing.T) {
	ignored := []string{
		"[[photo.png]]", "[[photo.PNG]]", "[[a/b.jpg]]", "[[a.jpeg]]",
		"[[a.gif]]", "[[a.svg]]", "[[a.webp]]", "[[report.pdf]]",
		"[[report.PDF#page=2]]", "[[clip.mp3]]", "[[clip.mp4]]",
		"[[clip.wav]]", "[[data.csv]]", "[[sheet.xlsx]]", "[[doc.docx]]",
		"[[deck.pptx]]", "[[bundle.zip]]", "[[bundle.tar]]", "[[bundle.tar.gz]]",
	}
	for _, raw := range ignored {
		if links := Parse(raw); len(links) != 0 {
			t.Errorf("Parse(%q): expected 0 links for non-note attachment, got %+v", raw, links)
		}
	}

	kept := []struct {
		raw    string
		target string
	}{
		{"[[2026.11.25]]", "2026.11.25"},
		{"[[v1.2]]", "v1.2"},
		{"[[2^n]]", "2^n"},
		{"[[a/b.md]]", "a/b.md"},
		{"[[Note#Heading]]", "Note#Heading"},
		{"[[Note#^block]]", "Note#^block"},
	}
	for _, tc := range kept {
		links := Parse(tc.raw)
		if len(links) != 1 || links[0].Target != tc.target {
			t.Errorf("Parse(%q): got %+v, want single target %q", tc.raw, links, tc.target)
		}
	}
}

// TestParseAnchorOnlySkipped verifies [[#Heading]] and [[^block]] produce no links.
func TestParseAnchorOnlySkipped(t *testing.T) {
	links := Parse("Jump to [[#Heading]], [[#Heading|Alias]], or [[^block-1]] and [[Keep]].")
	if len(links) != 1 {
		t.Fatalf("expected 1 link (only Keep), got %d: %+v", len(links), links)
	}
	if links[0].Target != "Keep" {
		t.Errorf("expected target 'Keep', got %q", links[0].Target)
	}
}

// TestNormalizeTarget covers anchor stripping, anchor-only links, caret inside
// names, path separator normalization, .md stripping, and lowercasing.
func TestNormalizeTarget(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{"Roadmap", "roadmap"},
		{"Note#Heading", "note"},
		{"Note#^block-id", "note"},
		{"Note#A#B", "note"},
		{"#Heading", ""},
		{" #Heading", ""},
		{"^block", ""},
		{"2^n", "2^n"},
		{"2026.11.25", "2026.11.25"},
		{"v1.2", "v1.2"},
		{"a/b.md", "a/b"},
		{"A/B.MD", "a/b"},
		{"a\\b\\Note.md", "a/b/note"},
		{"a/b.md#Section", "a/b"},
		{"  Sub/Note  #Heading ", "sub/note"},
		{"550E8400-E29B-41D4-A716-446655440000", "550e8400-e29b-41d4-a716-446655440000"},
		{"", ""},
		{".md", ""},
	}
	for _, tc := range cases {
		if got := NormalizeTarget(tc.in); got != tc.want {
			t.Errorf("NormalizeTarget(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}
