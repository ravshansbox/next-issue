#!/usr/bin/env bash
set -euo pipefail

later=$(git tag --contains HEAD --list 'v*' --sort=v:refname)
if [ -n "$later" ]; then
  echo "bump=" >> "$GITHUB_OUTPUT"
  echo "The tag ${later%%$'\n'*} already holds this commit, so there is nothing to release."
  exit 0
fi
last=$(git describe --tags --match 'v*' --abbrev=0 2>/dev/null || echo "")
range=${last:+$last..HEAD}
subjects=$(git log ${range:-HEAD} --format='%s')
bodies=$(git log ${range:-HEAD} --format='%b')
bump=""
if grep -qE '^[a-z]+(\([^)]*\))?!:' <<<"$subjects" || grep -qE '^BREAKING[ -]CHANGE' <<<"$bodies"; then
  bump=major
elif grep -qE '^feat(\([^)]*\))?:' <<<"$subjects"; then
  bump=minor
elif grep -qE '^fix(\([^)]*\))?:' <<<"$subjects"; then
  bump=patch
fi
echo "last=$last" >> "$GITHUB_OUTPUT"
echo "bump=$bump" >> "$GITHUB_OUTPUT"
echo "The bump since ${last:-the first commit} is ${bump:-none}."
