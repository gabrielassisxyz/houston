package api

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gabrielassisxyz/houston/notes/internal/vault/frontmatter"
)

// readNoteFrontmatter returns the written note and its parsed frontmatter.
func readNoteFrontmatter(t *testing.T, path string) (string, *frontmatter.Frontmatter) {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read back %s: %v", path, err)
	}
	fm, err := frontmatter.Parse(raw)
	if err != nil {
		t.Fatalf("the written note does not parse: %v\n%q", err, raw)
	}
	return string(raw), fm
}

// TestVaultWriteFillsAnEmptyIDLine: the route injects the id before it writes,
// and a body whose id line is present but empty used to be written as it was,
// with no id, leaving the reconciler to mint one out of band.
func TestVaultWriteFillsAnEmptyIDLine(t *testing.T) {
	for name, value := range map[string]string{"bare": "", "null": "null", "tilde": "~", "comment": "# later"} {
		t.Run(name, func(t *testing.T) {
			root := t.TempDir()
			d := newTestDeps(t, root)

			code, doc := vaultFileWrite(t, d, "note.md", "---\ntitle: T\nid: "+value+"\n---\n\nbody\n")
			if code != http.StatusOK {
				t.Fatalf("expected 200, got %d (%+v)", code, doc)
			}
			raw, fm := readNoteFrontmatter(t, filepath.Join(root, "note.md"))
			if fm.ID == "" {
				t.Fatalf("the note was written without an id:\n%q", raw)
			}
			if strings.Count(raw, "\nid:") != 1 {
				t.Errorf("the note must carry exactly one id line:\n%q", raw)
			}
		})
	}
}

// TestVaultWriteUsesTheBlockWhateverItsFences: a body whose fences carry
// trailing spaces, or uses CRLF, used to be read as having no frontmatter, so
// the id - and with --tags the tags - went into a second block above it.
func TestVaultWriteUsesTheBlockWhateverItsFences(t *testing.T) {
	bodies := map[string]string{
		"spaces after both fences": "--- \ntitle: T\n---  \n\nbody\n",
		"CRLF":                     "---\r\ntitle: T\r\n---\r\n\r\nbody\r\n",
		"BOM":                      "\xEF\xBB\xBF---\ntitle: T\n---\n\nbody\n",
	}
	for name, body := range bodies {
		t.Run(name, func(t *testing.T) {
			root := t.TempDir()
			d := newTestDeps(t, root)

			code, doc := vaultFileWrite(t, d, "note.md&tags=alpha", body)
			if code != http.StatusOK {
				t.Fatalf("expected 200, got %d (%+v)", code, doc)
			}
			raw, fm := readNoteFrontmatter(t, filepath.Join(root, "note.md"))
			if fm.ID == "" || fm.Title != "T" || len(fm.Tags) != 1 || fm.Tags[0] != "alpha" {
				t.Fatalf("parsed back %+v, want an id, title T and tags [alpha], from:\n%q", fm, raw)
			}
			if n := strings.Count(raw, "---"); n != 2 {
				t.Errorf("the note holds %d fences, want its own 2:\n%q", n, raw)
			}
		})
	}
}
