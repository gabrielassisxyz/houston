package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/gabrielassisxyz/houston/notes/internal/config"
)

// healthTimeout bounds the check: a running service answers from the first
// second, so a stall means nobody is home.
const healthTimeout = 10 * time.Second

// runHealthCmd runs the health verb: it prints what a running service
// answers, in human form or, with --json, the API's document verbatim.
func runHealthCmd(stdout io.Writer, configPath, serverFlag string, asJSON bool, args []string) error {
	if err := rejectUnknownFlags("health", args); err != nil {
		return err
	}
	if len(args) != 0 {
		return usagef("houston: health takes no arguments - run: houston help health")
	}

	baseURL, err := resolveHealthURL(configPath, serverFlag)
	if err != nil {
		return err
	}

	ctx, cancel := context.WithTimeout(context.Background(), healthTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, baseURL+"/api/health", nil)
	if err != nil {
		return fmt.Errorf("houston health: building request for %s: %w", baseURL, err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("houston health: no server answers at %s (%v) - start one with: houston serve", baseURL, err)
	}
	defer func() { _ = resp.Body.Close() }()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("houston health: reading the answer of %s: %w", baseURL, err)
	}
	if resp.StatusCode != http.StatusOK {
		msg := fmt.Sprintf("houston health: %s answered %s - start a healthy one with: houston serve", baseURL, resp.Status)
		if resp.StatusCode >= 400 && resp.StatusCode < 500 {
			return usagef("%s", msg)
		}
		return fmt.Errorf("%s", msg)
	}

	if asJSON {
		return emitHealthJSON(stdout, raw)
	}
	var status healthStatusView
	if err := json.Unmarshal(raw, &status); err != nil {
		return fmt.Errorf("houston health: decoding the answer of %s/api/health: %w", baseURL, err)
	}
	fmt.Fprintf(stdout, "%s  server %s\n", status.Status, baseURL)
	fmt.Fprintf(stdout, "vault  %s\n", healthVaultLabel(status))
	fmt.Fprintf(stdout, "indexing  %v\n", status.Indexing)
	if len(status.Reports) > 0 {
		names := make([]string, 0, len(status.Reports))
		for k := range status.Reports {
			names = append(names, k)
		}
		// Sorted, so repeated runs diff cleanly.
		for i := 0; i < len(names); i++ {
			for j := i + 1; j < len(names); j++ {
				if names[j] < names[i] {
					names[i], names[j] = names[j], names[i]
				}
			}
		}
		fmt.Fprintln(stdout, "reports:")
		for _, k := range names {
			fmt.Fprintf(stdout, "  %s: %d\n", k, status.Reports[k])
		}
	}
	return nil
}

// healthStatusView is the subset of GET /api/health the summary prints:
// liveness, the vault location, and the readiness the large-vault step adds
// (indexing plus the per-kind file-report counts).
type healthStatusView struct {
	Status     string         `json:"status"`
	VaultRoot  string         `json:"vaultRoot"`
	VaultLabel string         `json:"vaultLabel"`
	Indexing   bool           `json:"indexing"`
	Reports    map[string]int `json:"reports"`
}

// healthVaultLabel prefers the server's display label and falls back to the
// root it also answers. A server with no vault configured is worth saying out
// loud, with the fix this binary owns.
func healthVaultLabel(status healthStatusView) string {
	if strings.TrimSpace(status.VaultLabel) != "" {
		return status.VaultLabel
	}
	if strings.TrimSpace(status.VaultRoot) != "" {
		return status.VaultRoot
	}
	return "(none configured - set vault.root in notes.yaml or HOUSTON_VAULT to the vault directory)"
}

// emitHealthJSON passes the server's own body along, pretty-printed when it
// is JSON, untouched otherwise. The REST layer speaks camelCase, so the CLI's
// --json contract is the API's, with no second mapping to drift.
func emitHealthJSON(stdout io.Writer, raw json.RawMessage) error {
	var pretty bytes.Buffer
	if err := json.Indent(&pretty, raw, "", "  "); err != nil {
		_, err := fmt.Fprintln(stdout, strings.TrimSpace(string(raw)))
		return err
	}
	_, err := fmt.Fprintln(stdout, pretty.String())
	return err
}

// resolveHealthURL picks the server address, most explicit source first:
// --server, then HOUSTON_ADDR, then the config file's server section, then
// the 127.0.0.1:3301 default. (A12 gives the order of precedence; until then
// this mirrors the serve side: flag, environment, file, default.) Config is
// only read when nothing more specific was given, so a --server invocation
// works with no config file present.
func resolveHealthURL(configPath, serverFlag string) (string, error) {
	if serverFlag != "" {
		return normalizeServerURL(serverFlag)
	}
	if v := strings.TrimSpace(os.Getenv("HOUSTON_ADDR")); v != "" {
		host, port, err := splitHostPort(v, "HOUSTON_ADDR")
		if err != nil {
			return "", err
		}
		return "http://" + net.JoinHostPort(host, strconv.Itoa(port)), nil
	}
	cfg, err := config.LoadNotes(configPath)
	if err != nil {
		return "", err
	}
	return "http://" + net.JoinHostPort(cfg.Server.Host, strconv.Itoa(cfg.Server.Port)), nil
}

// normalizeServerURL accepts what a human types - "127.0.0.1:3301",
// "http://127.0.0.1:3301/" - and returns a scheme-qualified base with no
// trailing slash.
func normalizeServerURL(raw string) (string, error) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return "", usagef("houston: --server requires a URL - for example houston --server http://127.0.0.1:3301 health")
	}
	if !strings.Contains(s, "://") {
		s = "http://" + s
	}
	u, err := url.Parse(s)
	if err != nil || u.Host == "" {
		return "", usagef("houston: --server value %q is not a valid URL - for example houston --server http://127.0.0.1:3301 health", raw)
	}
	return strings.TrimSuffix(u.Scheme+"://"+u.Host+u.Path, "/"), nil
}
