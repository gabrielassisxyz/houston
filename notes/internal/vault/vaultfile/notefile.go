package vaultfile

import (
	"errors"
	"fmt"
	"path/filepath"
	"strings"
)

// noteExt is the extension of a note. It is compared without regard to case:
// Obsidian and the sync clients take Note.MD for a note, and a vault read with
// two different rules would index such a file in one place and delete it in
// another - the watcher indexing it live, the next cold start sweeping it away.
const noteExt = ".md"

// IsNoteFile reports whether path names a note, by its extension and without
// regard to case. Every site that asks that question asks it here.
func IsNoteFile(path string) bool {
	return strings.EqualFold(filepath.Ext(path), noteExt)
}

// TrimNoteExt strips one trailing note extension, without regard to case.
func TrimNoteExt(s string) string {
	if len(s) >= len(noteExt) && strings.EqualFold(s[len(s)-len(noteExt):], noteExt) {
		return s[:len(s)-len(noteExt)]
	}
	return s
}

// ErrOutsideVault refuses a path that does not lie under the vault root. Its
// relative form starts with "..", which a dot-component check would otherwise
// take for a hidden entry and skip in silence.
var ErrOutsideVault = errors.New("path is outside the vault")

// VaultRel returns path relative to root, or ErrOutsideVault when it is not
// under it. The root itself is ".".
func VaultRel(root, path string) (string, error) {
	rel, err := filepath.Rel(root, path)
	if err != nil {
		return "", fmt.Errorf("%w: %s", ErrOutsideVault, path)
	}
	if rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("%w: %s", ErrOutsideVault, path)
	}
	return rel, nil
}

// IsHiddenRel reports whether a vault-relative path is a dot-file or lies in a
// dot-directory, such as .obsidian or .trash. Only the components below the
// root count, so a vault kept under a dot-named directory is not hidden whole.
// rel must come from VaultRel: a path outside the root is refused there.
func IsHiddenRel(rel string) bool {
	if rel == "" || rel == "." {
		return false
	}
	for _, part := range strings.Split(filepath.ToSlash(rel), "/") {
		if strings.HasPrefix(part, ".") {
			return true
		}
	}
	return false
}
