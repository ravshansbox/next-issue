#!/usr/bin/env bash
set -euo pipefail

script=$(cd "$(dirname "$0")" && pwd)/release-bump.sh
failures=0

setup() {
  repo=$(mktemp -d)
  git -C "$repo" init --quiet
  git -C "$repo" config user.name test
  git -C "$repo" config user.email test@example.com
}

commit() {
  git -C "$repo" commit --quiet --allow-empty -m "$1" ${2:+-m "$2"}
}

check() {
  local output actual
  output=$(mktemp)
  (cd "$repo" && GITHUB_OUTPUT="$output" "$script") > /dev/null 2>&1 || true
  actual=$(cat "$output")
  if [ "$actual" != "$2" ]; then
    echo "not ok - $1"
    echo "expected: $2"
    echo "actual: $actual"
    failures=$((failures + 1))
  else
    echo "ok - $1"
  fi
}

setup
commit 'feat: first'
check 'the release job picks a minor bump from the first commit when there is no tag' "last=
bump=minor"

setup
commit 'feat: first'
git -C "$repo" tag v1.0.0
commit 'fix: mend'
commit 'docs: explain'
check 'the release job picks a patch bump from a fix since the last tag' "last=v1.0.0
bump=patch"

setup
commit 'feat: first'
git -C "$repo" tag v1.0.0
commit 'fix: mend'
commit 'feat: add'
check 'the release job picks a minor bump from a feat since the last tag' "last=v1.0.0
bump=minor"

setup
commit 'feat: first'
git -C "$repo" tag v1.0.0
commit 'refactor: rename' 'BREAKING CHANGE: the key changed'
check 'the release job picks a major bump from a breaking change since the last tag' "last=v1.0.0
bump=major"

setup
commit 'feat: first'
git -C "$repo" tag v1.0.0
commit 'feat!: replace the key'
check 'the release job picks a major bump from a feat! subject since the last tag' "last=v1.0.0
bump=major"

setup
commit 'feat: first'
git -C "$repo" tag v1.0.0
commit 'chore: tidy'
check 'the release job releases nothing when no commit since the last tag is a feat, fix or breaking change' "last=v1.0.0
bump="

setup
commit 'feat: first'
git -C "$repo" tag v1.0.0
commit 'fix: earlier'
earlier=$(git -C "$repo" rev-parse HEAD)
commit 'feat: later'
git -C "$repo" tag v1.1.0
git -C "$repo" checkout --quiet --detach "$earlier"
check 'the release job of an earlier commit releases nothing when the release of a later commit already tagged it' "bump="

exit "$failures"
