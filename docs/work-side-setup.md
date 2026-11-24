# macOS workstation setup

Instructions for cloning, building, running, and updating Houston as a `launchd` user agent on a
macOS workstation.

## Prerequisites

- **Node.js 22.18 or later** and `npm`. `npm ci` may print an `EBADDEVENGINES` warning on Node 22
  or 24; that warning is expected and harmless.
- **`br`** (`beads_rust`) installed and executable.
- **`git`** installed and executable.

Verify all three before cloning:

```bash
node --version
br --version
git --version
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
