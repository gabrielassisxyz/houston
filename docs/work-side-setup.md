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

## Work dashboard

Houston frames the work dashboard, a page served by a local collector program on the work machine,
at the route `/work`. The collector's address is stored in `config.json` as `workDashboardUrl`.

### Address rules

`workDashboardUrl` must be an `http` or `https` address on exactly `127.0.0.1`
(`http://127.0.0.1:8000/` is valid; `localhost`, `::1`, `127.0.0.2` and any other host are
refused), with no credentials, no query and no fragment. The stored value is the parser's
normalised address, so a bare host and port gains a trailing slash. An invalid value on disk is
ignored with a warning; an invalid value in `PUT /api/config` is refused with `invalid_config`.

### Where the file lives

The hub reads `$XDG_CONFIG_HOME/houston/config.json` (default `~/.config/houston/config.json`)
once at startup. That directory is the same `XDG_CONFIG_HOME` value the service definition pins:
the plist written by [scripts/install-services.sh](../scripts/install-services.sh) sets
`XDG_CONFIG_HOME` in `EnvironmentVariables`, and the script computes it once from
`${XDG_CONFIG_HOME:-$HOME/.config}`.

### Set and clear it

While Houston runs, send only `workDashboardUrl` to the config route:

```bash
curl -X PUT http://127.0.0.1:3300/api/config \
  -H 'Content-Type: application/json' \
  -d '{"workDashboardUrl": "http://127.0.0.1:8000/"}'
```

Clear it the same way:

```bash
curl -X PUT http://127.0.0.1:3300/api/config \
  -H 'Content-Type: application/json' \
  -d '{"workDashboardUrl": ""}'
```

An empty string removes the key, exactly like `null` does. Any other field sent alongside is
applied as well, so send only this one key when that is all that should change.

Or stop the service first and edit the file. Unload it with
`launchctl bootout "gui/$(id -u)/houston.hub"`, never `kill` or `launchctl stop`, which
`KeepAlive` undoes at once by restarting a stopped service. Edit the existing JSON object without
replacing the other fields, then load it again with
`launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/houston.hub.plist"`. The file
is read once and is not edited while the service runs, as the operational rules below say.

### When the collector is not running

`/work` probes the configured address with `POST /api/work/probe` and keeps the frame unmounted
until the probe answers. When nothing answers there it shows
`O painel do trabalho não respondeu em <address>.` with the hint
`Inicie o servidor do collector e tente de novo.` and a `Tentar de novo` button that probes
again. When no address is configured it shows `O painel do trabalho não está configurado.` and
names `workDashboardUrl` with a restart of Houston.

### Collector over https with a keychain-only certificate

When the collector serves `https` with a certificate only the macOS keychain trusts and `/work`
says the dashboard is not answering, teach the hub's Node to trust the system store. Add
`NODE_EXTRA_CA_CERTS` or `NODE_OPTIONS=--use-system-ca` to the plist's `EnvironmentVariables`,
never a bare flag in `ProgramArguments`, which `bin/houston-web.mjs` does not pass on to
`next start`. Check the edited plist with `plutil -lint`, then reload it with `bootout` followed
by `bootstrap`. Re-running `scripts/install-services.sh` rewrites the plist and drops the edit,
so keep the change outside the installer.

### Collector refuses to be framed

When the frame stays blank or shows a refusal (a `403`, say), the collector's own server refuses
to be framed. `X-Frame-Options` cannot name one allowed origin (its values are `DENY` and
`SAMEORIGIN`), so an origin-specific allowance is a
`Content-Security-Policy: frame-ancestors http://127.0.0.1:3300` on that document's response,
with `X-Frame-Options` removed for it. A check on the request's fetch-metadata headers is relaxed
the same way, for that document load only.

## Chain: stories, tickets and the delivery pipeline

Houston ties a bead to the work-tracker story or ticket its `external_ref` names, to the epic it
sits under or the beads under it, and to the delivery pipeline of its project's repository. The
read routes and every answer shape are described in [chain.md](chain.md); this section is only
the setup that feeds them.

### The three chain keys

Three global keys live beside `workDashboardUrl` in `config.json`:

- `snapshotPath`: the absolute path of the snapshot file, starting with `/`, with no control
  characters and no surrounding whitespace (for example `/path/to/snapshot.json`).
- `serviceNowHost`: the bare ticket host name (for example `example.com`): at least two
  dot-separated lowercase labels, letters and digits with hyphens only inside, the last label
  holding at least one letter, and no scheme, port, path, query, fragment or user information.
- `githubOrgs`: the list of lowercase GitHub owner names pipeline links may be built for (for
  example `["org"]`); an empty list is valid and stored.

Set them while Houston runs by sending only those keys to the config route:

```bash
curl -X PUT http://127.0.0.1:3300/api/config \
  -H 'Content-Type: application/json' \
  -d '{"snapshotPath": "/path/to/snapshot.json", "serviceNowHost": "example.com", "githubOrgs": ["org"]}'
```

An invalid value is refused with `invalid_config`; an invalid value found on disk at startup is
ignored with a warning, exactly like `workDashboardUrl`. Clear a string key the same way with an
empty string (`""`), which removes it like `null` does; clear the owner list with `null`. Any
other field sent alongside is applied as well, so send only these keys when that is all that
should change.

Or stop the service first and edit the file, as the work-dashboard section above says:
`launchctl bootout`, edit the existing JSON object without replacing the other fields,
`launchctl bootstrap`. Setting `snapshotPath` also turns the chain on: the capabilities answer
reports it, and the chain UI reads through it.

### The snapshot file

A local collector program on the work machine writes the snapshot file Houston reads at
`snapshotPath`. The file is JSON with `schema_version` 1 and a `sources` object: the ticket
sources (`incidents`, `changes`, `work_tracker_stories`, `work_tracker_bugs`,
`work_tracker_tasks`, `work_tracker_subtasks`, `ritms`), plus `approvals` and `pipeline`.
Houston reads the configured path on demand and parses it again only when the file changed; when
the path is unset or the file cannot be read, the chain answers carry the reason instead of
tracker and pipeline data. Point `snapshotPath` at the absolute path where the collector writes
that file.

### References on beads

An epic carries the story number as its reference (for example `STRY00000001`); any other bead
carries its task or bug number (for example `INC00000001`, `CHG00000001`). The reference is typed
in the bead drawer, trimmed and matched without regard to case, at most 128 characters and with
no control characters. The same reference cannot sit on two beads of one repository: `br`
refuses the second write.

### The pipeline repository

Each project names at most one pipeline repository as `owner/name` in lowercase (for example
`org/repo-a`), kept on the project entry rather than in the global keys. Set it in Settings, in
the project card's pipeline field, or through `PATCH /api/projects/[id]` with
`{"pipelineRepo": "org/repo-a"}`. Saving an empty string clears it. Only a project that names
one carries a pipeline part, built from the snapshot's pipeline records for that repository.

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

### Daily backup

Pass `--notes-backup-dir <absolute path>` alongside `--notes-vault` to install a third agent,
`houston.notes-backup`, which copies the database once a day at noon (and at the next wake or
login when the machine was asleep or off at noon) into `<dir>/houston-backup` as
`notes-YYYY-MM-DD.db`, keeping the seven most recent copies. The directory must not equal or lie
inside the vault. `--print-notes-backup` prints the backup plist without touching disk, and
requires `--notes-vault` and `--notes-backup-dir`.

The database lives outside the vault so its live file and write-ahead log never ride the sync;
the backup agent instead copies it with `VACUUM INTO` (see
[scripts/notes-backup.sh](../scripts/notes-backup.sh)), which writes one closed file in `delete`
journal mode while the service keeps running. That single file is safe to sync, while the live
file and its `-wal`/`-shm` companions are not. Seven copies are kept: enough history to recover
from a bad day without filling the synced folder. The copies are the only place holding the notes
revision history; a fresh index of the vault rebuilds everything else in the database, since the
service writes no pin or link-suggestion state.

To restore a copy, stop the notes agent, remove the `-wal` and `-shm` files beside the database,
copy the backup over the database path, and start the agent again:

```bash
launchctl bootout "gui/$(id -u)/houston.notes"
rm -f /path/to/notes.db-wal /path/to/notes.db-shm
cp "/path/to/backups/houston-backup/notes-YYYY-MM-DD.db" /path/to/notes.db
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/houston.notes.plist
```

Uninstalling the backup agent is `launchctl bootout gui/$(id -u)/houston.notes-backup` plus
removing `~/Library/LaunchAgents/houston.notes-backup.plist`; the copies already in the folder
are plain files and stay.

## Updating

Run [scripts/update.sh](../scripts/update.sh) from the checkout, or by its absolute path:

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
