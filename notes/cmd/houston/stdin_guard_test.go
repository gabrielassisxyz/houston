package main

import (
	"strings"
	"testing"
)

// Reading a note body from stdin when stdin is a terminal used to block
// forever on io.ReadAll with no prompt. The guard turns that deadlock into a
// fast exit-2 usage error. The stdinIsTerminal seam is overridden so the
// terminal branch is exercised without a pty.
func withTerminalStdin(t *testing.T) {
	t.Helper()
	orig := stdinIsTerminal
	stdinIsTerminal = func() bool { return true }
	t.Cleanup(func() { stdinIsTerminal = orig })
}

func TestNoteBodyFromTerminalStdinFailsFast(t *testing.T) {
	withTerminalStdin(t)
	// No --file source, stdin is a terminal → must not reach io.ReadAll.
	_, err := readNoteBody("write", "--file", "", false)
	if err == nil {
		t.Fatal("expected a usage error when stdin is a terminal, got nil")
	}
	if code := exitCode(err); code != 2 {
		t.Errorf("terminal-stdin guard must be a usage error (exit 2), got %d: %v", code, err)
	}
	if !strings.Contains(err.Error(), "terminal") {
		t.Errorf("error should explain stdin is a terminal, got: %v", err)
	}
}
