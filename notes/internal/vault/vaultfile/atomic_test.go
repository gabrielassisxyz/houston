package vaultfile

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"testing"
)

func readString(t *testing.T, path string) string {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return string(raw)
}

// assertOnlyEntries fails when dir holds anything besides names, which is how
// a temporary file left behind shows up.
func assertOnlyEntries(t *testing.T, dir string, names ...string) {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("read dir: %v", err)
	}
	want := map[string]bool{}
	for _, n := range names {
		want[n] = true
	}
	for _, e := range entries {
		if !want[e.Name()] {
			t.Errorf("unexpected entry %q left in %s", e.Name(), dir)
		}
	}
	if len(entries) != len(names) {
		t.Errorf("dir holds %d entries, want %d", len(entries), len(names))
	}
}

func TestWriteFileAtomicKeepsTheExistingMode(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "note.md")
	if err := os.WriteFile(path, []byte("old\n"), 0o640); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, 0o640); err != nil {
		t.Fatal(err)
	}

	if err := WriteFileAtomic(path, []byte("new\n"), 0o644); err != nil {
		t.Fatalf("WriteFileAtomic: %v", err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := info.Mode().Perm(); got != 0o640 {
		t.Errorf("mode = %v, want the existing 0640", got)
	}
	if got := readString(t, path); got != "new\n" {
		t.Errorf("content = %q, want %q", got, "new\n")
	}
}

func TestWriteFileAtomicGivesANewFileTheDefaultMode(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "fresh.md")

	if err := WriteFileAtomic(path, []byte("hello\n"), 0o644); err != nil {
		t.Fatalf("WriteFileAtomic: %v", err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := info.Mode().Perm(); got != 0o644 {
		t.Errorf("mode = %v, want 0644 and not the 0600 os.CreateTemp gives", got)
	}
	assertOnlyEntries(t, dir, "fresh.md")
}

func TestWriteFileAtomicReplacesTheFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "note.md")
	if err := os.WriteFile(path, []byte("old\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	before, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}

	if err := WriteFileAtomic(path, []byte("new\n"), 0o644); err != nil {
		t.Fatalf("WriteFileAtomic: %v", err)
	}
	after, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if os.SameFile(before, after) {
		t.Error("the file kept its inode: it was written in place, not renamed over")
	}
	if got := readString(t, path); got != "new\n" {
		t.Errorf("content = %q, want %q", got, "new\n")
	}
	assertOnlyEntries(t, dir, "note.md")
}

func TestWriteFileAtomicLeavesTheOriginalWhenAStepFails(t *testing.T) {
	injected := errors.New("injected failure")
	cases := []struct {
		name   string
		inject func()
	}{
		{"write", func() {
			writeTemp = func(f *os.File, data []byte) (int, error) {
				// Half the bytes land before the failure, as on a full disk.
				n, _ := f.Write(data[:len(data)/2])
				return n, injected
			}
		}},
		{"rename", func() {
			renameTemp = func(string, string) error { return injected }
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			origWrite, origRename := writeTemp, renameTemp
			t.Cleanup(func() { writeTemp, renameTemp = origWrite, origRename })
			tc.inject()

			dir := t.TempDir()
			path := filepath.Join(dir, "note.md")
			if err := os.WriteFile(path, []byte("original bytes\n"), 0o644); err != nil {
				t.Fatal(err)
			}

			err := WriteFileAtomic(path, []byte("replacement bytes that never land\n"), 0o644)
			if !errors.Is(err, injected) {
				t.Fatalf("WriteFileAtomic error = %v, want the injected failure", err)
			}
			if got := readString(t, path); got != "original bytes\n" {
				t.Errorf("content = %q, want the original bytes untouched", got)
			}
			assertOnlyEntries(t, dir, "note.md")
		})
	}
}

func TestWriteFileAtomicWritesThroughASymlink(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "real.md")
	link := filepath.Join(dir, "link.md")
	if err := os.WriteFile(target, []byte("old\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, link); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}

	if err := WriteFileAtomic(link, []byte("new\n"), 0o644); err != nil {
		t.Fatalf("WriteFileAtomic: %v", err)
	}
	info, err := os.Lstat(link)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode()&fs.ModeSymlink == 0 {
		t.Error("the symlink was replaced by a regular file")
	}
	if got := readString(t, target); got != "new\n" {
		t.Errorf("target content = %q, want %q", got, "new\n")
	}
	assertOnlyEntries(t, dir, "real.md", "link.md")
}
