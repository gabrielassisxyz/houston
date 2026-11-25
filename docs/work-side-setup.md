# macOS workstation setup

Instructions for cloning, building, running, and updating Houston as a `launchd` user agent on a
macOS workstation.

## Prerequisites

- **Node.js 22.18 or later** and `npm`. `npm ci` may print an `EBADDEVENGINES` warning on Node 22
  or 24; that warning is expected and harmless.
- **`br`** (`beads_rust`) installed and executable.
- **`git`** installed and executable.
- **Go 1.26 or later** for the notes service. The first notes build downloads the module's
  dependencies through the Go module proxy, so it needs network access once.

Verify all four before cloning:

```bash
node --version
br --version
git --version
go version
```

## Clone and build

```bash
git clone https://github.com/gabrielassisxyz/houston.git
cd houston
npm ci
npm run build
```

## Install the login service

Run [scripts/install-services.sh](../scripts/install-services.sh) from the checkout to install and
start the `houston.hub` launchd agent:

```bash
scripts/install-services.sh
```

What the script does:

- Resolves `node` as found on `PATH` (without following symlinks, so package-manager upgrades do
  not invalidate the plist path) and refuses relative `--node` paths.
- Builds the service `PATH` from the directories of `br` and `git` plus standard system paths, and
  checks that `br` and `git` resolve through that service `PATH`.
- Computes `XDG_CONFIG_HOME` once (`${XDG_CONFIG_HOME:-$HOME/.config}`) and writes the same value
  into the plist so the script and the service share one config directory.
- Creates `$HOME/Library/LaunchAgents`, `$HOME/Library/Logs/houston`, and
  `$XDG_CONFIG_HOME/houston`.
- Seeds `$XDG_CONFIG_HOME/houston/config.json` with `{"projects":[]}` if it does not already
  exist, so the hub does not auto-register its own checkout as a project.
- Writes `$HOME/Library/LaunchAgents/houston.hub.plist` to run
  `bin/houston-web.mjs --no-open --port 3300 --host 127.0.0.1`, logs to
  `$HOME/Library/Logs/houston/hub.log`, and loads it with `launchctl bootout` followed by
  `launchctl bootstrap`.

Optional flags:

- `--node <absolute-path>` — Override the Node binary path.
- `--checkout <dir>` — Override the checkout directory.
- `--path <PATH>` — Override the `PATH` given to the service.
- `--port <port>` — Override the default port (`3300`).
- `--print` — Print the generated plist to stdout without touching disk or checking tools.

Re-running `scripts/install-services.sh` is idempotent and preserves an existing `config.json`.

### Verify the service

```bash
launchctl print "gui/$(id -u)/houston.hub"
```

Open `http://127.0.0.1:3300` in your browser. Before registering any repository, only the built-in
Demo project appears (not the Houston checkout itself).

To test a clean restart and verify the child process is replaced:

```bash
launchctl kickstart -k "gui/$(id -u)/houston.hub"
launchctl print "gui/$(id -u)/houston.hub"
```

Confirm that the reported PID changes and the app answers again on `http://127.0.0.1:3300`.

## Notes service

The notes service indexes the work vault and serves it over loopback on `127.0.0.1`. One install
command builds it from this checkout and installs it as the `houston.notes` login agent beside
`houston.hub`, with its vault, database, port and a raised open-file limit (macOS holds one
kqueue descriptor per note against a default soft limit of 256).

### First run

1. Commit the vault's git working tree so the first index starts from a clean state.
2. Build once and run the preflight check:
   ```bash
   cd notes
   go build -o bin/houston ./cmd/houston
   HOUSTON_VAULT=/path/to/vault bin/houston preflight
   ```
   Fix every error the preflight reports before continuing.
3. Install both agents from the checkout:
   ```bash
   scripts/install-services.sh --notes-vault /path/to/vault
   ```
   Optional flags: `--notes-db <absolute path>` (default
   `${XDG_STATE_HOME:-$HOME/.local/state}/houston/notes.db`) and
   `--notes-port <n>` (default `3301`). The script builds `notes/bin/houston` from the
   checkout's own Go module, boots `houston.notes` out before rebuilding, writes
   `$HOME/Library/LaunchAgents/houston.notes.plist` to run
   `notes/bin/houston serve` with `HOUSTON_VAULT`, `HOUSTON_DB`,
   `HOUSTON_ADDR=127.0.0.1:<port>`, `XDG_CONFIG_HOME` and a `PATH`, logs to
   `$HOME/Library/Logs/houston/notes.log`, sets `RunAtLoad` and `KeepAlive`, and raises the
   open-file limit (`16384` soft, `65536` hard `NumberOfFiles`).
4. Set `notesServiceUrl` (`http://127.0.0.1:3301/`) and `obsidianVault` through
   `PUT /api/config`, never by editing `config.json` while the hub runs, which it caches.
5. Review the id injection as one commit.
6. Keep the vault folder fully downloaded in the sync client so the watcher sees every note.
7. Check the process's open-file limit covers the vault.
8. Updates go through `scripts/update.sh`, which rebuilds the notes binary and restarts
   `houston.notes` beside the hub.

Re-running `scripts/install-services.sh --notes-vault <dir>` is idempotent. Uninstalling only
the notes agent is `launchctl bootout gui/$(id -u)/houston.notes` plus removing
`~/Library/LaunchAgents/houston.notes.plist`; the hub agent is untouched.

## Updating

Run [scripts/update.sh](../scripts/update.sh) from anywhere:

```bash
scripts/update.sh
```

The script unloads `houston.hub`, runs `git pull --ff-only`, `npm ci`, and `npm run build`, and
loads the service again. Keeping the service unloaded during `npm ci` and `npm run build` prevents
`launchd` from restarting the app against a half-rebuilt directory. If a step fails, the script
stops, prints which step failed, and leaves the service unloaded; fix the issue and re-run
`scripts/update.sh` to resume.

## Operational rules

- **Always use `127.0.0.1`, never `localhost`.** Address Houston and any sibling local service by
  `127.0.0.1` so loopback requests stay on one origin family and avoid IPv6/IPv4 fallback delays.
- **Give every work repository its own tracker prefix.** Initialize each repository's tracker with
  a distinct prefix (`br init --prefix <short-id>`) so bead IDs stay unambiguous across projects.
- **Register projects through the app, not by editing `config.json` while it runs.** The server
  reads `config.json` once at startup and caches it in memory; use the project picker in the UI to
  add or remove repositories.
- **Restart the service through `launchctl`, never with `kill -9`.** Sending an uncatchable
  signal to `bin/houston-web.mjs` terminates the launcher without forwarding shutdown to its
  `next start` child, leaving the child holding the port. Always use
  `launchctl kickstart -k "gui/$(id -u)/houston.hub"` (or `bootout`/`bootstrap`).
