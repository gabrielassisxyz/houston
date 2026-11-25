package dbfile

import (
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
)

func tempDBPath(t *testing.T) string {
	t.Helper()
	return filepath.Join(t.TempDir(), "notes.db")
}

func TestAcquireSucceedsOnAFreeDatabase(t *testing.T) {
	dbPath := tempDBPath(t)

	release, err := Acquire(dbPath)
	if err != nil {
		t.Fatalf("Acquire on a free database: %v", err)
	}
	t.Cleanup(func() { _ = release() })

	lockPath := dbPath + lockSuffix
	raw, err := os.ReadFile(lockPath)
	if err != nil {
		t.Fatalf("read lock file: %v", err)
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(raw)))
	if err != nil {
		t.Fatalf("lock file should hold a pid, got %q: %v", raw, err)
	}
	if pid != os.Getpid() {
		t.Errorf("lock file records pid %d, want this process %d", pid, os.Getpid())
	}
}

func TestAcquireSecondLockRefusedWithGraphLockedError(t *testing.T) {
	dbPath := tempDBPath(t)

	release, err := Acquire(dbPath)
	if err != nil {
		t.Fatalf("first Acquire: %v", err)
	}
	t.Cleanup(func() { _ = release() })

	_, err = Acquire(dbPath)
	if err == nil {
		t.Fatal("second Acquire must fail while the first holds the lock")
	}
	var locked GraphLockedError
	if !errors.As(err, &locked) {
		t.Fatalf("second Acquire must return GraphLockedError, got %T: %v", err, err)
	}
	if locked.Path != dbPath {
		t.Errorf("contested database must be carried, got %q want %q", locked.Path, dbPath)
	}
	if !strings.Contains(err.Error(), "houston serve") {
		t.Errorf("contention message must name houston serve, got %q", err.Error())
	}
}

func TestAcquireReleaseIsIdempotent(t *testing.T) {
	release, err := Acquire(tempDBPath(t))
	if err != nil {
		t.Fatalf("Acquire: %v", err)
	}

	if err := release(); err != nil {
		t.Fatalf("first release: %v", err)
	}
	// A second call must be a no-op rather than an unlock of whatever
	// descriptor number was reused in between.
	if err := release(); err != nil {
		t.Fatalf("second release must be a no-op, got: %v", err)
	}
}

func TestAcquireReleaseAllowsReacquire(t *testing.T) {
	dbPath := tempDBPath(t)

	release, err := Acquire(dbPath)
	if err != nil {
		t.Fatalf("first Acquire: %v", err)
	}
	if err := release(); err != nil {
		t.Fatalf("release: %v", err)
	}

	release2, err := Acquire(dbPath)
	if err != nil {
		t.Fatalf("reacquire after release: %v", err)
	}
	t.Cleanup(func() { _ = release2() })
}

func TestAcquireCreatesMissingParentDirectory(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "nested", "deep", "notes.db")

	release, err := Acquire(dbPath)
	if err != nil {
		t.Fatalf("Acquire with a missing parent directory: %v", err)
	}
	t.Cleanup(func() { _ = release() })

	if info, err := os.Stat(filepath.Dir(dbPath)); err != nil || !info.IsDir() {
		t.Fatalf("database directory was not created: %v", err)
	}
	if _, err := os.Stat(dbPath + lockSuffix); err != nil {
		t.Fatalf("lock file was not created: %v", err)
	}
}

func TestAcquireContentionNamesHoustonServe(t *testing.T) {
	dbPath := tempDBPath(t)

	release, err := Acquire(dbPath)
	if err != nil {
		t.Fatalf("first Acquire: %v", err)
	}
	t.Cleanup(func() { _ = release() })

	_, err = Acquire(dbPath)
	if err == nil {
		t.Fatal("second Acquire must fail")
	}
	msg := err.Error()
	if !strings.Contains(msg, "houston serve") {
		t.Errorf("contention must name houston serve, got %q", msg)
	}
	if strings.Contains(msg, "kernl serve") {
		t.Errorf("contention must not name kernl serve, got %q", msg)
	}
	if !strings.Contains(msg, "HOUSTON_DB") {
		t.Errorf("contention fix must point at db or HOUSTON_DB, got %q", msg)
	}
}

func TestAcquireReportsARealErrorRatherThanContention(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("running as root bypasses the directory permission this test relies on")
	}
	dir := t.TempDir()
	if err := os.Chmod(dir, 0o555); err != nil {
		t.Fatalf("chmod vault root: %v", err)
	}
	t.Cleanup(func() { _ = os.Chmod(dir, 0o755) })

	_, err := Acquire(filepath.Join(dir, "sub", "notes.db"))
	if err == nil {
		t.Fatal("Acquire must fail when it cannot create the lock file")
	}
	var locked GraphLockedError
	if errors.As(err, &locked) {
		t.Fatalf("an unwritable directory is a malfunction, not contention; got %v", err)
	}
	if !strings.Contains(err.Error(), "KERNL DISPATCH FAILURE") {
		t.Errorf("error must carry the dispatch-failure marker, got %q", err.Error())
	}
}

func TestIsLockContentionAcceptsBothErrnosAndNothingElse(t *testing.T) {
	// EWOULDBLOCK and EAGAIN are the same value on Linux and are not
	// guaranteed to be on every Unix; darwin is a release target, so both
	// are named. Anything else must stay a malfunction: telling the operator
	// to go stop a process that does not exist is worse than the raw errno.
	for _, errno := range []syscall.Errno{syscall.EWOULDBLOCK, syscall.EAGAIN} {
		if !isLockContention(errno) {
			t.Errorf("errno %v must count as contention", errno)
		}
	}
	for _, errno := range []syscall.Errno{syscall.EACCES, syscall.ENOSPC, syscall.EIO} {
		if isLockContention(errno) {
			t.Errorf("errno %v is a malfunction, not contention", errno)
		}
	}
}

func TestReadRecordedPIDTreatsUnusableContentAsAbsent(t *testing.T) {
	// Every one of these is reachable in practice: the owner truncates the
	// file AFTER it acquires the lock, so a contender can read it empty or
	// half-written. None may fail the refusal - a missing pid degrades the
	// message, it does not turn a correct refusal into an error.
	for name, content := range map[string]string{
		"empty":      "",
		"whitespace": "  \n",
		"garbage":    "not-a-pid\n",
		"negative":   "-1\n",
		"zero":       "0\n",
		"truncated":  "",
	} {
		t.Run(name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "graph.lock")
			if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
				t.Fatalf("write lock file: %v", err)
			}
			f, err := os.Open(path)
			if err != nil {
				t.Fatalf("open lock file: %v", err)
			}
			defer f.Close()

			if pid := readRecordedPID(f); pid != 0 {
				t.Errorf("content %q should read as no pid, got %d", content, pid)
			}
		})
	}
}

func TestGraphLockedErrorNamesThePIDOnlyWhenItIsKnown(t *testing.T) {
	withPID := newGraphLockedError("/tmp/org/repo-a/notes.db", 4242)
	if !strings.Contains(withPID.Error(), "recorded pid 4242") {
		t.Errorf("a known pid must appear as recorded, got %q", withPID)
	}

	withoutPID := newGraphLockedError("/tmp/org/repo-a/notes.db", 0)
	if strings.Contains(withoutPID.Error(), "pid") {
		t.Errorf("an unknown pid must not be mentioned at all, got %q", withoutPID)
	}

	for _, err := range []GraphLockedError{withPID, withoutPID} {
		if err.Path != "/tmp/org/repo-a/notes.db" {
			t.Errorf("the contested database must always be carried, got %q", err.Path)
		}
		if !strings.Contains(err.Error(), "KERNL DISPATCH FAILURE") {
			t.Errorf("missing the dispatch-failure marker in %q", err.Error())
		}
		if !strings.Contains(err.Error(), "Fix:") {
			t.Errorf("missing the actionable fix in %q", err.Error())
		}
		if !strings.Contains(err.Error(), "houston serve") {
			t.Errorf("contention must name houston serve in %q", err.Error())
		}
	}
}
