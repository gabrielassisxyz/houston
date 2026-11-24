#!/usr/bin/env bash
# Pull, reinstall dependencies, rebuild and restart the Houston launchd service.
#
# The service stays unloaded across `npm ci` and `npm run build` so launchd does
# not restart the server mid-update against a partial node_modules or .next tree.
set -euo pipefail

LABEL="houston.hub"
ROOT=$(cd "$(dirname "$0")/.." && pwd -P)
cd "$ROOT"

[ -n "${HOME:-}" ] || { printf 'update: HOME is not set\n' >&2; exit 1; }
PLIST_FILE="$HOME/Library/LaunchAgents/$LABEL.plist"

if [ ! -f "$PLIST_FILE" ]; then
  printf 'update: service definition not found at %s (run scripts/install-services.sh first)\n' "$PLIST_FILE" >&2
  exit 1
fi

uid=$(id -u)

run_step() {
  local name=$1
  shift
  if ! "$@"; then
    printf 'update: failed at step "%s"; service %s remains unloaded. Re-run scripts/update.sh to resume.\n' "$name" "$LABEL" >&2
    exit 1
  fi
}

launchctl bootout "gui/$uid/$LABEL" >/dev/null 2>&1 || true

run_step "git pull" git pull --ff-only
run_step "npm ci" npm ci
run_step "npm run build" npm run build
run_step "launchctl bootstrap" launchctl bootstrap "gui/$uid" "$PLIST_FILE"
