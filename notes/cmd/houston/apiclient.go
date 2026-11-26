package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"time"
)

// apiClient is how every client verb reaches the backend: it calls the same
// REST routes the hub calls, against a running `houston serve`.
//
// The server address is resolved lazily, on the first request, NOT when the
// client is built. Resolution reads notes.yaml when no --server/HOUSTON_ADDR
// was given, and that read used to run before the verb validated its
// arguments - so from a directory with no config, a malformed invocation
// (missing arg, unknown flag) failed with a config-load error at exit 1 instead
// of its real usage error at exit 2. Deferring resolution to base() lets each
// verb's argument validation run first; config is only touched once a request
// is actually about to go out.
type apiClient struct {
	// Inputs for lazy resolution. Empty configPath/server is valid:
	// base() falls through to notes.yaml / the default port at request time.
	configPath string
	server     string

	baseURL string // resolved+memoized by base(); may be set directly in tests
	http    *http.Client
}

// newAPIClient builds a client but does NOT resolve the server address - that
// happens lazily in base(), after the verb has validated its arguments. A
// genuinely missing config surfaces from the first request instead.
func newAPIClient(configPath, serverFlag string) *apiClient {
	return &apiClient{
		configPath: configPath,
		server:     serverFlag,
		http:       &http.Client{Timeout: 60 * time.Second},
	}
}

// base returns the resolved server URL, resolving (and memoizing) on first use.
// A directly-set baseURL (the test fakes) short-circuits resolution.
func (c *apiClient) base() (string, error) {
	if c.baseURL != "" {
		return c.baseURL, nil
	}
	resolved, err := resolveHealthURL(c.configPath, c.server)
	if err != nil {
		return "", err
	}
	c.baseURL = resolved
	return c.baseURL, nil
}

// request performs one API call and returns the raw response body. body is
// encoded as JSON when non-nil; a nil body sends no payload.
func (c *apiClient) request(ctx context.Context, method, path string, body any) (json.RawMessage, error) {
	var payload io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return nil, wrapLoud("encoding request body", err)
		}
		payload = bytes.NewReader(encoded)
	}

	base, err := c.base()
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, method, base+path, payload)
	if err != nil {
		return nil, wrapLoud("building request", err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, c.unreachable(err)
	}
	defer resp.Body.Close()

	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, wrapLoud("reading response", err)
	}
	if resp.StatusCode >= 400 {
		return nil, httpStatusError(method, path, resp.StatusCode, raw)
	}
	return raw, nil
}

// unreachable turns a dial failure into the one error that actually tells the
// caller what to do: start the server. Every client verb needs it up.
func (c *apiClient) unreachable(err error) error {
	var opErr *net.OpError
	if errors.As(err, &opErr) || errors.Is(err, context.DeadlineExceeded) {
		return fmt.Errorf("houston: cannot reach the houston server at %s - Fix: start it with 'houston serve', or point elsewhere with --server <url> / HOUSTON_ADDR: %w", c.baseURL, err)
	}
	return wrapLoud(fmt.Sprintf("request to %s failed", c.baseURL), err)
}

// notFoundError marks a 404 so a verb can tell "this does not exist" apart from
// the other 4xx answers. It wraps a usage error, so a verb that does NOT opt in
// keeps the old behaviour: a bad id is still exit 2, which is right - asking
// about something that is not there IS a bad invocation. Only the reads where
// absence is a legitimate answer call getOptional.
type notFoundError struct{ err error }

func (n notFoundError) Error() string { return n.err.Error() }
func (n notFoundError) Unwrap() error { return n.err }

// httpStatusError maps HTTP status onto the CLI's exit-code contract: a 4xx is
// something about the invocation (bad id, bad value) and exits 2; a 5xx is the
// backend failing and exits 1.
func httpStatusError(method, path string, status int, raw []byte) error {
	detail := strings.TrimSpace(string(raw))
	if len(detail) > 400 {
		detail = detail[:400] + "…"
	}
	if detail == "" {
		detail = http.StatusText(status)
	}
	if status == http.StatusNotFound {
		return notFoundError{err: usagef("houston: %s %s rejected with 404: %s", method, path, detail)}
	}
	if status >= 400 && status < 500 {
		return usagef("houston: %s %s rejected with %d: %s", method, path, status, detail)
	}
	return fmt.Errorf("houston: %s %s failed with %d: %s", method, path, status, detail)
}

func (c *apiClient) get(ctx context.Context, path string) (json.RawMessage, error) {
	return c.request(ctx, http.MethodGet, path, nil)
}

// getOptional is for reads where the thing legitimately may not exist yet.
// Those routes answer 404, which the default mapping turns into exit 2, telling
// a caller it invoked the command wrong when it merely asked a question whose
// answer is "none yet". Here absence is a value, not an error: found=false,
// and the verb decides how to say it.
func (c *apiClient) getOptional(ctx context.Context, path string) (raw json.RawMessage, found bool, err error) {
	raw, err = c.request(ctx, http.MethodGet, path, nil)
	if err == nil {
		return raw, true, nil
	}
	var missing notFoundError
	if errors.As(err, &missing) {
		return nil, false, nil
	}
	return nil, false, err
}

func (c *apiClient) post(ctx context.Context, path string, body any) (json.RawMessage, error) {
	return c.request(ctx, http.MethodPost, path, body)
}

func (c *apiClient) patch(ctx context.Context, path string, body any) (json.RawMessage, error) {
	return c.request(ctx, http.MethodPatch, path, body)
}

func (c *apiClient) put(ctx context.Context, path string, body any) (json.RawMessage, error) {
	return c.request(ctx, http.MethodPut, path, body)
}

func (c *apiClient) delete(ctx context.Context, path string) (json.RawMessage, error) {
	return c.request(ctx, http.MethodDelete, path, nil)
}

// postRaw sends a body the server wants verbatim (a note is markdown, not
// JSON), reusing the client's transport and its status/exit-code mapping -
// apiClient.post would JSON-encode the markdown and write a quoted string.
func (c *apiClient) postRaw(ctx context.Context, path, contentType string, body []byte) (json.RawMessage, error) {
	return c.postRawWithClient(ctx, path, contentType, body, "")
}

// postRawWithClient is postRaw plus the X-Houston-Client header, so the server
// knows which client wrote the note. The service suggests no links, so the
// header carries no routing today; it stays so a suggestion step wired back in
// can tell the assistant (cli) from the web UI.
func (c *apiClient) postRawWithClient(ctx context.Context, path, contentType string, body []byte, client string) (json.RawMessage, error) {
	base, err := c.base()
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+path, bytes.NewReader(body))
	if err != nil {
		return nil, wrapLoud("building request", err)
	}
	req.Header.Set("Content-Type", contentType)
	if client != "" {
		req.Header.Set("X-Houston-Client", client)
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, c.unreachable(err)
	}
	defer resp.Body.Close()

	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, wrapLoud("reading response", err)
	}
	if resp.StatusCode >= 400 {
		// Return the body with the error: note write --json must be able to
		// pass the server's status document through, and every other caller
		// ignores the body when the error is non-nil.
		return raw, httpStatusError(http.MethodPost, path, resp.StatusCode, raw)
	}
	return raw, nil
}
