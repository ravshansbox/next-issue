#!/usr/bin/env bash
set -euo pipefail

last=$(git describe --tags --match 'v*' --abbrev=0 2>/dev/null || true)
if [ -z "$last" ]; then
  exit 0
fi
version=${last#v}
root=$(pwd)
tree=$(mktemp -d)
trap 'git -C "$root" worktree remove --force "$tree"' EXIT
git worktree add --quiet --detach "$tree" "$last"
cd "$tree"

missing=()
for manifest in packages/*/package.json; do
  name=$(node -p "require('./$manifest').name")
  if [ "$(npm view "$name@$version" version --prefer-online 2>/dev/null)" = "$version" ]; then
    echo "npm already holds $name@$version."
  else
    missing+=("$(dirname "$manifest")")
  fi
done

if [ "${#missing[@]}" -gt 0 ]; then
  npm ci
  npm version --no-git-tag-version --allow-same-version --workspaces "$version" > /dev/null
  for workspace in "${missing[@]}"; do
    if ! output=$(npm publish -w "$workspace" 2>&1); then
      echo "$output" >&2
      if ! grep -q 'previously published version' <<<"$output"; then
        exit 1
      fi
      echo "npm already holds $workspace at $version."
    fi
  done
fi

if ! gh release view "$last" > /dev/null 2>&1; then
  gh release create "$last" --title "$last" --generate-notes
fi
