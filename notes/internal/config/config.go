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
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"
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
// fail loud.
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
			return "", fmt.Errorf("cannot resolve home dir to expand path %q: %w", p, err)
		}
		return home, nil
	}
	if strings.HasPrefix(p, "~/") || strings.HasPrefix(p, "~\\") {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", fmt.Errorf("cannot resolve home dir to expand path %q: %w", p, err)
		}
		return filepath.Join(home, p[2:]), nil
	}
	if strings.HasPrefix(p, "~") {
		return "", fmt.Errorf("user-specific tilde expansion (%q) is not supported; use an explicit path", p)
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

const (
	defaultNotesHost = "127.0.0.1"
	defaultNotesPort = 3301
)

// NotesConfig is the small configuration the notes service reads: the two
// sections it needs plus the database path. Every other key in the file is
// ignored, so a file with unrelated sections still loads.
type NotesConfig struct {
	Vault  VaultConfig  `yaml:"vault"`
	Server ServerConfig `yaml:"server"`
	// DBPath is the graph database file, from the YAML key db.
	DBPath string `yaml:"db"`
}

// defaultDBPath resolves the database default outside the vault: under the
// user's state directory. A relative XDG_STATE_HOME is ignored, as the XDG
// specification says, so the database never lands in the working directory.
func defaultDBPath() (string, error) {
	if v := strings.TrimSpace(os.Getenv("XDG_STATE_HOME")); v != "" && filepath.IsAbs(v) {
		return filepath.Join(v, "houston", "notes.db"), nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("cannot resolve home dir for notes database default: %w", err)
	}
	return filepath.Join(home, ".local", "state", "houston", "notes.db"), nil
}

// LoadNotes reads the notes config at path, applying defaults then
// environment overrides, then home expansion and absolutization.
//
// A missing file starts from zero values; a file that exists and does not
// parse is an error. Vault watcher defaults are not applied here: the caller
// runs vault.ApplyDefaults, as kernl's serve does, to avoid an import cycle.
func LoadNotes(path string) (*NotesConfig, error) {
	var cfg NotesConfig
	if path != "" {
		data, err := os.ReadFile(path)
		if err != nil {
			if !os.IsNotExist(err) {
				return nil, fmt.Errorf("reading config %s: %w", path, err)
			}
			// Missing: start from zero values.
		} else {
			var file NotesConfig
			if err := yaml.Unmarshal(data, &file); err != nil {
				return nil, fmt.Errorf("parsing config %s: %w", path, err)
			}
			cfg = file
		}
	}

	cfg.Server.Host = strings.TrimSpace(cfg.Server.Host)
	cfg.Vault.Root = strings.TrimSpace(cfg.Vault.Root)
	cfg.DBPath = strings.TrimSpace(cfg.DBPath)

	if cfg.Server.Host == "" {
		cfg.Server.Host = defaultNotesHost
	}
	if cfg.Server.Port == 0 {
		cfg.Server.Port = defaultNotesPort
	}
	if cfg.DBPath == "" {
		def, err := defaultDBPath()
		if err != nil {
			return nil, err
		}
		cfg.DBPath = def
	}

	if v := strings.TrimSpace(os.Getenv("HOUSTON_VAULT")); v != "" {
		cfg.Vault.Root = v
	}
	if v := strings.TrimSpace(os.Getenv("HOUSTON_DB")); v != "" {
		cfg.DBPath = v
	}
	if v := strings.TrimSpace(os.Getenv("HOUSTON_ADDR")); v != "" {
		if strings.Contains(v, "://") {
			return nil, fmt.Errorf("HOUSTON_ADDR %q must be host:port without a scheme - Fix: drop the scheme (for example 127.0.0.1:3301); HOUSTON_HUB_URL takes a URL, HOUSTON_ADDR does not", v)
		}
		host, portStr, err := net.SplitHostPort(v)
		if err != nil {
			return nil, fmt.Errorf("HOUSTON_ADDR %q must be host:port: %w", v, err)
		}
		host = strings.TrimSpace(host)
		if host == "" {
			return nil, fmt.Errorf("HOUSTON_ADDR %q must name a host - Fix: use host:port, for example 127.0.0.1:3301", v)
		}
		port, err := strconv.Atoi(strings.TrimSpace(portStr))
		if err != nil || port < 1 || port > 65535 {
			return nil, fmt.Errorf("HOUSTON_ADDR %q must name a port between 1 and 65535: %w", v, err)
		}
		cfg.Server.Host = host
		cfg.Server.Port = port
	}

	if err := expandHomePaths(&cfg.Vault.Root, &cfg.DBPath); err != nil {
		return nil, err
	}
	// Never absolutize an empty path: filepath.Abs("") returns the working
	// directory, which would turn "disabled" into "somewhere".
	if cfg.Vault.Root != "" {
		abs, err := filepath.Abs(cfg.Vault.Root)
		if err != nil {
			return nil, fmt.Errorf("resolving vault.root %q: %w", cfg.Vault.Root, err)
		}
		cfg.Vault.Root = abs
	}
	if cfg.DBPath != "" {
		abs, err := filepath.Abs(cfg.DBPath)
		if err != nil {
			return nil, fmt.Errorf("resolving db %q: %w", cfg.DBPath, err)
		}
		cfg.DBPath = abs
	}

	return &cfg, nil
}

// ValidateForServe refuses anything that must never serve: a non-loopback
// bind, an empty vault, or a database inside the vault. Client verbs only
// need the address, so they do not call this.
func (c *NotesConfig) ValidateForServe() error {
	host := strings.TrimSpace(c.Server.Host)
	if host != "127.0.0.1" && host != "::1" && host != "localhost" {
		return fmt.Errorf("server.host %q must be loopback (127.0.0.1, ::1 or localhost) - Fix: bind loopback, never a network interface", c.Server.Host)
	}
	if c.Server.Port < 1 || c.Server.Port > 65535 {
		return fmt.Errorf("server.port %d must be between 1 and 65535", c.Server.Port)
	}
	if strings.TrimSpace(c.Vault.Root) == "" {
		return fmt.Errorf("vault.root is empty - Fix: set vault.root or HOUSTON_VAULT to the vault directory")
	}
	if strings.TrimSpace(c.DBPath) == "" {
		return fmt.Errorf("db is empty - Fix: set db or HOUSTON_DB to a database file outside the vault")
	}
	vaultAbs, err := filepath.Abs(c.Vault.Root)
	if err != nil {
		return fmt.Errorf("resolving vault.root %q: %w", c.Vault.Root, err)
	}
	dbAbs, err := filepath.Abs(c.DBPath)
	if err != nil {
		return fmt.Errorf("resolving db %q: %w", c.DBPath, err)
	}
	rel, err := filepath.Rel(vaultAbs, dbAbs)
	if err != nil {
		return fmt.Errorf("comparing db %q to vault.root %q: %w", c.DBPath, c.Vault.Root, err)
	}
	// Never a string prefix: /vault-db beside /vault relates as
	// ../vault-db and is fine.
	if rel == "." || (rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel)) {
		return fmt.Errorf("db %q must not live inside vault.root %q - Fix: keep the live database outside the synced vault, for example under ${XDG_STATE_HOME:-~/.local/state}/houston/notes.db", c.DBPath, c.Vault.Root)
	}
	return nil
}
