package api

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// vaultTrashDir is the vault's own trash, the folder where Obsidian keeps the
// notes it deletes. kernl threw deleted notes into the system trash through
// trash-go, which on every non-Windows system implements only the Linux
// FreeDesktop trash: on macOS it moves files to ~/.local/share/Trash, and a
// rename across volumes fails. A folder inside the vault stays on the vault's
// volume, and the indexer skips it as it skips every dot-directory.
const vaultTrashDir = ".trash"

// maxTrashSuffix bounds the search for a free name in the trash, so a trash
// that holds every candidate fails the delete instead of looping forever.
const maxTrashSuffix = 10000

// ErrInvalidDeleteTarget refuses a delete whose target is not a file the trash
// can take: a directory, or a path already in the vault's trash.
var ErrInvalidDeleteTarget = errors.New("not a note that can be moved to the vault trash")

// moveToVaultTrash moves fullPath, an absolute path below root, into root's
// trash under the same sub-path, and returns where it landed. It returns an
// error satisfying os.ErrNotExist when there is nothing at fullPath, and
// ErrInvalidDeleteTarget for a directory or a path already in the trash.
func moveToVaultTrash(root, fullPath string) (string, error) {
	absRoot, err := filepath.Abs(root)
	if err != nil {
		return "", err
	}
	rel, err := filepath.Rel(absRoot, fullPath)
	if err != nil {
		return "", err
	}
	if inVaultTrash(rel) {
		return "", fmt.Errorf("%w: %s is already in the vault trash", ErrInvalidDeleteTarget, filepath.ToSlash(rel))
	}
	// Lstat, so a symlink is moved as the link it is and its target is never touched.
	info, err := os.Lstat(fullPath)
	if err != nil {
		return "", err
	}
	if info.IsDir() {
		return "", fmt.Errorf("%w: %s is a directory", ErrInvalidDeleteTarget, filepath.ToSlash(rel))
	}

	dest := filepath.Join(absRoot, vaultTrashDir, rel)
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return "", err
	}
	dest, err = reserveTrashName(dest)
	if err != nil {
		return "", err
	}
	if err := os.Rename(fullPath, dest); err != nil {
		_ = os.Remove(dest)
		return "", err
	}
	return dest, nil
}

// inVaultTrash reports whether a vault-relative path is the trash or lies in
// it. The comparison ignores case because macOS volumes usually do, and there
// ".Trash/a.md" is the same file as ".trash/a.md".
func inVaultTrash(rel string) bool {
	first, _, _ := strings.Cut(filepath.ToSlash(rel), "/")
	return strings.EqualFold(first, vaultTrashDir)
}

// reserveTrashName claims a name for dest and returns it: dest itself when it
// is free, otherwise "<stem> N<ext>" for the first N that is, the form Obsidian
// gives a new note whose name is taken.
//
// The claim is an exclusive create of an empty placeholder, which the caller's
// rename then replaces. A rename silently replaces whatever sits at its
// destination, and in the trash that is a note already deleted once, so the
// name has to be taken atomically: a check followed by a rename would lose a
// file that another delete, or Obsidian, put there in between.
func reserveTrashName(dest string) (string, error) {
	dir, name := filepath.Split(dest)
	ext := filepath.Ext(name)
	stem := strings.TrimSuffix(name, ext)
	if stem == "" {
		stem, ext = name, ""
	}

	candidate := dest
	for n := 1; ; n++ {
		f, err := os.OpenFile(candidate, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
		if err == nil {
			if closeErr := f.Close(); closeErr != nil {
				_ = os.Remove(candidate)
				return "", closeErr
			}
			return candidate, nil
		}
		if !errors.Is(err, fs.ErrExist) {
			return "", err
		}
		if n > maxTrashSuffix {
			return "", fmt.Errorf("vault trash: no free name for %s after %d tries", name, maxTrashSuffix)
		}
		candidate = filepath.Join(dir, fmt.Sprintf("%s %d%s", stem, n, ext))
	}
}
