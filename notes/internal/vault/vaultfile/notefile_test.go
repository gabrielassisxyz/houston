package vaultfile

import (
	"errors"
	"path/filepath"
	"testing"
)

func TestIsNoteFileIgnoresCase(t *testing.T) {
	for path, want := range map[string]bool{
		"note.md":       true,
		"Note.MD":       true,
		"dir/Note.Md":   true,
		"note.markdown": false,
		"note.md.txt":   false,
		"notes":         false,
		"image.png":     false,
	} {
		if got := IsNoteFile(path); got != want {
			t.Errorf("IsNoteFile(%q) = %v, want %v", path, got, want)
		}
	}
}

func TestTrimNoteExtIgnoresCase(t *testing.T) {
	for in, want := range map[string]string{
		"note.md":    "note",
		"Note.MD":    "Note",
		"dir/x.mD":   "dir/x",
		"note":       "note",
		"note.md.md": "note.md",
		".md":        "",
		"md":         "md",
	} {
		if got := TrimNoteExt(in); got != want {
			t.Errorf("TrimNoteExt(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestVaultRelRefusesPathsOutsideTheRoot(t *testing.T) {
	root := filepath.Join(string(filepath.Separator), "tmp", ".test", "vault")
	rel, err := VaultRel(root, filepath.Join(root, "notes", "a.md"))
	if err != nil || rel != filepath.Join("notes", "a.md") {
		t.Errorf("VaultRel inside = %q, %v", rel, err)
	}
	if rel, err := VaultRel(root, root); err != nil || rel != "." {
		t.Errorf("VaultRel of the root = %q, %v; want \".\"", rel, err)
	}
	for _, outside := range []string{
		filepath.Join(root, "..", "elsewhere.md"),
		filepath.Join(string(filepath.Separator), "vault", "a.md"),
	} {
		if _, err := VaultRel(root, outside); !errors.Is(err, ErrOutsideVault) {
			t.Errorf("VaultRel(%q) error = %v, want ErrOutsideVault", outside, err)
		}
	}
}

func TestIsHiddenRelLooksBelowTheRootOnly(t *testing.T) {
	for rel, want := range map[string]bool{
		".":                     false,
		"note.md":               false,
		"daily/2026-11-25.md":   false,
		".obsidian/app.json":    true,
		".trash/old.md":         true,
		"notes/.hidden.md":      true,
		"notes/.sync/x.md":      true,
		"a..b.md":               false,
		filepath.Join("x", "y"): false,
	} {
		if got := IsHiddenRel(rel); got != want {
			t.Errorf("IsHiddenRel(%q) = %v, want %v", rel, got, want)
		}
	}
	// A vault under a dot-named directory: the parent's dot is above the root.
	root := filepath.Join(string(filepath.Separator), "tmp", ".test")
	rel, err := VaultRel(root, filepath.Join(root, "note.md"))
	if err != nil {
		t.Fatalf("VaultRel: %v", err)
	}
	if IsHiddenRel(rel) {
		t.Errorf("a note at the root of %s is taken for hidden", root)
	}
}
