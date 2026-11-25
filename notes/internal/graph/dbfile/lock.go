// Package dbfile owns the exclusive advisory lock for the notes graph
// database, taken on an explicit database path.
//
// It ports kernl's internal/app/lock.go at commit 488fbbe, with the config
// replaced by the path itself: kernl resolves the path from its application
// container (graphDBFilePath), which this module does not take, and the
// caller hands the resolved database file instead. The directory is created
// first, because sqlite.Open does not create it and the default directory
// does not exist on a fresh machine.
package dbfile

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
)

// lockSuffix names the lock beside the database it guards rather than in
// a directory of its own: the two are one resource, and a lock a `rm` of the
// database leaves behind would outlive the thing it protects.
const lockSuffix = ".lock"

// GraphLockedError marks the one failure in this file that is not a
// malfunction - another process already owns this database - so a caller can
// tell contention apart from a broken lock without matching on message text.
//
// The embedded error carries the dispatch failure marker and the Fix:
// line. The two fields exist on top of that because the caller composes a
// multi-line hint from them, and re-parsing them out of the message would be
// worse. It is not a sentinel: errors.Is against a package-level value would
// say only THAT this process lost, and naming the other one is the point.
type GraphLockedError struct {
	error
	Path string // the resolved database, always set
	PID  int    // 0 when the lock file could not be read or parsed
}

// Acquire takes the exclusive advisory lock for the graph database at
// dbPath, so that only one notes service drives the database at a time.
//
// The returned release is idempotent. The kernel drops the lock when the
// process dies, so a crash or a SIGKILL never leaves a stale lock behind and
// there is nothing to time out or renew.
func Acquire(dbPath string) (func() error, error) {
	if strings.TrimSpace(dbPath) == "" {
		return nil, fmt.Errorf("KERNL DISPATCH FAILURE: graph database path is empty - Fix: set db or HOUSTON_DB to a file path")
	}
	// Create the database's directory first: sqlite.Open does not create
	// parent directories, and the default under the user's state directory
	// does not exist on a fresh machine.
	if err := os.MkdirAll(filepath.Dir(dbPath), 0o755); err != nil {
		return nil, fmt.Errorf("KERNL DISPATCH FAILURE: creating graph db dir %s: %w", filepath.Dir(dbPath), err)
	}
	lockPath := dbPath + lockSuffix

	// No O_CLOEXEC: os.OpenFile already ORs it in, so the lock is not
	// inherited by the agent CLIs this process spawns.
	f, err := os.OpenFile(lockPath, os.O_RDWR|os.O_CREATE, 0o644)
	if err != nil {
		return nil, fmt.Errorf("KERNL DISPATCH FAILURE: cannot open the graph database lock %s: %w - Fix: check the directory is writable", lockPath, err)
	}
	// A guard rather than a Close() on each failure path below, so a path
	// added later is covered by construction instead of by remembering.
	ok := false
	defer func() {
		if !ok {
			_ = f.Close()
		}
	}()

	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		if isLockContention(err) {
			return nil, newGraphLockedError(dbPath, readRecordedPID(f))
		}
		return nil, fmt.Errorf("KERNL DISPATCH FAILURE: cannot lock the graph database %s: %w - Fix: this is not contention; investigate the filesystem holding the lock file", dbPath, err)
	}

	if err := recordPID(f, os.Getpid()); err != nil {
		return nil, err
	}

	ok = true
	var once sync.Once
	var releaseErr error
	return func() error {
		once.Do(func() {
			// Unlock before closing so the release is explicit in a trace,
			// though closing the descriptor would drop the lock anyway.
			releaseErr = syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
			if err := f.Close(); releaseErr == nil {
				releaseErr = err
			}
		})
		return releaseErr
	}, nil
}

// isLockContention separates "someone else owns this" from a real failure.
// Both errnos are checked because they are the same value on Linux and are
// not guaranteed to be on every Unix, and darwin is a release target. Any
// other errno is a malfunction and must surface as one - reporting it as
// contention would tell the operator to go stop a process that does not
// exist.
func isLockContention(err error) bool {
	return errors.Is(err, syscall.EWOULDBLOCK) || errors.Is(err, syscall.EAGAIN)
}

// recordPID writes this process's pid into the already-locked file. The
// content is diagnostics only - the lock is the flock, never the bytes - so
// this is written after acquiring rather than as part of acquiring, and a
// stale pid in a stale file is harmless. The file is truncated in place and
// never replaced by rename, which would change the inode being locked and
// hand the lock to nobody.
func recordPID(f *os.File, pid int) error {
	if err := f.Truncate(0); err != nil {
		return fmt.Errorf("KERNL DISPATCH FAILURE: cannot truncate the graph database lock %s: %w", f.Name(), err)
	}
	if _, err := f.WriteAt([]byte(strconv.Itoa(pid)+"\n"), 0); err != nil {
		return fmt.Errorf("KERNL DISPATCH FAILURE: cannot record the pid in the graph database lock %s: %w", f.Name(), err)
	}
	return f.Sync()
}

// readRecordedPID reports the pid the lock file last recorded, or 0 when it
// cannot be read or parsed.
//
// Best-effort in two distinct ways, and both are why the caller must never
// present this as "the owner is pid N". The owner truncates AFTER it
// acquires, so a contender can catch the file empty or half-written. And even
// a clean read is only the last pid RECORDED: the owner can exit and a third
// process can take the lock and rewrite the file between the flock that
// failed and this read. Nothing closes that window and nothing needs to - the
// refusal is already correct, and the pid is a thread to pull.
func readRecordedPID(f *os.File) int {
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return 0
	}
	raw, err := io.ReadAll(f)
	if err != nil {
		return 0
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(raw)))
	if err != nil || pid <= 0 {
		return 0
	}
	return pid
}

func newGraphLockedError(dbPath string, pid int) GraphLockedError {
	recorded := ""
	if pid > 0 {
		recorded = fmt.Sprintf(" (recorded pid %d)", pid)
	}
	return GraphLockedError{
		error: fmt.Errorf("KERNL DISPATCH FAILURE: graph database %s is already owned by another houston serve%s - Fix: stop it, or point db or HOUSTON_DB at another file", dbPath, recorded),
		Path:  dbPath,
		PID:   pid,
	}
}
