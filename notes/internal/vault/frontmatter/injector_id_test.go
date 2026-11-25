package frontmatter

import "testing"

// TestInjectIDFillsAnEmptyIDLine covers every spelling yaml.v3 reads as an
// empty id. Left as it was, the file has no id however often an id is minted
// for it; given a second id key, it no longer parses.
func TestInjectIDFillsAnEmptyIDLine(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"bare", "---\ntitle: T\nid:\n---\nbody\n", "---\ntitle: T\nid: u-1\n---\nbody\n"},
		{"trailing blanks", "---\ntitle: T\nid:  \t\n---\nbody\n", "---\ntitle: T\nid: u-1\n---\nbody\n"},
		{"double quotes", "---\ntitle: T\nid: \"\"\n---\nbody\n", "---\ntitle: T\nid: u-1\n---\nbody\n"},
		{"single quotes", "---\nid: ''\ntitle: T\n---\nbody\n", "---\nid: u-1\ntitle: T\n---\nbody\n"},
		{"null", "---\nid: null\n---\nbody\n", "---\nid: u-1\n---\nbody\n"},
		{"NULL", "---\nid: NULL\n---\nbody\n", "---\nid: u-1\n---\nbody\n"},
		{"Null", "---\nid: Null\n---\nbody\n", "---\nid: u-1\n---\nbody\n"},
		{"tilde", "---\nid: ~\n---\nbody\n", "---\nid: u-1\n---\nbody\n"},
		{"comment", "---\nid: # filled in later\ntitle: T\n---\nbody\n", "---\nid: u-1\ntitle: T\n---\nbody\n"},
		{"blank before the colon", "---\nid :\n---\nbody\n", "---\nid: u-1\n---\nbody\n"},
		{"quoted key", "---\n\"id\": null\n---\nbody\n", "---\nid: u-1\n---\nbody\n"},
		{"CRLF", "---\r\ntitle: T\r\nid:\r\n---\r\nbody\r\n", "---\r\ntitle: T\r\nid: u-1\r\n---\r\nbody\r\n"},
		{"BOM", "\xEF\xBB\xBF---\nid: ~\n---\nbody\n", "\xEF\xBB\xBF---\nid: u-1\n---\nbody\n"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := InjectID([]byte(tc.in), "u-1")
			if err != nil {
				t.Fatalf("InjectID: %v", err)
			}
			if string(got) != tc.want {
				t.Errorf("InjectID(%q) =\n%q\nwant\n%q", tc.in, got, tc.want)
			}
		})
	}
}

// TestInjectIDIgnoresANestedID keeps an indented id where it is: it belongs
// to a nested mapping, and the note's own id goes in at the top.
func TestInjectIDIgnoresANestedID(t *testing.T) {
	in := "---\nparent:\n  id:\ntitle: T\n---\nbody\n"
	want := "---\nid: u-1\nparent:\n  id:\ntitle: T\n---\nbody\n"
	got, err := InjectID([]byte(in), "u-1")
	if err != nil {
		t.Fatalf("InjectID: %v", err)
	}
	if string(got) != want {
		t.Errorf("InjectID(%q) =\n%q\nwant\n%q", in, got, want)
	}
}

// TestInjectIDRefusesWhatItCannotWriteCleanly is the safety net: an empty id
// whose value sits on the next line cannot take an id on its own line without
// changing what the next line means, and the injector says so rather than
// hand back a note that does not carry the id.
func TestInjectIDRefusesWhatItCannotWriteCleanly(t *testing.T) {
	in := "---\nid:\n  \"\"\ntitle: T\n---\nbody\n"
	fm, err := Parse([]byte(in))
	if err != nil || fm.ID != "" {
		t.Fatalf("fixture must parse with an empty id, got %+v, %v", fm, err)
	}
	if got, err := InjectID([]byte(in), "u-1"); err == nil {
		t.Fatalf("InjectID returned a note it could not inject cleanly:\n%q", got)
	}
}
