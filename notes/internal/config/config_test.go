package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeFile(t *testing.T, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "notes.yaml")
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("write config file: %v", err)
	}
	return path
}

func clearConfigEnv(t *testing.T) {
	t.Helper()
	t.Setenv("HOUSTON_VAULT", "")
	t.Setenv("HOUSTON_DB", "")
	t.Setenv("HOUSTON_ADDR", "")
	t.Setenv("XDG_STATE_HOME", "")
}

func TestLoadNotesMissingFileStartsFromDefaults(t *testing.T) {
	clearConfigEnv(t)
	home := t.TempDir()
	t.Setenv("HOME", home)

	cfg, err := LoadNotes(filepath.Join(t.TempDir(), "does-not-exist.yaml"))
	if err != nil {
		t.Fatalf("missing file must start from zero values: %v", err)
	}
	if cfg.Server.Host != "127.0.0.1" {
		t.Errorf("default host = %q, want 127.0.0.1", cfg.Server.Host)
	}
	if cfg.Server.Port != 3301 {
		t.Errorf("default port = %d, want 3301", cfg.Server.Port)
	}
	wantDB := filepath.Join(home, ".local", "state", "houston", "notes.db")
	if cfg.DBPath != wantDB {
		t.Errorf("default db = %q, want %q", cfg.DBPath, wantDB)
	}
	if !filepath.IsAbs(cfg.DBPath) {
		t.Errorf("default db must be absolute, got %q", cfg.DBPath)
	}
	if cfg.Vault.Root != "" {
		t.Errorf("missing file leaves vault root empty, got %q", cfg.Vault.Root)
	}
}

func TestLoadNotesMalformedFileIsAnError(t *testing.T) {
	clearConfigEnv(t)
	path := writeFile(t, "vault: [unclosed\n  bad: : :\n")
	if _, err := LoadNotes(path); err == nil {
		t.Fatal("malformed file must be an error")
	}
}

func TestLoadNotesIgnoresUnknownSections(t *testing.T) {
	clearConfigEnv(t)
	vault := t.TempDir()
	path := writeFile(t, "settings:\n  agents:\n    main:\n      command: agent\nvault:\n  root: "+vault+"\nserver:\n  host: 127.0.0.1\n  port: 3301\ndb: "+filepath.Join(t.TempDir(), "notes.db")+"\n")
	cfg, err := LoadNotes(path)
	if err != nil {
		t.Fatalf("file with unknown sections must still load: %v", err)
	}
	if cfg.Vault.Root != vault {
		t.Errorf("vault.root = %q, want %q", cfg.Vault.Root, vault)
	}
}

func TestLoadNotesSourcesAndOverrides(t *testing.T) {
	vaultFile := t.TempDir()
	dbFile := filepath.Join(t.TempDir(), "file.db")
	path := writeFile(t, "vault:\n  root: "+vaultFile+"\nserver:\n  host: 127.0.0.1\n  port: 3301\ndb: "+dbFile+"\n")

	tests := []struct {
		name      string
		envVault  string
		envDB     string
		envAddr   string
		wantVault string
		wantDB    string
		wantHost  string
		wantPort  int
	}{
		{"file values used with no overrides", "", "", "", vaultFile, dbFile, "127.0.0.1", 3301},
		{"HOUSTON_VAULT overrides the file", filepath.Join(t.TempDir(), "env-vault"), "", "", filepath.Join("", ""), "", "", 0},
		{"HOUSTON_DB overrides the file", "", filepath.Join(t.TempDir(), "env.db"), "", "", "", "", 0},
		{"HOUSTON_ADDR overrides host and port", "", "", "127.0.0.1:4401", "", "", "127.0.0.1", 4401},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			clearConfigEnv(t)
			if tc.envVault != "" {
				t.Setenv("HOUSTON_VAULT", tc.envVault)
			}
			if tc.envDB != "" {
				t.Setenv("HOUSTON_DB", tc.envDB)
			}
			if tc.envAddr != "" {
				t.Setenv("HOUSTON_ADDR", tc.envAddr)
			}
			cfg, err := LoadNotes(path)
			if err != nil {
				t.Fatalf("LoadNotes: %v", err)
			}
			switch tc.name {
			case "file values used with no overrides":
				if cfg.Vault.Root != tc.wantVault {
					t.Errorf("vault.root = %q, want %q", cfg.Vault.Root, tc.wantVault)
				}
				if cfg.DBPath != tc.wantDB {
					t.Errorf("db = %q, want %q", cfg.DBPath, tc.wantDB)
				}
			case "HOUSTON_VAULT overrides the file":
				want, _ := filepath.Abs(tc.envVault)
				if cfg.Vault.Root != want {
					t.Errorf("vault.root = %q, want %q", cfg.Vault.Root, want)
				}
			case "HOUSTON_DB overrides the file":
				want, _ := filepath.Abs(tc.envDB)
				if cfg.DBPath != want {
					t.Errorf("db = %q, want %q", cfg.DBPath, want)
				}
			case "HOUSTON_ADDR overrides host and port":
				if cfg.Server.Host != tc.wantHost || cfg.Server.Port != tc.wantPort {
					t.Errorf("server = %s:%d, want %s:%d", cfg.Server.Host, cfg.Server.Port, tc.wantHost, tc.wantPort)
				}
			}
		})
	}
}

func TestLoadNotesHomeExpansion(t *testing.T) {
	t.Run("tilde from the file expands", func(t *testing.T) {
		clearConfigEnv(t)
		home := t.TempDir()
		t.Setenv("HOME", home)
		path := writeFile(t, "vault:\n  root: ~/vault\nserver:\n  host: 127.0.0.1\n  port: 3301\ndb: ~/notes.db\n")
		cfg, err := LoadNotes(path)
		if err != nil {
			t.Fatalf("LoadNotes: %v", err)
		}
		if cfg.Vault.Root != filepath.Join(home, "vault") {
			t.Errorf("vault.root = %q, want %q", cfg.Vault.Root, filepath.Join(home, "vault"))
		}
		if cfg.DBPath != filepath.Join(home, "notes.db") {
			t.Errorf("db = %q, want %q", cfg.DBPath, filepath.Join(home, "notes.db"))
		}
	})

	t.Run("tilde from HOUSTON_VAULT expands", func(t *testing.T) {
		clearConfigEnv(t)
		home := t.TempDir()
		t.Setenv("HOME", home)
		path := writeFile(t, "vault:\n  root: /tmp/org/repo-a/vault\nserver:\n  host: 127.0.0.1\n  port: 3301\ndb: /tmp/org/repo-a/notes.db\n")
		t.Setenv("HOUSTON_VAULT", "~/vault-from-env")
		cfg, err := LoadNotes(path)
		if err != nil {
			t.Fatalf("LoadNotes: %v", err)
		}
		if cfg.Vault.Root != filepath.Join(home, "vault-from-env") {
			t.Errorf("vault.root = %q, want %q", cfg.Vault.Root, filepath.Join(home, "vault-from-env"))
		}
	})

	t.Run("relative HOUSTON_VAULT is stored absolute", func(t *testing.T) {
		clearConfigEnv(t)
		path := writeFile(t, "vault:\n  root: /tmp/org/repo-a/vault\nserver:\n  host: 127.0.0.1\n  port: 3301\ndb: /tmp/org/repo-a/notes.db\n")
		t.Setenv("HOUSTON_VAULT", filepath.Join("relative", "vault"))
		cfg, err := LoadNotes(path)
		if err != nil {
			t.Fatalf("LoadNotes: %v", err)
		}
		if !filepath.IsAbs(cfg.Vault.Root) {
			t.Errorf("relative HOUSTON_VAULT must be stored absolute, got %q", cfg.Vault.Root)
		}
		want, _ := filepath.Abs(filepath.Join("relative", "vault"))
		if cfg.Vault.Root != want {
			t.Errorf("vault.root = %q, want %q", cfg.Vault.Root, want)
		}
	})
}

func TestLoadNotesEmptyVariablesChangeNothing(t *testing.T) {
	clearConfigEnv(t)
	vault := t.TempDir()
	db := filepath.Join(t.TempDir(), "file.db")
	path := writeFile(t, "vault:\n  root: "+vault+"\nserver:\n  host: 127.0.0.1\n  port: 3301\ndb: "+db+"\n")
	t.Setenv("HOUSTON_VAULT", "")
	t.Setenv("HOUSTON_DB", "   ")
	cfg, err := LoadNotes(path)
	if err != nil {
		t.Fatalf("LoadNotes: %v", err)
	}
	if cfg.Vault.Root != vault {
		t.Errorf("empty HOUSTON_VAULT must be ignored, got %q want %q", cfg.Vault.Root, vault)
	}
	if cfg.DBPath != db {
		t.Errorf("blank HOUSTON_DB must be ignored, got %q want %q", cfg.DBPath, db)
	}
}

func TestLoadNotesRelativeXDGStateHomeIgnored(t *testing.T) {
	clearConfigEnv(t)
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_STATE_HOME", filepath.Join("relative", "state"))
	cfg, err := LoadNotes(filepath.Join(t.TempDir(), "does-not-exist.yaml"))
	if err != nil {
		t.Fatalf("LoadNotes: %v", err)
	}
	want := filepath.Join(home, ".local", "state", "houston", "notes.db")
	if cfg.DBPath != want {
		t.Errorf("relative XDG_STATE_HOME must be ignored: db = %q, want %q", cfg.DBPath, want)
	}
}

func TestLoadNotesAbsoluteXDGStateHomeUsed(t *testing.T) {
	clearConfigEnv(t)
	state := t.TempDir()
	t.Setenv("XDG_STATE_HOME", state)
	cfg, err := LoadNotes(filepath.Join(t.TempDir(), "does-not-exist.yaml"))
	if err != nil {
		t.Fatalf("LoadNotes: %v", err)
	}
	want := filepath.Join(state, "houston", "notes.db")
	if cfg.DBPath != want {
		t.Errorf("db = %q, want %q", cfg.DBPath, want)
	}
}

func TestLoadNotesInvalidAddr(t *testing.T) {
	for _, addr := range []string{"not-an-addr", "127.0.0.1:notaport", "127.0.0.1:99999", "127.0.0.1:0"} {
		t.Run(addr, func(t *testing.T) {
			clearConfigEnv(t)
			path := writeFile(t, "vault:\n  root: /tmp/org/repo-a/vault\nserver:\n  host: 127.0.0.1\n  port: 3301\ndb: /tmp/org/repo-a/notes.db\n")
			t.Setenv("HOUSTON_ADDR", addr)
			if _, err := LoadNotes(path); err == nil {
				t.Errorf("HOUSTON_ADDR %q must be an error", addr)
			}
		})
	}
}

func TestLoadNotesAddrWithSchemeRefusedWithHint(t *testing.T) {
	clearConfigEnv(t)
	path := writeFile(t, "vault:\n  root: /tmp/org/repo-a/vault\nserver:\n  host: 127.0.0.1\n  port: 3301\ndb: /tmp/org/repo-a/notes.db\n")
	t.Setenv("HOUSTON_ADDR", "http://127.0.0.1:3301")
	_, err := LoadNotes(path)
	if err == nil {
		t.Fatal("HOUSTON_ADDR with a scheme must be refused")
	}
	if !strings.Contains(err.Error(), "HOUSTON_HUB_URL") {
		t.Errorf("scheme refusal must point at HOUSTON_HUB_URL, got %q", err.Error())
	}
	if !strings.Contains(strings.ToLower(err.Error()), "drop") {
		t.Errorf("scheme refusal must hint to drop the scheme, got %q", err.Error())
	}
}

func TestLoadNotesAddrWithoutHostRefused(t *testing.T) {
	clearConfigEnv(t)
	path := writeFile(t, "vault:\n  root: /tmp/org/repo-a/vault\nserver:\n  host: 127.0.0.1\n  port: 3301\ndb: /tmp/org/repo-a/notes.db\n")
	t.Setenv("HOUSTON_ADDR", ":3301")
	if _, err := LoadNotes(path); err == nil {
		t.Fatal("HOUSTON_ADDR=:3301 must be refused")
	}
}

func TestValidateForServe(t *testing.T) {
	base := t.TempDir()
	vault := filepath.Join(base, "vault")
	db := filepath.Join(base, "notes.db")

	tests := []struct {
		name    string
		host    string
		port    int
		vault   string
		db      string
		wantErr string
	}{
		{"loopback 127.0.0.1 serves", "127.0.0.1", 3301, vault, db, ""},
		{"loopback ::1 serves", "::1", 3301, vault, db, ""},
		{"loopback localhost serves", "localhost", 3301, vault, db, ""},
		{"empty host refused", "", 3301, vault, db, "loopback"},
		{"HOUSTON_ADDR=:3301 refused for serving", "", 3301, vault, db, "loopback"},
		{"server.host 0.0.0.0 refused", "0.0.0.0", 3301, vault, db, "loopback"},
		{"network host refused", "example.com", 3301, vault, db, "loopback"},
		{"port zero refused", "127.0.0.1", 0, vault, db, "port"},
		{"port out of range refused", "127.0.0.1", 99999, vault, db, "port"},
		{"empty root refused", "127.0.0.1", 3301, "", db, "vault.root"},
		{"database inside the vault refused", "127.0.0.1", 3301, vault, filepath.Join(vault, "notes.db"), "inside"},
		{"database equal to the vault refused", "127.0.0.1", 3301, vault, vault, "inside"},
		{"sibling prefix is fine", "127.0.0.1", 3301, vault, vault + "-db" + string(filepath.Separator) + "notes.db", ""},
		{"relative path resolving inside refused", "127.0.0.1", 3301, "testvault-oc5-11", filepath.Join("testvault-oc5-11", "notes.db"), "inside"},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			cfg := &NotesConfig{}
			cfg.Server.Host = tc.host
			cfg.Server.Port = tc.port
			cfg.Vault.Root = tc.vault
			cfg.DBPath = tc.db
			err := cfg.ValidateForServe()
			if tc.wantErr == "" {
				if err != nil {
					t.Fatalf("ValidateForServe must pass: %v", err)
				}
				return
			}
			if err == nil {
				t.Fatalf("ValidateForServe must fail for %s", tc.name)
			}
			if !strings.Contains(strings.ToLower(err.Error()), strings.ToLower(tc.wantErr)) {
				t.Errorf("error %q must mention %q", err.Error(), tc.wantErr)
			}
		})
	}
}
