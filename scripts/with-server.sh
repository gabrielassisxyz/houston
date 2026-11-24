#!/usr/bin/env bash
# Start an isolated production server from the CURRENT BUILD of this checkout, run one command
# against it, stop the server, and exit with the command's exit code. Nothing is left running.
#
#   scripts/with-server.sh <port> <command...>
#   scripts/with-server.sh 3211 node scripts/test-br-store.mjs
#
# Run `npm run build` first, and again after every source change: this serves what is built.
#
# What "isolated" means here:
#   - the server gets its own XDG_CONFIG_HOME, so the real app config (the project list, the
#     configured actor) is never read or written;
#   - it binds to 127.0.0.1 only;
#   - TMPDIR points at a scratch directory, so the throwaway trackers a test creates with
#     os.tmpdir() land there too.
#
# The command runs with SCOTTY_TEST_URL=http://127.0.0.1:<port>.
#
# Environment:
#   SCOTTY_TEST_TMP   scratch directory (default /tmp/scotty-test-<uid>). KEEP IT SHORT: the
#                     full Chromium binary creates a unix socket under TMPDIR and aborts with
#                     "Socket path too long" past 108 bytes, which Playwright reports only as
#                     "Target page, context or browser has been closed".
#   PLAYWRIGHT_BROWSERS_PATH
#                     where Playwright looks for browsers. When it is unset and a system
#                     Chromium is on PATH, this script points Playwright at that binary (see
#                     use_system_chromium below). Set it yourself to use another build.
set -u

if [ "$#" -lt 2 ]; then
    echo "usage: scripts/with-server.sh <port> <command...>" >&2
    exit 2
fi
port=$1
shift

root=$(cd "$(dirname "$0")/.." && pwd -P)
cd "$root" || exit 2

scratch=${SCOTTY_TEST_TMP:-/tmp/scotty-test-$(id -u)}
mkdir -p "$scratch"
export TMPDIR=$scratch

# Playwright downloads its own Chromium by default. Where that build does not run, the system
# one does. The scripts call a bare chromium.launch(), which has no option for another
# executable, so the layout Playwright expects is built with its executables symlinked to the
# system binary. The revisions come from the installed playwright-core, so this follows an
# upgrade of the package without an edit.
use_system_chromium() {
    local bin dir rev shell_rev
    bin=$(command -v chromium || command -v chromium-browser || true)
    [ -n "$bin" ] || return 0
    [ -f node_modules/playwright-core/browsers.json ] || return 0
    rev=$(node -e 'const b=require("./node_modules/playwright-core/browsers.json").browsers;process.stdout.write(String(b.find(x=>x.name==="chromium")?.revision??""))')
    shell_rev=$(node -e 'const b=require("./node_modules/playwright-core/browsers.json").browsers;process.stdout.write(String(b.find(x=>x.name==="chromium-headless-shell")?.revision??""))')
    [ -n "$rev" ] && [ -n "$shell_rev" ] || return 0
    dir=$scratch/browsers
    mkdir -p "$dir/chromium-$rev/chrome-linux64" \
        "$dir/chromium_headless_shell-$shell_rev/chrome-headless-shell-linux64"
    ln -sfn "$bin" "$dir/chromium-$rev/chrome-linux64/chrome"
    ln -sfn "$bin" "$dir/chromium_headless_shell-$shell_rev/chrome-headless-shell-linux64/chrome-headless-shell"
    : >"$dir/chromium-$rev/INSTALLATION_COMPLETE"
    : >"$dir/chromium_headless_shell-$shell_rev/INSTALLATION_COMPLETE"
    export PLAYWRIGHT_BROWSERS_PATH=$dir
}
[ -n "${PLAYWRIGHT_BROWSERS_PATH:-}" ] || use_system_chromium

if ss -ltnH "sport = :$port" 2>/dev/null | grep -q .; then
    echo "with-server: port $port is already in use; pick another or stop what holds it" >&2
    exit 2
fi

cfg=$(mktemp -d -p "$scratch" cfg-XXXXXX)
XDG_CONFIG_HOME="$cfg" npm run start -- --port "$port" --hostname 127.0.0.1 \
    >"$cfg/server.log" 2>&1 &
server=$!

stop_server() {
    pkill -TERM -P "$server" 2>/dev/null
    kill -TERM "$server" 2>/dev/null
    wait "$server" 2>/dev/null
}
trap stop_server EXIT

ready=0
for _ in $(seq 1 60); do
    code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/api/projects" || true)
    if [ "$code" = "200" ]; then ready=1; break; fi
    read -r -t 0.5 _ </dev/zero || true
done
if [ "$ready" != 1 ]; then
    echo "with-server: the server did not answer on port $port; log: $cfg/server.log" >&2
    tail -20 "$cfg/server.log" >&2
    exit 2
fi

echo "with-server: server up on 127.0.0.1:$port (log: $cfg/server.log)"
SCOTTY_TEST_URL="http://127.0.0.1:$port" "$@"
rc=$?
echo "with-server: command exited $rc"
exit "$rc"
