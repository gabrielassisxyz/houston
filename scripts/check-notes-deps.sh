#!/bin/sh
# check-notes-deps keeps kernl's unrelated parts out of Houston's notes copy.
#
# It runs `go list -deps ./cmd/houston` inside notes/ and fails, naming each
# offender, on any package of this module that is, or lies under, one of the
# packages the copy leaves out; on any package of github.com/gabrielassisxyz/kernl
# (an import path left un-rewritten); on github.com/hymkor/trash-go; and
# whenever `go list` itself fails.
#
# Forbidden prefixes match up to a `/` boundary, so internal/applog is not
# mistaken for internal/app.
set -eu

cd "$(dirname "$0")/../notes"

if ! deps=$(go list -deps ./cmd/houston 2>&1); then
  printf 'check-notes-deps: go list failed:\n%s\n' "$deps" >&2
  exit 1
fi

forbidden="internal/app internal/chat internal/dispatch internal/epic internal/session internal/terminal internal/backend internal/approvals internal/inbox internal/ingest internal/planning internal/memory internal/vault/companion web"
module="github.com/gabrielassisxyz/houston/notes"

fail=0
for dep in $deps; do
  offender=""
  case "$dep" in
    github.com/gabrielassisxyz/kernl|github.com/gabrielassisxyz/kernl/*)
      offender="$dep"
      ;;
    github.com/hymkor/trash-go|github.com/hymkor/trash-go/*)
      offender="$dep"
      ;;
    "$module"/*)
      rest=${dep#"$module"/}
      for f in $forbidden; do
        if [ "$rest" = "$f" ] || [ "${rest#"$f"/}" != "$rest" ]; then
          offender="$dep (under $f)"
          break
        fi
      done
      ;;
  esac
  if [ -n "$offender" ]; then
    printf 'check-notes-deps: forbidden package %s\n' "$offender" >&2
    fail=1
  fi
done

if [ "$fail" -ne 0 ]; then
  exit 1
fi
printf 'check-notes-deps: ok\n'
