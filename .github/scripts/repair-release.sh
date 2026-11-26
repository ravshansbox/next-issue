#!/usr/bin/env bash
set -euo pipefail

last=$(git describe --tags --match 'v*' --abbrev=0 2>/dev/null || true)
if [ -z "$last" ]; then
  exit 0
fi
version=${last#v}
scripts=$(cd "$(dirname "$0")" && pwd)
root=$(pwd)
tree=$(mktemp -d)
trap 'git -C "$root" worktree remove --force "$tree"' EXIT
git worktree add --quiet --detach "$tree" "$last"
cd "$tree"

if [ "$(node -p "require('./package.json').private === true")" != true ]; then
  name=$(node -p "require('./package.json').name")
  if [ "$(npm view "$name@$version" version --prefer-online 2>/dev/null)" = "$version" ]; then
    echo "npm already holds $name@$version."
  else
    npm ci --ignore-scripts
    npm version --no-git-tag-version --allow-same-version "$version" > /dev/null
    if ! output=$(npm publish --provenance=false 2>&1); then
      echo "$output" >&2
      if ! grep -qE 'previously (published|staged) version' <<<"$output"; then
        exit 1
      fi
      echo "npm already holds $name@$version."
    fi
  fi
fi

if ! gh release view "$last" > /dev/null 2>&1; then
  notes=$("$scripts/release-notes.sh" "$last")
  gh release create "$last" --title "$last" --notes-file - <<<"$notes"
fi
