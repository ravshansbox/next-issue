#!/usr/bin/env bash
set -euo pipefail

script=$(cd "$(dirname "$0")" && pwd)/release-notes.sh
failures=0
temp=$(mktemp -d)
trap 'rm -rf "$temp"' EXIT

setup() {
  repo=$(mktemp -d "$temp/XXXXXX")
  git -C "$repo" init --quiet
  git -C "$repo" config user.name test
  git -C "$repo" config user.email test@example.com
}

commit() {
  git -C "$repo" commit --quiet --allow-empty -m "$1" ${2:+-m "$2"}
  git -C "$repo" rev-parse --short HEAD
}

check() {
  local actual
  actual=$(cd "$repo" && GITHUB_REPOSITORY=owner/repo "$script" "$2" 2>&1) || true
  if [ "$actual" != "$3" ]; then
    echo "not ok - $1"
    echo "expected: $3"
    echo "actual: $actual"
    failures=$((failures + 1))
  else
    echo "ok - $1"
  fi
}

setup
commit 'feat: old feature' > /dev/null
git -C "$repo" tag v1.0.0
fix=$(commit 'fix(cli): mend the flag')
commit 'docs: explain the flag' > /dev/null
feature=$(commit 'feat: add a flag')
bang=$(commit 'feat!: drop the old flag')
body=$(commit 'refactor: rename the config' 'BREAKING CHANGE: the config key changed')
git -C "$repo" tag v2.0.0
commit 'fix: later fix' > /dev/null
check 'the release job lists the breaking, feat and fix commits since the previous tag by type with their short hashes and ends with the compare link' v2.0.0 "## Breaking changes

- refactor: rename the config ($body)
- feat!: drop the old flag ($bang)

## Features

- feat: add a flag ($feature)

## Fixes

- fix(cli): mend the flag ($fix)

**Full Changelog**: https://github.com/owner/repo/compare/v1.0.0...v2.0.0"

setup
first=$(commit 'feat: first feature')
commit 'chore: set up' > /dev/null
git -C "$repo" tag v0.1.0
check 'the release job lists the commits from the first commit when there is no previous tag' v0.1.0 "## Features

- feat: first feature ($first)

**Full Changelog**: https://github.com/owner/repo/commits/v0.1.0"

exit "$failures"
