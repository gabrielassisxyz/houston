// Package config holds the small local configuration for the notes service.
//
// It replaces kernl's internal/config (whose config.go alone is 504 lines of
// agent, orchestrator, inbox and planning settings) which internal/vault
// imports only for VaultConfig. ServerConfig and VaultConfig below are copied
// as they are from kernl at commit 488fbbe, with expandHomePath alongside
// them; A2 adds the loader beside them.
package config

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

type ServerConfig struct {
	Port int `yaml:"port"`
	// Host is the interface to bind. It defaults to loopback: the API has no
	// authentication, so binding every interface would offer the vault and the
	// orchestrator to anything that can reach the machine. Set it to 0.0.0.0
	// deliberately (a container, a trusted LAN), never by accident.
	Host string `yaml:"host,omitempty"`
}

// VaultConfig holds settings for the notes vault watcher.
type VaultConfig struct {
	// Root is the absolute path to the vault directory.
	// When empty, vault watching is disabled.
	Root string `yaml:"root"`
	// CoalesceWindowMs is the fsnotify quiet period before emitting an event (ms).
	// Default: 300.
	CoalesceWindowMs int `yaml:"coalesceWindowMs,omitempty"`
	// MoveWindowMs is the move/delete correlation window (ms).
	// Default: 1000.
	MoveWindowMs int `yaml:"moveWindowMs,omitempty"`
	// RescanIntervalSec, when >0, triggers a periodic cold-start diff as a
	// safety net for missed fsnotify events. Default: 0 (disabled).
	RescanIntervalSec int `yaml:"rescanIntervalSec,omitempty"`
}

// Enabled reports whether vault watching is configured (root is non-empty).
func (v VaultConfig) Enabled() bool { return v.Root != "" }

// expandHomePath expands a leading ~ or ~/ (or ~\) in a path to the user's home directory.
//
// WHY exclusion of ~user: Username expansion (~otheruser/...) is deliberately not
// supported to avoid user lookup dependencies and security surprises across environments.
// Paths starting with ~ followed by non-separator characters (other than ~ alone)
// fail loud with KERNL DISPATCH FAILURE.
//
// WHY exclusion of symlink/existence checks: Resolving symlinks or non-existent paths
// is deliberately out of scope at config load time. Config loading only normalizes path
// representations (~ expansion); filesystem validity is checked downstream by domain
// components (git, beads, etc.) that consume the path.
func expandHomePath(p string) (string, error) {
	if p == "" {
		return "", nil
	}
	if p == "~" {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", fmt.Errorf("KERNL DISPATCH FAILURE: cannot resolve home dir to expand path %q: %w", p, err)
		}
		return home, nil
	}
	if strings.HasPrefix(p, "~/") || strings.HasPrefix(p, "~\\") {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", fmt.Errorf("KERNL DISPATCH FAILURE: cannot resolve home dir to expand path %q: %w", p, err)
		}
		return filepath.Join(home, p[2:]), nil
	}
	if strings.HasPrefix(p, "~") {
		return "", fmt.Errorf("KERNL DISPATCH FAILURE: user-specific tilde expansion (%q) is not supported; use an explicit path", p)
	}
	return p, nil
}

// expandHomePaths expands tilde paths in place for the given string pointers using expandHomePath.
func expandHomePaths(paths ...*string) error {
	for _, p := range paths {
		expanded, err := expandHomePath(*p)
		if err != nil {
			return err
		}
		*p = expanded
	}
	return nil
}
