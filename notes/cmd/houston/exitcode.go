package main

import (
	"errors"
	"fmt"
	"strings"
)

// Exit-code dictionary - the CLI's contract with scripts and agents:
//
//	0  success
//	1  runtime/internal error (backend, config load, network, agent run)
//	2  usage error (unknown verb/flag, missing argument, bad value, or a
//	   destructive invocation refused for want of --yes)
//
// Callers can branch on `case $? in 2) fix the invocation;; 1) retry/inspect;;`.
type usageError struct{ err error }

func (u usageError) Error() string { return u.err.Error() }
func (u usageError) Unwrap() error { return u.err }

// usagef builds an error that exits with code 2 (usage) instead of 1.
func usagef(format string, a ...any) error {
	return usageError{err: fmt.Errorf(format, a...)}
}

// alreadyReported marks an error whose output the verb has already written - e.g.
// `preflight --json` prints its own report to stdout and then signals failure only
// through the exit code. main uses the exit code but prints nothing more, so the
// output is not duplicated by the stderr path. The wrapped error
// still drives exitCode (usage vs runtime) through Unwrap.
type alreadyReported struct{ err error }

func (a alreadyReported) Error() string { return a.err.Error() }
func (a alreadyReported) Unwrap() error { return a.err }

// reportedElsewhere wraps an error the verb has already surfaced itself.
func reportedElsewhere(err error) error { return alreadyReported{err: err} }

// refusedWithoutYes ends a destructive invocation that previewed instead of
// acting. The verb has already written the preview - prose or JSON - so this
// contributes only the exit code.
//
// WHY exit 2 and not 0. The caller asked for a mutation and did not get one.
// Exit 0 states that the command succeeded, which is how an agent branching on
// `$?` concludes the delete happened and moves on; the refusal is visible only
// to something that reads prose. Exit 2 is the same answer the CLI already
// gives any other incomplete invocation.
func refusedWithoutYes(verb string) error {
	return reportedElsewhere(usagef(
		"houston: %s refused: nothing was changed - re-run with --yes to confirm", verb))
}

// wrapLoud prefixes context onto an error, adding the houston marker
// only when the wrapped error does not already carry it - the marker
// must appear exactly once per error chain.
func wrapLoud(context string, err error) error {
	if strings.Contains(err.Error(), "houston:") {
		return fmt.Errorf("%s: %w", context, err)
	}
	return fmt.Errorf("houston: %s: %w", context, err)
}

func exitCode(err error) int {
	if err == nil {
		return 0
	}
	var u usageError
	if errors.As(err, &u) {
		return 2
	}
	return 1
}
