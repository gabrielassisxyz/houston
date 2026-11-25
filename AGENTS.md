<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

<!-- This section is project-owned. -->
# Issue tracking: br, versioned with the code

This repository tracks its own work with **br**
([beads_rust](https://github.com/Dicklesworthstone/beads_rust)), not with `bd`.

- The tracker lives in `.beads/` of the main working tree, using the prefix `hou`.
  `issues.jsonl` is committed and is the copy that travels with the code. The SQLite database
  beside it is local: `.beads/.gitignore` keeps it out of git, and `br` rebuilds it from the
  JSONL in a fresh clone.
- **Every linked worktree shares that one tracker.** `br` run from a worktree reads and writes
  the main tree's database, not the copy of `.beads/` checked out in the worktree (`br where`
  shows it). So a claim made anywhere is visible everywhere at once.
- **A bead change is a repository change, and it shows up in the main tree.** Creating, claiming,
  editing or closing a bead rewrites `.beads/issues.jsonl` there, which leaves that one file
  modified in the main working tree. It is the single exception to keeping the main tree clean.
  It reaches git with the next landing, described below.
- Find work with `br ready --unassigned`, read it with `br show <id>`, take it with
  `br update <id> --claim` at the moment work starts, and close it with
  `br close <id> --reason "<what was done>"` once its acceptance criteria are met.
- `br` refuses to claim or close a bead whose blocker is still open. Close the blocker first. Do
  not pass `--force`.

**Why this section says so much about one tool:** the app in this repository reads `bd` trackers
as well as `br` ones, so `bd` appears all over the code and the README. That is about the
projects the app can display. This repository's own work is tracked with `br` only, and no
session hook is involved: the instructions above are all an agent needs.

<!-- This section is project-owned. -->
# Landing work: the agent merges its own pull requests

Work reaches `main` through a pull request from a branch in its own worktree, in atomic
Conventional Commits, and nobody waits for a human to press merge. The agent that did the work
reviews it and merges it. The pull request body is still written, because it is where the *why*
survives.

- **The gate is local, because this repository has no CI.** For a change that touches code or
  tests: `npm run lint` and `npm run build` pass on the branch, and every test script under
  `scripts/` that the change adds or touches passes, including the ones that need an isolated
  server. A change that touches `notes/` or `scripts/check-notes-deps.sh` also passes the Go
  gate in the notes-module section below. A code change whose gate was not run is not
  mergeable, however it looks.
- **Review before merging.** The grant replaces waiting, not reviewing. Read the diff against the
  bead's acceptance criteria, and break each new test's guard on purpose once to watch it fail.
- **The bead closes with its landing.** Bring the branch up to date with `main` first, by merging
  `main` in and never by rebasing. Run `br close <id> --reason "<what was done>"`, then copy the
  main tree's `.beads/issues.jsonl` over the one in the branch's worktree, commit it there, and
  push. The close then lands in the same merge as the code, along with every other bead change
  made since the last landing. Land one branch at a time, so two landings never carry
  different copies of that file.
- Merge with `gh pr merge <n> --merge`, as a command of its own. Then, in the main tree: the
  modified `issues.jsonl` blocks the pull, and it is derived from the database, so discard that
  one modification and `git pull --ff-only`. Afterwards run `br sync --import-only` and then
  `br sync --flush-only`: the first takes in whatever the pull brought, the second writes the
  file back from the database, bead changes not yet landed included. This applies to every
  pull in the main tree, whether or not the merge touched the tracker. Then delete the remote
  branch and remove the worktree.
- **Never destroy another session's work.** No force-push to a shared branch. No deleting a
  branch or a worktree that holds an unmerged commit or an uncommitted file. No `reset --hard`
  and no `checkout --` in a tree you did not create. A merge conflict is resolved by keeping
  both sides' intent; when that is not obvious, stop and ask.

This is a grant for this repository. It says nothing about any other.

<!-- This section is project-owned. -->
# notes/ — a Go module copied from kernl

`notes/` is a Go module of Houston's own (`github.com/gabrielassisxyz/houston/notes`),
copied from kernl's notes engine as it is at commit `488fbbe` — see
`notes/README.md` for the provenance, the exact copy commands, and the packages taken
and left out. It needs Go 1.26 or later.

A change that touches `notes/` or `scripts/check-notes-deps.sh` passes, besides the
present gate, the four commands of the Go gate: `go vet ./...`, `go test ./...` and
`go build -o /dev/null ./cmd/houston`, each run inside `notes/`, and
`scripts/check-notes-deps.sh` from the repository root. The check runs
`go list -deps ./cmd/houston` inside `notes/` and fails, naming each offender, on any
package the copy leaves out. `-o /dev/null` because a plain
`go build ./cmd/houston` leaves a binary `notes/houston` behind, which `.gitignore`
ignores for the same reason.

<!-- This section is project-owned. -->
# Running the tests

There is no test runner and no `npm test`. The tests are standalone scripts under `scripts/`,
run one at a time, and they come in three kinds:

- **Pure**, no server: `node scripts/test-blocking.mjs`, `node scripts/test-install-services.mjs`, `node scripts/test-loopback-url.mjs`, `node scripts/test-doc-links.mjs`.
  They test scripts directly or load a module from `lib/` without a build (TypeScript transpile,
  then `vm`).
- **Server-backed**: they drive the app over HTTP and need `SCOTTY_TEST_URL`. Run them through
  the wrapper, which starts an isolated server from the current build, runs the command and
  stops the server: `scripts/with-server.sh 3211 node scripts/test-br-store.mjs`.
- **Browser**: Playwright scripts that answer the API from fixtures. The same wrapper runs them:
  `scripts/with-server.sh 3211 node scripts/test-br-gates.mjs`.

Some scripts, for example `scripts/test-work-config.mjs` and `scripts/test-work-probe.mjs`, have a pure half and a server half and run the second only when `SCOTTY_TEST_URL`
is set, so run those both ways.

What has to be true for a run to mean anything:

- **Build first, and again after every source change.** The wrapper serves what `npm run build`
  last produced. A test that passes against a stale build proves nothing about the change.
- **Nine browser scripts expect a server launched read-only**, which is how the original
  project starts its test server. Put the variable in front of the wrapper:
  `SCOTTY_READ_ONLY=1 scripts/with-server.sh 3211 node scripts/test-keyboard.mjs`. They are
  `test-board-sorting`, `test-dependency-rows`, `test-epic-focus`, `test-focus`,
  `test-focus-grouping`, `test-keyboard`, `test-read-only`, `test-review-links` and
  `test-search-typing`. Without it each one fails on an assertion about a read-only control,
  which reads like a regression and is not one. Do not set it for every run: eight scripts fail
  under it, because they write through the API or expect a page that can be edited. They are
  `test-all-page-writes`, `test-br-store`, `test-close-actor`, `test-label-edits`,
  `test-project-chip`, `test-sprint-picker`, `test-sprint-run` and `test-sprints`. Every other script passes either way. A new script
  that writes through the API joins the second list, and its own read-only case goes through
  the viewer-mode cookie, not through the launch. Before calling a script red on `main`, run it
  both ways.
- **A tracker in a test is a throwaway directory** the test creates under `os.tmpdir()` and
  removes in `finally`. Never run a `br` write with the working directory inside this repository
  or one of its worktrees: it lands in the real tracker of the main tree, as the tracking
  section above explains.
- **Never open the project a test did not register.** A server started from a checkout
  registers that checkout as a project by itself. A test talks only to the project it added
  through `POST /api/projects`.
- **Browser scripts run on the system Chromium** when one is on `PATH`; the wrapper arranges it
  and `npx playwright install` is not needed. The temporary directory has to stay short, which
  the wrapper's header explains.
- **Use one port per concurrent run.** Two runs on one port fail at once; the wrapper refuses a
  port that is taken.

To break a guard on purpose, as the landing section asks:
`scripts/mutate-check.py 3211 scripts/test-br-store.mjs lib/br.ts '<old text>' '<new text>'`.
It applies the change, rebuilds, runs the test, reports whether the test went red, and puts the
file back even when the build fails. Rebuild after the last one.
