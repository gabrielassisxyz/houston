package frontmatter

import (
	"strings"
	"testing"
)

func TestHouOc517StringListNullOrEmpty(t *testing.T) {
	for _, raw := range []string{
		"---\nid: a\n---\nbody\n",
		"---\nid: a\ntags:\n---\nbody\n",
		"---\nid: a\ntags: null\nrefs:\n---\nbody\n",
		"---\nid: a\ntags: []\nrefs: []\n---\nbody\n",
	} {
		fm, err := Parse([]byte(raw))
		if err != nil {
			t.Fatalf("Parse %q: %v", raw, err)
		}
		if len(fm.Tags) != 0 {
			t.Errorf("tags = %v, want empty for %q", []string(fm.Tags), raw)
		}
		if len(fm.Refs) != 0 {
			t.Errorf("refs = %v, want empty for %q", []string(fm.Refs), raw)
		}
	}
}

func TestHouOc517StringListSingleScalar(t *testing.T) {
	fm, err := Parse([]byte("---\nid: a\ntags: foo\n---\nbody\n"))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if len(fm.Tags) != 1 || fm.Tags[0] != "foo" {
		t.Errorf("tags = %v, want [foo]", []string(fm.Tags))
	}

	fm, err = Parse([]byte("---\nid: a\nrefs: 12345\n---\nbody\n"))
	if err != nil {
		t.Fatalf("Parse refs scalar number: %v", err)
	}
	if len(fm.Refs) != 1 || fm.Refs[0] != "12345" {
		t.Errorf("refs = %v, want [12345]", []string(fm.Refs))
	}
}

func TestHouOc517StringListSequenceDropsBlanks(t *testing.T) {
	fm, err := Parse([]byte("---\nid: a\ntags:\n  - one\n  - \"  \"\n  - two\nrefs: [12345]\n---\nbody\n"))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if len(fm.Tags) != 2 || fm.Tags[0] != "one" || fm.Tags[1] != "two" {
		t.Errorf("tags = %v, want [one two]", []string(fm.Tags))
	}
	if len(fm.Refs) != 1 || fm.Refs[0] != "12345" {
		t.Errorf("refs = %v, want [12345]", []string(fm.Refs))
	}
}

func TestHouOc517StringListMappingFails(t *testing.T) {
	_, err := Parse([]byte("---\nid: a\ntags: {a: 1}\n---\nbody\n"))
	if err == nil {
		t.Fatal("expected error for tags mapping, got nil")
	}
}

func TestHouOc517StringListNestedSequenceFails(t *testing.T) {
	_, err := Parse([]byte("---\nid: a\nrefs:\n  - - nested\n---\nbody\n"))
	if err == nil {
		t.Fatal("expected error for nested sequence, got nil")
	}
}

func TestHouOc517KindNormalization(t *testing.T) {
	cases := []struct{ in, want string }{
		{"Plano", "plano"},
		{"  IMPLEMENTACAO ", "implementacao"},
		{"Evidencia", "evidencia"},
		{"nota", "nota"},
		{"", "nota"},
		{"bogus", "nota"},
	}
	for _, tc := range cases {
		raw := "---\nid: a\nkind: " + tc.in + "\n---\nbody\n"
		// Empty kind renders as `kind: ` which still parses.
		if tc.in == "" {
			raw = "---\nid: a\nkind:\n---\nbody\n"
		}
		fm, err := Parse([]byte(raw))
		if err != nil {
			t.Fatalf("Parse kind %q: %v", tc.in, err)
		}
		if fm.Kind != tc.want {
			t.Errorf("kind %q = %q, want %q", tc.in, fm.Kind, tc.want)
		}
	}

	fm, err := Parse([]byte("---\nid: a\n---\nbody\n"))
	if err != nil {
		t.Fatalf("Parse missing kind: %v", err)
	}
	if fm.Kind != "nota" {
		t.Errorf("missing kind = %q, want nota", fm.Kind)
	}
}

func TestHouOc517KindTrimmedLowerCased(t *testing.T) {
	if got := NormalizeKind("  Plano "); got != "plano" {
		t.Errorf("NormalizeKind = %q, want plano", got)
	}
	if got := NormalizeKind(""); got != "nota" {
		t.Errorf("NormalizeKind empty = %q, want nota", got)
	}
	if !strings.Contains(NormalizeKind("X"), "nota") {
		t.Errorf("NormalizeKind unknown should be nota")
	}
}
