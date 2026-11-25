// Command houston is the notes service of Houston's own notes engine.
//
// Verbs: serve starts the service, health prints what a running service
// answers, help prints the usage. Global flags: --config (default
// ${XDG_CONFIG_HOME:-~/.config}/houston/notes.yaml), --server for the client
// verbs, --json, and --help/-h/help. serve also takes --addr.
package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"

	"github.com/gabrielassisxyz/houston/notes/internal/logging"
)

func main() {
	// Logging through internal/logging, from HOUSTON_LOG_LEVEL (default info),
	// before any verb runs so every path writes through the same handler.
	logLevel := os.Getenv("HOUSTON_LOG_LEVEL")
	if logLevel == "" {
		logLevel = "info"
	}
	logging.Init(logLevel)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	if err := dispatch(ctx, os.Args[1:], os.Stdout, os.Stderr); err != nil {
		// A verb that already wrote its own output (e.g. preflight with an
		// error report) signals failure only through the exit code: print
		// nothing more, or the output is duplicated.
		var reported alreadyReported
		if errors.As(err, &reported) {
			os.Exit(exitCode(err))
		}
		fmt.Fprintln(os.Stderr, err)
		os.Exit(exitCode(err))
	}
}

// defaultConfigPath resolves the notes config default per provisional
// decision 1: ${XDG_CONFIG_HOME:-~/.config}/houston/notes.yaml. A relative
// XDG_CONFIG_HOME is ignored, as the XDG specification says; when the home
// directory is unknown the path stays empty and LoadNotes starts from zero
// values plus environment overrides.
func defaultConfigPath() string {
	if v := strings.TrimSpace(os.Getenv("XDG_CONFIG_HOME")); v != "" && filepath.IsAbs(v) {
		return filepath.Join(v, "houston", "notes.yaml")
	}
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return ""
	}
	return filepath.Join(home, ".config", "houston", "notes.yaml")
}

// parseStringFlag strips every occurrence of a global value flag, accepting
// both '--flag value' and '--flag=value'. When the flag repeats, the last
// value wins. A flag with no value fails loud.
func parseStringFlag(args []string, name string) (value string, rest []string, err error) {
	for i := 0; i < len(args); i++ {
		a := args[i]
		switch {
		case a == name:
			if i+1 >= len(args) {
				return "", nil, usagef("houston: %s requires a value - run: houston help", a)
			}
			value = args[i+1]
			i++
		case strings.HasPrefix(a, name+"="):
			value = strings.TrimPrefix(a, name+"=")
			if value == "" {
				return "", nil, usagef("houston: %s requires a value - run: houston help", name)
			}
		default:
			rest = append(rest, a)
		}
	}
	return value, rest, nil
}

// parseBoolFlag strips a valueless flag from args and reports whether it was
// present.
func parseBoolFlag(args []string, name string) (present bool, rest []string) {
	for i := 0; i < len(args); i++ {
		if args[i] == name {
			rest = append(rest, args[:i]...)
			rest = append(rest, args[i+1:]...)
			return true, rest
		}
	}
	return false, args
}

// splitHostPort parses a host:port value with the same contract as
// HOUSTON_ADDR: a value carrying a scheme is refused with a hint to drop it.
func splitHostPort(raw, flag string) (host string, port int, err error) {
	if strings.Contains(raw, "://") {
		return "", 0, usagef("houston: %s %q must be host:port without a scheme - drop the scheme (for example 127.0.0.1:3301)", flag, raw)
	}
	host, portStr, serr := net.SplitHostPort(raw)
	if serr != nil {
		return "", 0, usagef("houston: %s %q must be host:port: %v", flag, raw, serr)
	}
	if strings.TrimSpace(host) == "" {
		return "", 0, usagef("houston: %s %q must name a host - for example 127.0.0.1:3301", flag, raw)
	}
	port, aerr := strconv.Atoi(strings.TrimSpace(portStr))
	if aerr != nil || port < 1 || port > 65535 {
		return "", 0, usagef("houston: %s %q must name a port between 1 and 65535", flag, raw)
	}
	return host, port, nil
}

func usage() string {
	return `houston - notes service of Houston's own notes engine

Usage:
  houston [--config <path>] [--server <url>] [--json] <command> [args...]

Commands:
  serve         Start the notes service
  health        Print what a running service answers
  preflight     Report what the first index would change, writing nothing
  help          Print this usage

Run 'houston help <command>' for details.
`
}

func serveUsage() string {
	return `houston serve - start the notes service

Usage:
  houston [--config <path>] serve [--addr <host:port>]

Starts the service on the configured vault and address, answers health from
the first second while the vault is still being indexed, and stops cleanly on
SIGINT or SIGTERM, also in the middle of the first index.

  --addr <host:port>  Serve on this address instead of the configured one.
                      A value with a scheme is refused: drop it, since
                      HOUSTON_ADDR takes host:port and not a URL.
`
}

func healthUsage() string {
	return `houston health - print what a running service answers

Usage:
  houston [--config <path>] [--server <url>] health [--json]

  --server <url>  Check this server instead of the configured one. Accepts
                  host:port or a full URL; the scheme defaults to http://.
  --json          Emit the API's {"status","vaultRoot","vaultLabel"} verbatim.
`
}

func preflightUsage() string {
	return `houston preflight - report what the first index would change

Usage:
  houston [--config <path>] preflight [--json]

Walks the vault with the reconciler's own parser and note-file helpers,
prints one line per finding and a count per kind, and writes nothing.
Exits 0 when there is no error, 1 otherwise.

  --json          Emit {"errors","notices","counts","findings"} as one document.
`
}

// dispatch parses the global flags once and runs the verb. stdout carries the
// result, stderr carries nothing but errors: --json stdout stays a document
// another tool can read whole.
func dispatch(ctx context.Context, args []string, stdout, stderr io.Writer) error {
	if len(args) == 0 {
		fmt.Fprint(stdout, usage())
		return nil
	}

	// Help always wins: intercept --help/-h/help before loading config or
	// doing any work, so a help request can never mutate state.
	if topic, ok := helpTopic(args); ok {
		fmt.Fprint(stdout, topic)
		return nil
	}

	configPath, args, err := parseStringFlag(args, "--config")
	if err != nil {
		return err
	}
	if configPath == "" {
		configPath = defaultConfigPath()
	}
	serverFlag, args, err := parseStringFlag(args, "--server")
	if err != nil {
		return err
	}
	asJSON, args := parseBoolFlag(args, "--json")

	if len(args) == 0 {
		fmt.Fprint(stdout, usage())
		return nil
	}

	switch args[0] {
	case "serve":
		return runServeCmd(ctx, stdout, stderr, configPath, serverFlag, asJSON, args[1:])
	case "health":
		return runHealthCmd(stdout, configPath, serverFlag, asJSON, args[1:])
	case "preflight":
		return runPreflightCmd(stdout, configPath, serverFlag, asJSON, args[1:])
	default:
		if strings.HasPrefix(args[0], "-") {
			return usagef("houston: unknown flag %q - run: houston help", args[0])
		}
		return usagef("houston: unknown command %q - run: houston help", args[0])
	}
}

// helpTopic intercepts --help/-h/help for the root and for each verb before
// any work runs.
func helpTopic(args []string) (string, bool) {
	for _, a := range args {
		switch a {
		case "--help", "-h":
			// A verb-scoped help when the verb is named, else the root usage.
			for _, v := range args {
				switch v {
				case "serve":
					return serveUsage(), true
				case "health":
					return healthUsage(), true
				case "preflight":
					return preflightUsage(), true
				}
			}
			return usage(), true
		case "help":
			// 'houston help serve' documents the verb; bare 'help' the root.
			for _, v := range args {
				switch v {
				case "serve":
					return serveUsage(), true
				case "health":
					return healthUsage(), true
				case "preflight":
					return preflightUsage(), true
				}
			}
			return usage(), true
		}
	}
	return "", false
}

// rejectUnknownFlags fails loud on any leftover flag-looking argument, so a
// typo'd flag is never silently treated as a positional argument.
func rejectUnknownFlags(verb string, args []string) error {
	for _, a := range args {
		if strings.HasPrefix(a, "-") && a != "-" {
			return usagef("houston: unknown flag %q for %s - run: houston help %s", a, verb, verb)
		}
	}
	return nil
}


