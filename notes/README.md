# notes — Houston's own notes engine

A Go module (`github.com/gabrielassisxyz/houston/notes`, `go 1.26`) holding
kernl's notes engine as it is at commit
`488fbbe5cd0d939ae92b92051ef2a88b0b3acdf5`, with its import paths rewritten
and nothing else changed except one kernl-only test removed.

Source: https://github.com/gabrielassisxyz/kernl at commit
`488fbbe5cd0d939ae92b92051ef2a88b0b3acdf5`.

This copy is a fork that kernl does not share: fixes made here do not travel
to kernl, and kernl's later fixes do not reach this copy. Nothing is ever
written in kernl's repository or tracker from this module.

## How the copy was made

The source was read only through `git archive` from a clone of kernl kept
outside this repository, and never written. The clone already held the
object `488fbbe`, so no fetch, checkout or switch was needed.

```sh
# 1. Build the file list: everything taken, minus what is left out.
git -C <kernl-clone> ls-tree -r --name-only 488fbbe -- internal/graph \
  | grep -v '^internal/graph/traverse/' > /tmp/hou-oc5.10/graph.list
git -C <kernl-clone> ls-tree -r --name-only 488fbbe -- internal/vault \
  | grep -v '^internal/vault/companion/' \
  | grep -v '^internal/vault/layout/' > /tmp/hou-oc5.10/vault.list
git -C <kernl-clone> ls-tree -r --name-only 488fbbe -- internal/logging \
  > /tmp/hou-oc5.10/logging.list
printf '%s\n' \
  internal/notes/blocks.go \
  internal/notes/blocks_test.go \
  internal/notes/suggest.go \
  internal/notes/suggest_test.go \
  internal/notes/tags.go \
  > /tmp/hou-oc5.10/notes.list

# 2. Extract only the commit's tracked files under a scratch prefix.
cat /tmp/hou-oc5.10/graph.list /tmp/hou-oc5.10/vault.list \
  /tmp/hou-oc5.10/logging.list /tmp/hou-oc5.10/notes.list \
  > /tmp/hou-oc5.10/all.list
git -C <kernl-clone> archive 488fbbe -- $(tr '\n' ' ' < /tmp/hou-oc5.10/all.list) \
  | tar -x -C /tmp/hou-oc5.10/src

# 3. Unpack under notes/ so kernl's package paths are kept under that prefix.
mkdir -p notes
cp -a /tmp/hou-oc5.10/src/internal notes/internal

# 4. Rewrite every import path; nothing else in a copied file changes.
grep -rl 'github.com/gabrielassisxyz/kernl/internal/' notes --include='*.go' \
  | xargs sed -i 's|github.com/gabrielassisxyz/kernl/internal/|github.com/gabrielassisxyz/houston/notes/internal/|g'

# 5. Remove the one kernl-only test (see below), with the runtime import it
#    leaves unused, then add the new files and tidy.
#    notes/internal/vault/config_test.go:84-145
#      TestExampleConfigParses, import_yaml, loadConfig, isYAMLError, contains.
```

The rewrite keeps every line count, so the copied files keep kernl's line
numbers except `internal/vault/config_test.go` after line 84, where the
kernl-only test was removed.

`go.mod` requires the source's versions (fsnotify v1.10.1, uuid v1.6.0,
yaml.v3 v3.0.1, modernc.org/sqlite v1.60.1, pgregory.net/rapid v1.3.0 for the
property tests); `go mod tidy` adds the indirect ones and writes `go 1.26.0`.
`go.sum` is committed.

## Packages taken

- `internal/graph` and its sub-packages `edges`, `nodes`, `relate`,
  `revisions`, `schema` (migrations 0001 to 0008, 0005 skipped as in the
  source), `search`, `tags`, `testutil`, `internal/ids`,
  `internal/migrate` (with its `testdata`) and `internal/sqlite`: the store,
  every query the ported routes run, and the test substrate.
- `internal/vault` and its sub-packages `frontmatter` (with its `testdata`),
  `reconcile`, `watcher` and `wikilink`: the indexer. That includes the
  top-level `config.go` (defaults and validation over `config.VaultConfig`),
  `service.go` (the watcher lifecycle), `policies.go` and the `e2e_test.go`
  integration test.
- `internal/notes`: `blocks.go` (the prepend, insert and append of
  `POST /api/vault/append`), `suggest.go` (`blocks.go:31,67` calls its
  `SplitFrontmatter`), `tags.go` (`GET /api/notes/tags`) and their tests.
- `internal/logging`: the logger and the request middleware.

New files in this step, not from kernl:

- `go.mod`, `go.sum`: the module definition described above.
- `README.md` (this file) and `LICENSE`: provenance and the original MIT text.
- `internal/config/config.go`: a small local package holding `ServerConfig`
  (kernl `config.go:120-127`) and `VaultConfig` with its `Enabled` method
  (`config.go:172-189`), as they are, plus `expandHomePath`; A2 adds the
  loader beside them.
- `cmd/houston/main.go`: `help`, `--help` and `-h` print the usage; any other
  verb exits 2 with an unknown-command message. A4 adds the first real verbs.

## Packages left out, with the reason

- `internal/graph/traverse`: imported by nothing in kernl outside its own tests.
- `internal/vault/companion` (kernl's companion notes for tasks, projects and
  bookmarks) and `internal/vault/layout` (where kernl files those): only
  kernl's other features import them — `companion` is imported only by
  kernl's project, task and bookmark handlers, and `layout` is imported only
  by `companion`, by kernl's project, task, bookmark and ingest handlers, by
  `internal/inbox`, `internal/bookmarks` and `cmd/kernl`.
- `internal/notes/autosave.go`: serves only kernl's save route
  (`internal/api/notes.go:122`).
- `internal/notes/diff_parser.go`: has no caller outside its own package.
- `internal/app`: kernl's application container. What the service needed from
  it is replaced where it is used: the handlers are written against the graph
  and the vault config (A3), and the lock takes an explicit path (A2).
- `internal/chat`, `internal/dispatch`, `internal/epic`, `internal/session`,
  `internal/terminal`, `internal/backend`, `internal/approvals`,
  `internal/inbox`, `internal/ingest`, `internal/planning` (with
  `planning/linksuggest`), `internal/memory`, `web`, and every other package
  of kernl: taking any of them would bring kernl's whole orchestrator back.
  `internal/vault` imports kernl's `internal/config` only for `VaultConfig`
  (`internal/vault/config.go:20,34,52,57`, `service.go:23,35`), which is why
  the small local `internal/config` above is enough.
- `github.com/hymkor/trash-go`, used by kernl's `DELETE /api/vault/file`
  (`internal/api/vault.go:461`), which implements only the Linux FreeDesktop
  trash on every non-Windows system (`main_unix.go`, `//go:build !windows`):
  on macOS it moves files to `~/.local/share/Trash`, and a rename across
  volumes fails. The copy does not take it.
- kernl's `internal/config` as a whole: its `config.go` alone is 504 lines of
  agent, orchestrator, inbox and planning settings.

## How to read a citation

A path under `internal/` or `cmd/kernl/` with a line number is kernl at
`488fbbe`, the copy's source. Paths under `app/`, `components/`, `lib/`,
`hooks/`, `scripts/` and `docs/` are Houston's.

- In the copy, kernl's `internal/<package>/<file>` is
  `notes/internal/<package>/<file>`, with the same name and, until a step
  edits that file, the same line numbers, since the copy's rewrite of import
  paths keeps every line count. The one exception is
  `internal/vault/config_test.go` after line 84, where the copy removed a
  kernl-only test.
- kernl's `internal/api/<file>` is ported into `notes/internal/api/<file>`
  (A3); `cmd/kernl/<file>` into `notes/cmd/houston/<file>` (A4 onwards);
  `internal/app/lock.go` into `notes/internal/graph/dbfile/lock.go` (A2); and
  kernl's `internal/config/config.go` gives `ServerConfig`, `VaultConfig`
  and `expandHomePath` to `notes/internal/config/config.go`.
- A cited kernl path that the copy does not take (`internal/app`,
  `internal/planning`, `internal/vault/companion`, `internal/inbox` and the
  rest) is cited only as the source of what is left out.

## Gate

Besides the repository gate, a change that touches `notes/` or
`scripts/check-notes-deps.sh` passes, inside `notes/`:

```sh
go vet ./...
go test ./...
go build -o /dev/null ./cmd/houston
```

and, from the repository root:

```sh
bash scripts/check-notes-deps.sh
```

`-o /dev/null` because a plain `go build ./cmd/houston` leaves a binary
`notes/houston` behind, which `.gitignore` ignores for the same reason.
