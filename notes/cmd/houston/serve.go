package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strconv"
	"time"

	"github.com/gabrielassisxyz/houston/notes/internal/api"
	"github.com/gabrielassisxyz/houston/notes/internal/config"
	"github.com/gabrielassisxyz/houston/notes/internal/graph"
	"github.com/gabrielassisxyz/houston/notes/internal/graph/dbfile"
	"github.com/gabrielassisxyz/houston/notes/internal/logging"
	"github.com/gabrielassisxyz/houston/notes/internal/vault"
)

// Server timeouts, kernl's own at cmd/kernl/serve.go:257-263.
const (
	serverReadTimeout  = 15 * time.Second
	serverWriteTimeout = 60 * time.Second
	serverIdleTimeout  = 120 * time.Second
	// shutdownTimeout bounds the graceful drain after SIGINT/SIGTERM.
	// kernl waits ten seconds before it gives up and exits 1.
	shutdownTimeout = 10 * time.Second
)

// startVaultFunc starts the vault lifecycle. It is a parameter rather than a
// direct call so the integration test can hold the first index open
// deterministically: the fake blocks until the test has probed /api/health,
// proving the server answers while the vault is still being indexed.
type startVaultFunc func(ctx context.Context, svc *vault.Service) error

func realStartVault(ctx context.Context, svc *vault.Service) error {
	return svc.Start(ctx)
}

// runServeCmd runs the serve verb: the --addr flag plus the serve-only
// argument check, then the seven-step start order.
func runServeCmd(ctx context.Context, stdout, stderr io.Writer, configPath, serverFlag string, asJSON bool, args []string) error {
	if serverFlag != "" {
		return usagef("houston: --server is for the client verbs - serve takes --addr. Run: houston help serve")
	}
	if asJSON {
		return usagef("houston: serve takes no --json - its output is logs, not a document. Run: houston help serve")
	}
	addrOverride, args, err := parseStringFlag(args, "--addr")
	if err != nil {
		return err
	}
	if err := rejectUnknownFlags("serve", args); err != nil {
		return err
	}
	if len(args) != 0 {
		return usagef("houston: serve takes no arguments - run: houston help serve")
	}

	cfg, err := loadServeConfig(configPath, addrOverride)
	if err != nil {
		return err
	}
	return runServe(ctx, stdout, stderr, cfg, realStartVault)
}

// loadServeConfig runs the first step of serve's start order: LoadNotes, then
// ValidateForServe, then vault.ApplyDefaults, then vault.Validate. The --addr
// override wins over the file and the environment because it is applied after
// LoadNotes already merged those two.
func loadServeConfig(configPath, addrOverride string) (*config.NotesConfig, error) {
	cfg, err := config.LoadNotes(configPath)
	if err != nil {
		return nil, err
	}
	if addrOverride != "" {
		host, port, err := splitHostPort(addrOverride, "--addr")
		if err != nil {
			return nil, err
		}
		cfg.Server.Host = host
		cfg.Server.Port = port
	}
	if err := cfg.ValidateForServe(); err != nil {
		return nil, err
	}
	// ApplyDefaults before Validate: with MoveWindowMs zero the flush ticker
	// (internal/vault/service.go) is created with a zero duration, which
	// panics. kernl's own serve applies defaults first for the same reason.
	vault.ApplyDefaults(&cfg.Vault)
	if err := vault.Validate(cfg.Vault); err != nil {
		return nil, err
	}
	return cfg, nil
}

// runServe starts the service in serve's seven-step order:
//
//  1. (in loadServeConfig) LoadNotes, ValidateForServe,
//     vault.ApplyDefaults, vault.Validate;
//  2. the lock on the notes database, released on exit;
//  3. graph.Open, closed on exit;
//  4. vault.New, before the server, so health has a service to read from the
//     first request;
//  5. net.Listen plus an http.Server with kernl's timeouts serving the routes,
//     in a goroutine, so health answers while the vault is indexed;
//  6. Start; a SIGINT or SIGTERM during the first index ends it with the
//     context's error, which is a clean stop, not a failure; any other error
//     also runs the shutdown below before it is returned;
//  7. on SIGINT or SIGTERM: stop the vault service, shut the server down with
//     a timeout, close the graph, release the lock.
//
// kernl's serve returns at once on Start's error instead, skipping the
// server's shutdown; here every exit runs the same shutdown.
func runServe(ctx context.Context, stdout, stderr io.Writer, cfg *config.NotesConfig, startVault startVaultFunc) error {
	release, err := dbfile.Acquire(cfg.DBPath)
	if err != nil {
		var locked dbfile.GraphLockedError
		if errors.As(err, &locked) {
			printGraphLockHint(stderr, locked)
		}
		return err
	}

	g, err := graph.Open(ctx, graph.Config{Path: cfg.DBPath})
	if err != nil {
		_ = release()
		return fmt.Errorf("houston serve: open graph: %w", err)
	}

	svc := vault.New(g, cfg.Vault)

	mux := http.NewServeMux()
	if err := api.Register(mux, api.Deps{Graph: g, VaultRoot: cfg.Vault.Root}); err != nil {
		_ = g.Close()
		_ = release()
		return fmt.Errorf("houston serve: register routes: %w", err)
	}
	// kernl's request middleware (internal/api/routes.go:52-54): timing,
	// logging and correlation, but no corsMiddleware (:55), since the request
	// guard refuses every request that carries an Origin.
	var h http.Handler = mux
	h = logging.TimingMiddleware(h)
	h = logging.LoggingMiddleware(h)
	h = logging.CorrelationMiddleware(h)

	addr := net.JoinHostPort(cfg.Server.Host, strconv.Itoa(cfg.Server.Port))
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		_ = g.Close()
		_ = release()
		fmt.Fprintf(stderr, "\nAnother houston is probably already listening on %s. Find it with:\n    ss -ltnp 'sport = :%d'\nthen stop it, or serve on another address with --addr.\n\n", addr, cfg.Server.Port)
		return fmt.Errorf("houston serve: cannot listen on %s: %w", addr, err)
	}
	srv := &http.Server{
		Addr:         addr,
		Handler:      h,
		ReadTimeout:  serverReadTimeout,
		WriteTimeout: serverWriteTimeout,
		IdleTimeout:  serverIdleTimeout,
	}
	serveErrCh := make(chan error, 1)
	go func() {
		err := srv.Serve(ln)
		if errors.Is(err, http.ErrServerClosed) {
			err = nil
		}
		serveErrCh <- err
	}()
	fmt.Fprintf(stdout, "houston serving - API http://%s\n", ln.Addr().String())

	startErr := startVault(ctx, svc)
	serveErr := error(nil)
	serverDone := false
	if startErr == nil {
		// The index finished and the watcher is live: wait for the stop
		// signal, or for the server dying on its own.
		select {
		case <-ctx.Done():
		case serveErr = <-serveErrCh:
			serverDone = true
		}
	} else if ctx.Err() != nil {
		// A SIGINT or SIGTERM during the first index ends Start with the
		// context's error: a clean stop, not a failure.
		startErr = nil
	}

	// Every exit runs the same shutdown: stop the vault service, shut the
	// server down with a timeout, close the graph, release the lock.
	svc.Stop()
	shutCtx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
	shutErr := srv.Shutdown(shutCtx)
	cancel()
	if !serverDone {
		serveErr = <-serveErrCh
	}
	closeErr := g.Close()
	relErr := release()

	if startErr != nil {
		return startErr
	}
	if serveErr != nil {
		return fmt.Errorf("houston serve: server error: %w", serveErr)
	}
	return errors.Join(shutErr, closeErr, relErr)
}

// printGraphLockHint writes the multi-line way out of a refused lock: the
// error value stays one line, while a human staring at a dead process needs
// the next command to type. The pid is what the lock file last recorded,
// never a claim about who holds the lock right now.
func printGraphLockHint(stdout io.Writer, locked dbfile.GraphLockedError) {
	fmt.Fprintf(stdout, "\nAnother houston serve owns %s.\n", locked.Path)
	if locked.PID > 0 {
		fmt.Fprintf(stdout, "The lock file last recorded pid %d:\n    ps -p %d -o pid,lstart,cmd\n",
			locked.PID, locked.PID)
	}
	fmt.Fprintf(stdout, "Stop that process, or run this instance against another database file -\n"+
		"set db or HOUSTON_DB to a file outside the vault.\n\n")
}
