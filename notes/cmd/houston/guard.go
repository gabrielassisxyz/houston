package main

import (
	"log/slog"
	"net"
	"net/http"
	"strconv"
	"strings"

	"github.com/gabrielassisxyz/houston/notes/internal/logging"
)

// requestGuardMiddleware refuses requests that look like they came from a web
// page or through a non-loopback Host header (DNS rebinding). It sits inside
// LoggingMiddleware and CorrelationMiddleware so every 403 refusal is logged
// with a correlation ID.
//
// It intentionally ignores Sec-Fetch-Mode: Node's fetch (used by the hub's
// server side) sends "sec-fetch-mode: cors" on every request while omitting
// Origin and Sec-Fetch-Site.
func requestGuardMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !isLoopbackHost(r.Host) {
			refuseRequest(w, r, "non-loopback host")
			return
		}
		if len(r.Header.Values("Origin")) > 0 {
			refuseRequest(w, r, "browser origin header")
			return
		}
		if len(r.Header.Values("Sec-Fetch-Site")) > 0 {
			refuseRequest(w, r, "browser sec-fetch-site header")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func refuseRequest(w http.ResponseWriter, r *http.Request, reason string) {
	slog.Warn("request refused",
		"reason", reason,
		"host", r.Host,
		"method", r.Method,
		"path", r.URL.Path,
		"correlation_id", logging.CorrelationID(r.Context()),
	)
	http.Error(w, "forbidden: "+reason, http.StatusForbidden)
}

// isLoopbackHost reports whether raw is a valid HTTP Host header pointing at
// loopback (127.0.0.1, localhost, or ::1), with an optional numeric port in
// 1..65535.
func isLoopbackHost(raw string) bool {
	if raw == "" {
		return false
	}
	host := raw
	if h, portStr, err := net.SplitHostPort(raw); err == nil {
		if !isValidPort(portStr) {
			return false
		}
		// net.SplitHostPort accepts brackets around any host (such as
		// [127.0.0.1]:3301); brackets are only allowed for IPv6 ::1.
		if strings.HasPrefix(raw, "[") && h != "::1" {
			return false
		}
		host = h
	} else if raw == "[::1]" {
		host = "::1"
	}
	return isLoopbackHostname(host)
}

func isValidPort(portStr string) bool {
	if portStr == "" {
		return false
	}
	for i := 0; i < len(portStr); i++ {
		if portStr[i] < '0' || portStr[i] > '9' {
			return false
		}
	}
	port, err := strconv.Atoi(portStr)
	return err == nil && port >= 1 && port <= 65535
}

func isLoopbackHostname(host string) bool {
	switch strings.ToLower(host) {
	case "127.0.0.1", "localhost", "::1":
		return true
	default:
		return false
	}
}
