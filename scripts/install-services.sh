#!/usr/bin/env bash
# Install (or print) the macOS launchd user agent for the Houston hub.
#
# Usage:
#   scripts/install-services.sh [--node <path>] [--checkout <dir>]
#                               [--path <PATH>] [--port <n>] [--print]
set -euo pipefail

LABEL="houston.hub"
HOST="127.0.0.1"
PORT="3300"
NODE_BIN=""
CHECKOUT=""
SERVICE_PATH=""
PRINT_ONLY=0

usage() {
  cat <<'EOF'
Usage: scripts/install-services.sh [options]

Options:
  --node <path>      Absolute path to the node binary (default: `command -v node`,
                     kept as found without resolving symlinks).
  --checkout <dir>   Absolute path to the Houston checkout (default: parent of
                     this script's directory).
  --path <PATH>      PATH exposed to the launchd service (default: directories
                     containing `br` and `git`, followed by system paths).
  --port <n>         Port to bind on 127.0.0.1 (default: 3300).
  --print            Print the launchd plist to stdout without touching disk or
                     checking tools.
  -h, --help         Show this help.
EOF
}

die() {
  printf 'install-services: %s\n' "$1" >&2
  exit 1
}

# Reject ASCII control characters (0x00-0x1f, 0x7f) that are invalid in XML 1.0
# or unsafe in launchd paths and environment values.
validate_xml_safe() {
  local name=$1
  local val=$2
  local stripped
  stripped=$(printf '%s' "$val" | LC_ALL=C tr -d '\001-\037\177')
  if [ "$stripped" != "$val" ]; then
    die "$name contains control characters that cannot be safely written to a plist"
  fi
}

xml_escape() {
  local s=$1
  s=${s//&/&amp;}
  s=${s//</&lt;}
  s=${s//>/&gt;}
  s=${s//\"/&quot;}
  s=${s//\'/&apos;}
  printf '%s' "$s"
}

append_path_dir() {
  local cur=$1
  local dir=$2
  [ -n "$dir" ] || { printf '%s' "$cur"; return; }
  case ":$cur:" in
    *":$dir:"*) printf '%s' "$cur" ;;
    "::") printf '%s' "$dir" ;;
    *) printf '%s:%s' "$cur" "$dir" ;;
  esac
}

default_service_path() {
  local out="" bin dir
  for tool in br git; do
    bin=$(command -v "$tool" 2>/dev/null || true)
    if [ -n "$bin" ]; then
      dir=$(dirname "$bin")
      out=$(append_path_dir "$out" "$dir")
    fi
  done
  for dir in /usr/local/bin /usr/bin /bin /usr/sbin /sbin; do
    out=$(append_path_dir "$out" "$dir")
  done
  printf '%s' "$out"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --node)
      [ "$#" -ge 2 ] || die "--node requires a value"
      NODE_BIN=$2
      shift 2
      ;;
    --node=*)
      NODE_BIN=${1#--node=}
      shift
      ;;
    --checkout)
      [ "$#" -ge 2 ] || die "--checkout requires a value"
      CHECKOUT=$2
      shift 2
      ;;
    --checkout=*)
      CHECKOUT=${1#--checkout=}
      shift
      ;;
    --path)
      [ "$#" -ge 2 ] || die "--path requires a value"
      SERVICE_PATH=$2
      shift 2
      ;;
    --path=*)
      SERVICE_PATH=${1#--path=}
      shift
      ;;
    --port)
      [ "$#" -ge 2 ] || die "--port requires a value"
      PORT=$2
      shift 2
      ;;
    --port=*)
      PORT=${1#--port=}
      shift
      ;;
    --print)
      PRINT_ONLY=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown option: $1"
      ;;
  esac
done

# Resolve defaults.
if [ -z "$NODE_BIN" ]; then
  NODE_BIN=$(command -v node 2>/dev/null || true)
  [ -n "$NODE_BIN" ] || die "could not find node on PATH; pass --node <absolute path>"
fi
case "$NODE_BIN" in
  /*) ;;
  *) die "--node must be an absolute path, got: $NODE_BIN" ;;
esac

if [ -z "$CHECKOUT" ]; then
  CHECKOUT=$(cd "$(dirname "$0")/.." && pwd -P)
else
  case "$CHECKOUT" in
    /*) ;;
    *)
      if [ -d "$CHECKOUT" ]; then
        CHECKOUT=$(cd "$CHECKOUT" && pwd -P)
      else
        CHECKOUT="$PWD/$CHECKOUT"
      fi
      ;;
  esac
fi
# Strip trailing slash unless root.
if [ "$CHECKOUT" != "/" ]; then
  CHECKOUT=${CHECKOUT%/}
fi

if [ -z "$SERVICE_PATH" ]; then
  SERVICE_PATH=$(default_service_path)
fi

case "$PORT" in
  ''|*[!0-9]*) die "--port must be an integer between 1 and 65535, got: $PORT" ;;
esac
if [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
  die "--port must be an integer between 1 and 65535, got: $PORT"
fi

[ -n "${HOME:-}" ] || die "HOME is not set"
case "$HOME" in
  /*) ;;
  *) die "HOME must be an absolute path, got: $HOME" ;;
esac

# Compute XDG_CONFIG_HOME once so the script and the launchd service always agree.
CONFIG_HOME=${XDG_CONFIG_HOME:-$HOME/.config}
case "$CONFIG_HOME" in
  /*) ;;
  *) die "XDG_CONFIG_HOME must be an absolute path, got: $CONFIG_HOME" ;;
esac

AGENTS_DIR="$HOME/Library/LaunchAgents"
PLIST_FILE="$AGENTS_DIR/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/houston"
LOG_FILE="$LOG_DIR/hub.log"
LAUNCHER="$CHECKOUT/bin/houston-web.mjs"
APP_CONFIG_DIR="$CONFIG_HOME/houston"
APP_CONFIG_FILE="$APP_CONFIG_DIR/config.json"

validate_xml_safe "--node" "$NODE_BIN"
validate_xml_safe "--checkout" "$CHECKOUT"
validate_xml_safe "--path" "$SERVICE_PATH"
validate_xml_safe "XDG_CONFIG_HOME" "$CONFIG_HOME"
validate_xml_safe "HOME" "$HOME"

render_plist() {
  cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$(xml_escape "$LABEL")</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml_escape "$NODE_BIN")</string>
    <string>$(xml_escape "$LAUNCHER")</string>
    <string>--no-open</string>
    <string>--port</string>
    <string>$(xml_escape "$PORT")</string>
    <string>--host</string>
    <string>$(xml_escape "$HOST")</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$(xml_escape "$SERVICE_PATH")</string>
    <key>XDG_CONFIG_HOME</key>
    <string>$(xml_escape "$CONFIG_HOME")</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$(xml_escape "$LOG_FILE")</string>
  <key>StandardErrorPath</key>
  <string>$(xml_escape "$LOG_FILE")</string>
</dict>
</plist>
EOF
}

if [ "$PRINT_ONLY" -eq 1 ]; then
  render_plist
  exit 0
fi

# Verify tools using the exact PATH the service will receive.
[ -x "$NODE_BIN" ] || die "node binary is not executable: $NODE_BIN"
PATH="$SERVICE_PATH" command -v br >/dev/null 2>&1 || die "br not found in service PATH: $SERVICE_PATH"
PATH="$SERVICE_PATH" command -v git >/dev/null 2>&1 || die "git not found in service PATH: $SERVICE_PATH"

mkdir -p "$AGENTS_DIR" "$LOG_DIR" "$APP_CONFIG_DIR"

# Seed an explicit empty project list so the hub does not auto-register its own checkout.
if [ ! -e "$APP_CONFIG_FILE" ]; then
  printf '{"projects":[]}\n' > "$APP_CONFIG_FILE"
fi

tmp_plist=$(mktemp "$AGENTS_DIR/.${LABEL}.plist.XXXXXX")
trap 'rm -f "$tmp_plist"' EXIT
render_plist > "$tmp_plist"
mv "$tmp_plist" "$PLIST_FILE"
trap - EXIT

uid=$(id -u)
launchctl bootout "gui/$uid/$LABEL" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$uid" "$PLIST_FILE"
