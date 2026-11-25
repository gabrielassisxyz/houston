package vaultfile

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
)

// tempPattern names the file a write goes through. It is a dot-file that does
// not end in .md, so neither the watcher, the index, Obsidian nor a sync
// client takes it for a note during the moment it exists.
const tempPattern = ".houston-tmp-*"

// The steps a test needs to make fail. Production never reassigns them.
var (
	writeTemp  = func(f *os.File, data []byte) (int, error) { return f.Write(data) }
	syncTemp   = (*os.File).Sync
	closeTemp  = (*os.File).Close
	renameTemp = os.Rename
)

// WriteFileAtomic replaces the file at path with data so that a reader, or a
// crash, sees either the old bytes or the new ones and never a mix.
//
// The bytes go to a temporary file in the same directory, which is given the
// existing file's permissions, or defaultMode for a new file, then written,
// synced and closed, and finally renamed over path. On any failure the
// temporary file is removed and path is left as it was.
//
// A symlink at path is followed, as os.WriteFile follows it: the rename lands
// on the file it points to, and the link stays a link.
func WriteFileAtomic(path string, data []byte, defaultMode fs.FileMode) (err error) {
	target, err := resolveLink(path)
	if err != nil {
		return err
	}
	mode, err := modeFor(target, defaultMode)
	if err != nil {
		return err
	}

	tmp, err := os.CreateTemp(filepath.Dir(target), tempPattern)
	if err != nil {
		return fmt.Errorf("vaultfile: create temporary file for %q: %w", path, err)
	}
	tmpName := tmp.Name()
	defer func() {
		if err != nil {
			_ = tmp.Close()
			_ = os.Remove(tmpName)
		}
	}()

	// os.CreateTemp creates the file 0600, which would quietly make every
	// note the service touches unreadable to anyone else.
	if err = tmp.Chmod(mode); err != nil {
		return fmt.Errorf("vaultfile: set mode of %q: %w", tmpName, err)
	}
	if _, err = writeTemp(tmp, data); err != nil {
		return fmt.Errorf("vaultfile: write %q: %w", tmpName, err)
	}
	if err = syncTemp(tmp); err != nil {
		return fmt.Errorf("vaultfile: sync %q: %w", tmpName, err)
	}
	// A failed close can be the first report of a failed write, so its error
	// counts as one.
	if err = closeTemp(tmp); err != nil {
		return fmt.Errorf("vaultfile: close %q: %w", tmpName, err)
	}
	if err = renameTemp(tmpName, target); err != nil {
		return fmt.Errorf("vaultfile: rename %q over %q: %w", tmpName, target, err)
	}
	return nil
}

// resolveLink returns the file a symlink at path points to, or path itself
// when it is not a symlink or does not exist yet.
func resolveLink(path string) (string, error) {
	info, err := os.Lstat(path)
	if errors.Is(err, fs.ErrNotExist) {
		return path, nil
	}
	if err != nil {
		return "", fmt.Errorf("vaultfile: stat %q: %w", path, err)
	}
	if info.Mode()&fs.ModeSymlink == 0 {
		return path, nil
	}
	target, err := filepath.EvalSymlinks(path)
	if err != nil {
		return "", fmt.Errorf("vaultfile: resolve symlink %q: %w", path, err)
	}
	return target, nil
}

// modeFor returns the permissions the file at path already has, or
// defaultMode when there is no file there yet.
func modeFor(path string, defaultMode fs.FileMode) (fs.FileMode, error) {
	info, err := os.Stat(path)
	if errors.Is(err, fs.ErrNotExist) {
		return defaultMode.Perm(), nil
	}
	if err != nil {
		return 0, fmt.Errorf("vaultfile: stat %q: %w", path, err)
	}
	return info.Mode().Perm(), nil
}
