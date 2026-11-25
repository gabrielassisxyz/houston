#!/usr/bin/env bash
# Pull, reinstall dependencies, rebuild and restart the Houston launchd services.
#
# The services stay unloaded across `npm ci` and `npm run build` (and `go build`
# for notes) so launchd does not restart the servers mid-update against a
# partial node_modules, .next tree or notes binary.
set -euo pipefail

LABEL="houston.hub"
NOTES_LABEL="houston.notes"
ROOT=$(cd "$(dirname "$0")/.." && pwd -P)
cd "$ROOT"

[ -n "${HOME:-}" ] || { printf 'update: HOME is not set\n' >&2; exit 1; }
PLIST_FILE="$HOME/Library/LaunchAgents/$LABEL.plist"
NOTES_PLIST_FILE="$HOME/Library/LaunchAgents/$NOTES_LABEL.plist"
NOTES_BIN="$ROOT/notes/bin/houston"

if [ ! -f "$PLIST_FILE" ]; then
  printf 'update: service definition not found at %s (run scripts/install-services.sh first)\n' "$PLIST_FILE" >&2
  exit 1
fi

NOTES_ENABLED=0
if [ -f "$NOTES_PLIST_FILE" ]; then
  NOTES_ENABLED=1
fi

# When the notes definition is installed, go must be present before anything
# is unloaded, so a missing toolchain never leaves the services down.
if [ "$NOTES_ENABLED" -eq 1 ]; then
  command -v go >/dev/null 2>&1 || { printf 'update: go not found on PATH; install Go 1.26 or later (https://go.dev/dl/) and ensure go is on PATH\n' >&2; exit 1; }
fi

uid=$(id -u)

run_step() {
  local name=$1
  shift
  if ! "$@"; then
    if [ "$NOTES_ENABLED" -eq 1 ]; then
      printf 'update: failed at step "%s"; services %s and %s remain unloaded. Re-run scripts/update.sh to resume.\n' "$name" "$LABEL" "$NOTES_LABEL" >&2
    else
      printf 'update: failed at step "%s"; service %s remains unloaded. Re-run scripts/update.sh to resume.\n' "$name" "$LABEL" >&2
    fi
    exit 1
  fi
}

go_build_step() {
  mkdir -p "$ROOT/notes/bin"
  (cd "$ROOT/notes" && go build -o "$NOTES_BIN" ./cmd/houston)
}

launchctl bootout "gui/$uid/$LABEL" >/dev/null 2>&1 || true
if [ "$NOTES_ENABLED" -eq 1 ]; then
  launchctl bootout "gui/$uid/$NOTES_LABEL" >/dev/null 2>&1 || true
fi

run_step "git pull" git pull --ff-only
run_step "npm ci" npm ci
run_step "npm run build" npm run build
if [ "$NOTES_ENABLED" -eq 1 ]; then
  run_step "go build" go_build_step
fi
run_step "launchctl bootstrap" launchctl bootstrap "gui/$uid" "$PLIST_FILE"
if [ "$NOTES_ENABLED" -eq 1 ]; then
  run_step "launchctl bootstrap notes" launchctl bootstrap "gui/$uid" "$NOTES_PLIST_FILE"
fi
