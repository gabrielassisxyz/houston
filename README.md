# Houston

A local, single-user web UI for [beads](https://github.com/gastownhall/beads) (`bd`) and
[beads_rust](https://github.com/Dicklesworthstone/beads_rust) (`br`) trackers. Create, edit,
organize, and triage work alongside coding agents while keeping each repository's `.beads/`
tracker as the single source of truth.

## Features

- **Board, List, Epics, and Focus** — Kanban columns (Backlog, Ready, In Progress, Blocked, Done),
  filterable list, epic progress tracking, and a Focus view with optional assignee grouping and
  recent completions.
- **All projects (`/all`) and Sprints (`/sprints`)** — Combined view across registered repositories
  and sprint planning backed by tracker labels.
- **Work dashboard (`/work`)** — Framed view of the local collector page configured through
  `workDashboardUrl`.
- **Dependencies and graph** — Typed dependencies in the detail drawer and an interactive React
  Flow dependency graph.
- **Human-vs-agent attribution** — Writes are stamped with the configured human actor
  (`BEADS_ACTOR`); human and agent entries are distinguished across cards, comments, and activity.
- **Needs You inbox** — Surfaces beads labelled `human` and (`bd` only) human-approval gates.
- **Read-only viewing** — Session-scoped viewer mode toggle in Settings and top banner, with
  `SCOTTY_READ_ONLY=1` for a read-only default.
- **Dual tracker support (`br` and `bd`)** — A project whose `.beads/` directory contains
  `beads.db` and no `embeddeddolt/` directory uses `br`; other projects use `bd`. Without a
  tracker, a built-in demo project lets you explore the UI.

## Prerequisites

- **Node.js 22.18+** and `npm` (Node 20 runs the built app; Node 22.18+ is required for the
  standalone TypeScript test scripts under `scripts/`).
- **`br`** (`beads_rust`) and/or **`bd`** on `PATH` (or pointed to via `BR_BIN` / `BD_BIN`), plus
  `git`.

## Build and run

```bash
git clone https://github.com/gabrielassisxyz/houston.git
cd houston
npm ci
npm run build
node bin/houston-web.mjs --no-open --port 3300
```

Open `http://127.0.0.1:3300` in your browser. Omit `--no-open` to open the browser automatically.
For development with hot reload, run `npm run dev`.

Useful launcher flags (`node bin/houston-web.mjs --help`):

- `-p, --port <n>` — Port to bind (default `3000`, or `$PORT`). Fails immediately if an explicit
  port is already in use.
- `--host <h>` — Host to bind (default `127.0.0.1`, or `$HOST`).
- `--no-open` — Print the URL without opening a browser.

## Configuration

Local settings live under `$XDG_CONFIG_HOME/houston/` (default `~/.config/houston/`):
`config.json` stores the registered projects, human actor, allowlist, and polling interval;
`sprints.json` stores sprint definitions. `workDashboardUrl` holds the work dashboard address
framed at `/work` (see [docs/work-side-setup.md](docs/work-side-setup.md)).

Environment variables:

- `BR_BIN` / `BD_BIN` — Explicit path to the `br` or `bd` binary.
- `BEADS_REPO` — Project directory containing `.beads/` to register on startup.
- `BEADS_DEMO=1` — Force the built-in in-memory demo dataset.
- `SCOTTY_READ_ONLY=1` — Default new browser sessions to read-only mode (a local viewing
  preference, not access control).
- `SCOTTY_LANE_PREFIX=ctx:` — Enable Focus-view lane filter chips for matching label prefixes.
- `SCOTTY_ALLOWED_HOSTS=host1,host2` — Allow browser access through a LAN hostname or reverse
  proxy. By default, Houston only answers `localhost`, `*.localhost`, and IP literals, and refuses
  cross-site writes.

## Running as a macOS login service

See [docs/work-side-setup.md](docs/work-side-setup.md) for installing Houston as a `launchd` user
agent with [scripts/install-services.sh](scripts/install-services.sh) and updating it with
[scripts/update.sh](scripts/update.sh).

## Project layout

```text
app/                  Next.js App Router pages and API route handlers
bin/houston-web.mjs   Production server launcher
components/           UI views (board, list, epics, focus, graph, sprints, settings)
design/               Original UI design notes and token mapping (design/design.md)
docs/                 Setup and operational documentation
hooks/                Client state and data hooks
lib/                  Tracker adapters (br.ts, bd.ts), store, schemas, request guard
scripts/              Service scripts and standalone verification scripts
```

## Verification

```bash
npm run lint
npm run build
```

See [AGENTS.md](AGENTS.md) for running the standalone test scripts under `scripts/`.

## Security

Please report vulnerabilities privately rather than opening a public issue. See
[SECURITY.md](SECURITY.md).

## Origin

Houston starts from [Bead Me Up, Scotty](https://github.com/brendan-appstart/bead-me-up-scotty)
(MIT licensed), imported from a `br`-enabled fork at commit `361da16` with the usage ping and
self-updater removed.

## License

[MIT](LICENSE). See [LICENSE](LICENSE) for copyright notices.
