package reconcile

import "testing"

// TestExtractBodyReadsEveryFenceShape covers the body reader the reconciler
// indexes and WriteNoteBody keeps the frontmatter by. A block it fails to see
// is indexed as body, YAML and all, and a block it ends too early at a line of
// four dashes leaves the rest of the YAML in the body.
func TestExtractBodyReadsEveryFenceShape(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want string
	}{
		{"spaces after both fences", "--- \ntitle: Spaced\n---  \n\nbody\n", "body\n"},
		{"tab after the closing fence", "---\ntitle: Tabbed\n---\t\nbody\n", "body\n"},
		{"four dashes inside the block", "---\ntitle: \"a\n----\nb\"\n---\nbody\n", "body\n"},
		{"CRLF", "---\r\ntitle: Crlf\r\n---\r\n\r\nbody\r\n", "body\r\n"},
		{"BOM", "\xEF\xBB\xBF---\ntitle: Bom\n---\nbody\n", "body\n"},
		{"closing fence ends the file", "---\ntitle: T\n---", ""},
		{"no block", "# Heading\nbody\n", "# Heading\nbody\n"},
		// An unterminated block is read as body, whole: the present answer.
		{"unterminated block", "---\ntitle: never closed\nbody\n", "---\ntitle: never closed\nbody\n"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := extractBody([]byte(tc.raw)); got != tc.want {
				t.Errorf("extractBody(%q) = %q, want %q", tc.raw, got, tc.want)
			}
		})
	}
}
