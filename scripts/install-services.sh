#!/usr/bin/env bash
# Install (or print) the macOS launchd user agents for the Houston hub and notes service.
#
# Usage:
#   scripts/install-services.sh [--node <path>] [--checkout <dir>]
#                               [--path <PATH>] [--port <n>] [--print]
#                               [--notes-vault <dir>] [--notes-db <path>]
#                               [--notes-port <n>] [--print-notes]
#                               [--notes-backup-dir <dir>] [--print-notes-backup]
set -euo pipefail

LABEL="houston.hub"
NOTES_LABEL="houston.notes"
BACKUP_LABEL="houston.notes-backup"
BACKUP_SERVICE_PATH="/usr/bin:/bin:/usr/sbin:/sbin"
HOST="127.0.0.1"
PORT="3300"
NOTES_PORT="3301"
NODE_BIN=""
CHECKOUT=""
SERVICE_PATH=""
PRINT_ONLY=0
PRINT_NOTES_ONLY=0
PRINT_BACKUP_ONLY=0
NOTES_VAULT=""
NOTES_DB=""
NOTES_DB_SET=0
NOTES_PORT_SET=0
NOTES_BACKUP_DIR=""
NOTES_BACKUP_DIR_SET=0

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
  --notes-vault <dir>  Absolute path to the notes vault directory. Enables the
                     `houston.notes` agent.
  --notes-db <path>  Absolute path to the notes database file (default:
                     `${XDG_STATE_HOME:-$HOME/.local/state}/houston/notes.db`).
                     Requires --notes-vault.
   --notes-port <n>  Port for the notes service on 127.0.0.1 (default: 3301).
                     Requires --notes-vault.
  --print-notes      Print the `houston.notes` plist to stdout without touching
                     disk or checking tools. Requires --notes-vault.
  --notes-backup-dir <dir>  Absolute path to the synced folder holding the
                      notes database backups. Enables the
                      `houston.notes-backup` agent. Requires --notes-vault,
                      and must not equal or lie inside --notes-vault.
  --print-notes-backup  Print the `houston.notes-backup` plist to stdout
                      without touching disk or checking tools. Requires
                      --notes-vault and --notes-backup-dir.
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
  s=${s//&/\&amp;}
  s=${s//</\&lt;}
  s=${s//>/\&gt;}
  s=${s//\"/\&quot;}
  s=${s//\'/\&apos;}
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

# Lexical path normalisation, in the shell: collapse repeated slashes, strip a
# trailing slash (unless root), resolve "." and ".." by path components. macOS
# realpath has no -m and fails on paths that do not exist yet, so do it here.
normalize_path() {
  local p=$1
  while [[ "$p" == *"//"* ]]; do
    p=${p//\/\//\/}
  done
  if [[ "$p" != "/" ]]; then
    p=${p%/}
  fi
  local out=""
  local rest="$p"
  local comp
  while [[ -n "$rest" ]]; do
    rest=${rest#/}
    if [[ -z "$rest" ]]; then
      break
    fi
    if [[ "$rest" == *"/"* ]]; then
      comp=${rest%%/*}
      rest=/${rest#*/}
    else
      comp="$rest"
      rest=""
    fi
    case "$comp" in
      ''|.) continue ;;
      ..)
        if [[ -n "$out" ]]; then
          out=${out%/*}
        fi
        ;;
      *)
        out="$out/$comp"
        ;;
    esac
  done
  if [[ -z "$out" ]]; then
    out="/"
  fi
  printf '%s' "$out"
}

# Return 0 when the normalised db path equals the normalised vault or lies
# inside it, compared by path components so a sibling like /vault-db beside
# /vault passes.
notes_db_inside_vault() {
  local vault=$1
  local db=$2
  if [ "$db" = "$vault" ]; then
    return 0
  fi
  if [ "$vault" = "/" ]; then
    return 0
  fi
  local prefix="$vault/"
  if [ "${db:0:${#prefix}}" = "$prefix" ]; then
    return 0
  fi
  return 1
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
    --notes-vault)
      [ "$#" -ge 2 ] || die "--notes-vault requires a value"
      NOTES_VAULT=$2
      shift 2
      ;;
    --notes-vault=*)
      NOTES_VAULT=${1#--notes-vault=}
      shift
      ;;
    --notes-db)
      [ "$#" -ge 2 ] || die "--notes-db requires a value"
      NOTES_DB=$2
      NOTES_DB_SET=1
      shift 2
      ;;
    --notes-db=*)
      NOTES_DB=${1#--notes-db=}
      NOTES_DB_SET=1
      shift
      ;;
    --notes-port)
      [ "$#" -ge 2 ] || die "--notes-port requires a value"
      NOTES_PORT=$2
      NOTES_PORT_SET=1
      shift 2
      ;;
    --notes-port=*)
      NOTES_PORT=${1#--notes-port=}
      NOTES_PORT_SET=1
      shift
      ;;
    --print)
      PRINT_ONLY=1
      shift
      ;;
    --print-notes)
      PRINT_NOTES_ONLY=1
      shift
      ;;
    --notes-backup-dir)
      [ "$#" -ge 2 ] || die "--notes-backup-dir requires a value"
      NOTES_BACKUP_DIR=$2
      NOTES_BACKUP_DIR_SET=1
      shift 2
      ;;
    --notes-backup-dir=*)
      NOTES_BACKUP_DIR=${1#--notes-backup-dir=}
      NOTES_BACKUP_DIR_SET=1
      shift
      ;;
    --print-notes-backup)
      PRINT_BACKUP_ONLY=1
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

# Mutually exclusive print modes and notes requirements.
if [ "$PRINT_ONLY" -eq 1 ] && [ "$PRINT_NOTES_ONLY" -eq 1 ]; then
  die "--print and --print-notes cannot be combined"
fi
if [ "$PRINT_ONLY" -eq 1 ] && [ "$PRINT_BACKUP_ONLY" -eq 1 ]; then
  die "--print and --print-notes-backup cannot be combined"
fi
if [ "$PRINT_NOTES_ONLY" -eq 1 ] && [ "$PRINT_BACKUP_ONLY" -eq 1 ]; then
  die "--print-notes and --print-notes-backup cannot be combined"
fi
if [ "$NOTES_DB_SET" -eq 1 ] && [ -z "$NOTES_VAULT" ]; then
  die "--notes-db requires --notes-vault"
fi
if [ "$NOTES_PORT_SET" -eq 1 ] && [ -z "$NOTES_VAULT" ]; then
  die "--notes-port requires --notes-vault"
fi
if [ "$NOTES_BACKUP_DIR_SET" -eq 1 ] && [ -z "$NOTES_VAULT" ]; then
  die "--notes-backup-dir requires --notes-vault"
fi
if [ "$PRINT_NOTES_ONLY" -eq 1 ] && [ -z "$NOTES_VAULT" ]; then
  die "--print-notes requires --notes-vault"
fi
if [ "$PRINT_BACKUP_ONLY" -eq 1 ] && [ -z "$NOTES_VAULT" ]; then
  die "--print-notes-backup requires --notes-vault"
fi
if [ "$PRINT_BACKUP_ONLY" -eq 1 ] && [ -z "$NOTES_BACKUP_DIR" ]; then
  die "--print-notes-backup requires --notes-backup-dir"
fi

# Resolve defaults. --print-notes and --print-notes-backup need no --node,
# so skip the node default and its absolute-path check in those modes; neither
# document uses it.
if [ "$PRINT_NOTES_ONLY" -eq 0 ] && [ "$PRINT_BACKUP_ONLY" -eq 0 ]; then
  if [ -z "$NODE_BIN" ]; then
    NODE_BIN=$(command -v node 2>/dev/null || true)
    [ -n "$NODE_BIN" ] || die "could not find node on PATH; pass --node <absolute path>"
  fi
  case "$NODE_BIN" in
    /*) ;;
    *) die "--node must be an absolute path, got: $NODE_BIN" ;;
  esac
fi

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

NOTES_ENABLED=0
if [ -n "$NOTES_VAULT" ]; then
  NOTES_ENABLED=1
fi

if [ "$NOTES_ENABLED" -eq 1 ]; then
  case "$NOTES_VAULT" in
    /*) ;;
    *) die "--notes-vault must be an absolute path, got: $NOTES_VAULT" ;;
  esac
  if [ "$NOTES_DB_SET" -eq 0 ]; then
    STATE_HOME=${XDG_STATE_HOME:-$HOME/.local/state}
    case "$STATE_HOME" in
      /*) ;;
      *) die "XDG_STATE_HOME must be an absolute path, got: $STATE_HOME" ;;
    esac
    validate_xml_safe "XDG_STATE_HOME" "$STATE_HOME"
    if [ "$STATE_HOME" != "/" ]; then
      STATE_HOME=${STATE_HOME%/}
    fi
    NOTES_DB="$STATE_HOME/houston/notes.db"
  fi
  case "$NOTES_DB" in
    /*) ;;
    *) die "--notes-db must be an absolute path, got: $NOTES_DB" ;;
  esac
  case "$NOTES_PORT" in
    ''|*[!0-9]*) die "--notes-port must be an integer between 1 and 65535, got: $NOTES_PORT" ;;
  esac
  if [ "$NOTES_PORT" -lt 1 ] || [ "$NOTES_PORT" -gt 65535 ]; then
    die "--notes-port must be an integer between 1 and 65535, got: $NOTES_PORT"
  fi
  if [ "$NOTES_PORT" -eq "$PORT" ]; then
    die "--notes-port must not equal --port, got: $NOTES_PORT"
  fi
  norm_vault=$(normalize_path "$NOTES_VAULT")
  norm_db=$(normalize_path "$NOTES_DB")
  if notes_db_inside_vault "$norm_vault" "$norm_db"; then
    die "--notes-db must not equal or lie inside --notes-vault, got: $NOTES_DB"
  fi
  if [ "$NOTES_BACKUP_DIR_SET" -eq 1 ]; then
    case "$NOTES_BACKUP_DIR" in
      /*) ;;
      *) die "--notes-backup-dir must be an absolute path, got: $NOTES_BACKUP_DIR" ;;
    esac
    norm_backup=$(normalize_path "$NOTES_BACKUP_DIR")
    if notes_db_inside_vault "$norm_vault" "$norm_backup"; then
      die "--notes-backup-dir must not equal or lie inside --notes-vault, got: $NOTES_BACKUP_DIR"
    fi
  fi
fi

BACKUP_ENABLED=0
if [ "$NOTES_BACKUP_DIR_SET" -eq 1 ]; then
  BACKUP_ENABLED=1
fi

AGENTS_DIR="$HOME/Library/LaunchAgents"
PLIST_FILE="$AGENTS_DIR/$LABEL.plist"
NOTES_PLIST_FILE="$AGENTS_DIR/$NOTES_LABEL.plist"
BACKUP_PLIST_FILE="$AGENTS_DIR/$BACKUP_LABEL.plist"
LOG_DIR="$HOME/Library/Logs/houston"
LOG_FILE="$LOG_DIR/hub.log"
NOTES_LOG_FILE="$LOG_DIR/notes.log"
BACKUP_LOG_FILE="$LOG_DIR/notes-backup.log"
LAUNCHER="$CHECKOUT/bin/houston-web.mjs"
NOTES_BIN="$CHECKOUT/notes/bin/houston"
BACKUP_SCRIPT="$CHECKOUT/scripts/notes-backup.sh"
APP_CONFIG_DIR="$CONFIG_HOME/houston"
APP_CONFIG_FILE="$APP_CONFIG_DIR/config.json"

if [ "$PRINT_NOTES_ONLY" -eq 0 ]; then
  validate_xml_safe "--node" "$NODE_BIN"
fi
validate_xml_safe "--checkout" "$CHECKOUT"
validate_xml_safe "--path" "$SERVICE_PATH"
validate_xml_safe "XDG_CONFIG_HOME" "$CONFIG_HOME"
validate_xml_safe "HOME" "$HOME"
if [ "$NOTES_ENABLED" -eq 1 ]; then
  validate_xml_safe "--notes-vault" "$NOTES_VAULT"
  validate_xml_safe "--notes-db" "$NOTES_DB"
  validate_xml_safe "--notes-port" "$NOTES_PORT"
fi
if [ "$BACKUP_ENABLED" -eq 1 ]; then
  validate_xml_safe "--notes-backup-dir" "$NOTES_BACKUP_DIR"
fi

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

render_notes_plist() {
  local notes_addr="127.0.0.1:$NOTES_PORT"
  cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$(xml_escape "$NOTES_LABEL")</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml_escape "$NOTES_BIN")</string>
    <string>serve</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOUSTON_VAULT</key>
    <string>$(xml_escape "$NOTES_VAULT")</string>
    <key>HOUSTON_DB</key>
    <string>$(xml_escape "$NOTES_DB")</string>
    <key>HOUSTON_ADDR</key>
    <string>$(xml_escape "$notes_addr")</string>
    <key>XDG_CONFIG_HOME</key>
    <string>$(xml_escape "$CONFIG_HOME")</string>
    <key>PATH</key>
    <string>$(xml_escape "$SERVICE_PATH")</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>SoftResourceLimits</key>
  <dict>
    <key>NumberOfFiles</key>
    <integer>16384</integer>
  </dict>
  <key>HardResourceLimits</key>
  <dict>
    <key>NumberOfFiles</key>
    <integer>65536</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>$(xml_escape "$NOTES_LOG_FILE")</string>
  <key>StandardErrorPath</key>
  <string>$(xml_escape "$NOTES_LOG_FILE")</string>
</dict>
</plist>
EOF
}

render_backup_plist() {
  cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$(xml_escape "$BACKUP_LABEL")</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$(xml_escape "$BACKUP_SCRIPT")</string>
    <string>$(xml_escape "$NOTES_DB")</string>
    <string>$(xml_escape "$NOTES_BACKUP_DIR")</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$(xml_escape "$BACKUP_SERVICE_PATH")</string>
  </dict>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>12</integer>
    <key>Minute</key>
    <integer>0</integer>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$(xml_escape "$BACKUP_LOG_FILE")</string>
  <key>StandardErrorPath</key>
  <string>$(xml_escape "$BACKUP_LOG_FILE")</string>
</dict>
</plist>
EOF
}

if [ "$PRINT_ONLY" -eq 1 ]; then
  render_plist
  exit 0
fi

if [ "$PRINT_NOTES_ONLY" -eq 1 ]; then
  render_notes_plist
  exit 0
fi

if [ "$PRINT_BACKUP_ONLY" -eq 1 ]; then
  render_backup_plist
  exit 0
fi

# Whether the vault is a directory is checked only after --print-notes has had
# its chance to exit, as --node is, so the document renders on Linux with
# synthetic paths. The backup directory is checked only after
# --print-notes-backup has had its chance to exit, for the same reason.
if [ "$NOTES_ENABLED" -eq 1 ]; then
  [ -d "$NOTES_VAULT" ] || die "--notes-vault is not a directory: $NOTES_VAULT"
fi
if [ "$BACKUP_ENABLED" -eq 1 ]; then
  [ -d "$NOTES_BACKUP_DIR" ] || die "--notes-backup-dir is not a directory: $NOTES_BACKUP_DIR"
fi

# Verify tools using the exact PATH the service will receive.
[ -n "$NODE_BIN" ] || die "could not find node on PATH; pass --node <absolute path>"
[ -x "$NODE_BIN" ] || die "node binary is not executable: $NODE_BIN"
PATH="$SERVICE_PATH" command -v br >/dev/null 2>&1 || die "br not found in service PATH: $SERVICE_PATH"
PATH="$SERVICE_PATH" command -v git >/dev/null 2>&1 || die "git not found in service PATH: $SERVICE_PATH"
if [ "$NOTES_ENABLED" -eq 1 ]; then
  command -v go >/dev/null 2>&1 || die "go not found on PATH; install Go 1.26 or later (https://go.dev/dl/) and ensure go is on PATH"
fi
if [ "$BACKUP_ENABLED" -eq 1 ]; then
  PATH="$BACKUP_SERVICE_PATH" command -v sqlite3 >/dev/null 2>&1 || die "sqlite3 not found in backup service PATH ($BACKUP_SERVICE_PATH); install sqlite3 so /usr/bin/sqlite3 exists"
fi

mkdir -p "$AGENTS_DIR" "$LOG_DIR" "$APP_CONFIG_DIR"
if [ "$NOTES_ENABLED" -eq 1 ]; then
  mkdir -p "$CHECKOUT/notes/bin"
fi

# Seed an explicit empty project list so the hub does not auto-register its own checkout.
if [ ! -e "$APP_CONFIG_FILE" ]; then
  printf '{"projects":[]}\n' > "$APP_CONFIG_FILE"
fi

tmp_plist=$(mktemp "$AGENTS_DIR/.${LABEL}.plist.XXXXXX")
trap 'rm -f "$tmp_plist"' EXIT
if [ "$NOTES_ENABLED" -eq 1 ]; then
  tmp_notes_plist=$(mktemp "$AGENTS_DIR/.${NOTES_LABEL}.plist.XXXXXX")
  trap 'rm -f "$tmp_plist" "$tmp_notes_plist"' EXIT
fi
if [ "$BACKUP_ENABLED" -eq 1 ]; then
  tmp_backup_plist=$(mktemp "$AGENTS_DIR/.${BACKUP_LABEL}.plist.XXXXXX")
  if [ "$NOTES_ENABLED" -eq 1 ]; then
    trap 'rm -f "$tmp_plist" "$tmp_notes_plist" "$tmp_backup_plist"' EXIT
  else
    trap 'rm -f "$tmp_plist" "$tmp_backup_plist"' EXIT
  fi
fi
render_plist > "$tmp_plist"
mv "$tmp_plist" "$PLIST_FILE"
if [ "$NOTES_ENABLED" -eq 1 ]; then
  render_notes_plist > "$tmp_notes_plist"
  mv "$tmp_notes_plist" "$NOTES_PLIST_FILE"
fi
if [ "$BACKUP_ENABLED" -eq 1 ]; then
  render_backup_plist > "$tmp_backup_plist"
  mv "$tmp_backup_plist" "$BACKUP_PLIST_FILE"
fi
trap - EXIT

uid=$(id -u)
launchctl bootout "gui/$uid/$LABEL" >/dev/null 2>&1 || true
if [ "$NOTES_ENABLED" -eq 1 ]; then
  launchctl bootout "gui/$uid/$NOTES_LABEL" >/dev/null 2>&1 || true
fi
if [ "$BACKUP_ENABLED" -eq 1 ]; then
  launchctl bootout "gui/$uid/$BACKUP_LABEL" >/dev/null 2>&1 || true
fi

if [ "$NOTES_ENABLED" -eq 1 ]; then
  (cd "$CHECKOUT/notes" && go build -o "$NOTES_BIN" ./cmd/houston)
fi

launchctl bootstrap "gui/$uid" "$PLIST_FILE"
if [ "$NOTES_ENABLED" -eq 1 ]; then
  launchctl bootstrap "gui/$uid" "$NOTES_PLIST_FILE"
fi
if [ "$BACKUP_ENABLED" -eq 1 ]; then
  launchctl bootstrap "gui/$uid" "$BACKUP_PLIST_FILE"
fi
