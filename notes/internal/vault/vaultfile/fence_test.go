package vaultfile

import "testing"

func TestScanFrontmatterFindsNoBlock(t *testing.T) {
	cases := map[string]string{
		"empty":                    "",
		"plain body":               "# Title\nbody\n",
		"fence not on first line":  "\n---\nid: x\n---\n",
		"four dashes":              "----\nid: x\n---\n",
		"text after the dashes":    "--- x\nid: x\n---\n",
		"opening fence at the end": "---",
		"opening fence then CR":    "---\r",
		"dashes after other text":  "x---\nid: x\n---\n",
	}
	for name, in := range cases {
		t.Run(name, func(t *testing.T) {
			if got := ScanFrontmatter([]byte(in)); got.State != NoBlock {
				t.Fatalf("ScanFrontmatter(%q) = %+v, want NoBlock", in, got)
			}
		})
	}
}

func TestScanFrontmatterFindsAClosedBlock(t *testing.T) {
	cases := []struct {
		name  string
		in    string
		yaml  string
		after string
	}{
		{"LF", "---\nid: x\n---\nbody\n", "id: x\n", "body\n"},
		{"CRLF", "---\r\nid: x\r\n---\r\nbody\r\n", "id: x\r\n", "body\r\n"},
		{"LF opening, CRLF after", "---\nid: x\r\n---\r\nbody\r\n", "id: x\r\n", "body\r\n"},
		{"BOM", "\xEF\xBB\xBF---\nid: x\n---\nbody\n", "id: x\n", "body\n"},
		{"spaces after both fences", "--- \nid: x\n---  \nbody\n", "id: x\n", "body\n"},
		{"tabs after both fences, CRLF", "---\t\r\nid: x\r\n--- \t\r\nbody\r\n", "id: x\r\n", "body\r\n"},
		{"closing fence ends the file", "---\nid: x\n---", "id: x\n", ""},
		{"closing fence with spaces ends the file", "---\nid: x\n---   ", "id: x\n", ""},
		{"empty block", "---\n---\nbody\n", "", "body\n"},
		{"four dashes inside the block", "---\ntitle: \"a\n----\nb\"\n---\nbody\n", "title: \"a\n----\nb\"\n", "body\n"},
		{"dashes then text inside the block", "---\ntitle: \"a\n---x\nb\"\n---\nbody\n", "title: \"a\n---x\nb\"\n", "body\n"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			raw := []byte(tc.in)
			got := ScanFrontmatter(raw)
			if got.State != ClosedBlock {
				t.Fatalf("ScanFrontmatter(%q) = %+v, want ClosedBlock", tc.in, got)
			}
			if yaml := string(raw[got.Start:got.Close]); yaml != tc.yaml {
				t.Errorf("YAML = %q, want %q", yaml, tc.yaml)
			}
			if after := string(raw[got.End:]); after != tc.after {
				t.Errorf("after the block = %q, want %q", after, tc.after)
			}
			if fence := string(raw[got.Close:got.End]); len(fence) < 3 || fence[:3] != "---" {
				t.Errorf("closing fence span = %q, want a line starting with ---", fence)
			}
		})
	}
}

func TestScanFrontmatterReportsTheOpeningOffset(t *testing.T) {
	if got := ScanFrontmatter([]byte("\xEF\xBB\xBF---\nid: x\n---\n")); got.Open != 3 || got.Start != 7 {
		t.Fatalf("behind a BOM: Open=%d Start=%d, want 3 and 7", got.Open, got.Start)
	}
	if got := ScanFrontmatter([]byte("---  \r\nid: x\r\n---\r\n")); got.Open != 0 || got.Start != 7 {
		t.Fatalf("with spaces and CRLF: Open=%d Start=%d, want 0 and 7", got.Open, got.Start)
	}
}

func TestScanFrontmatterFindsAnUnclosedBlock(t *testing.T) {
	cases := map[string]string{
		"opening fence alone":       "---\n",
		"no closing fence":          "---\ntitle: x\nbody\n",
		"only four dashes close it": "---\ntitle: x\n----\nbody\n",
		"only an indented fence":    "---\ntitle: x\n ---\nbody\n",
		"closing fence then CR":     "---\ntitle: x\n---\r",
	}
	for name, in := range cases {
		t.Run(name, func(t *testing.T) {
			got := ScanFrontmatter([]byte(in))
			if got.State != UnclosedBlock {
				t.Fatalf("ScanFrontmatter(%q) = %+v, want UnclosedBlock", in, got)
			}
			if got.Start != 4 {
				t.Errorf("Start = %d, want 4", got.Start)
			}
		})
	}
}
