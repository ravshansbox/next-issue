#!/usr/bin/env bash
set -euo pipefail

tag=$1
previous=$(git describe --tags --match 'v*' --abbrev=0 "$tag^" 2>/dev/null || true)
breaking=""
features=""
fixes=""
for hash in $(git log --format='%H' ${previous:+$previous..}"$tag"); do
  subject=$(git log -1 --format='%s' "$hash")
  body=$(git log -1 --format='%b' "$hash")
  line="- $subject ($(git rev-parse --short "$hash"))"$'\n'
  if grep -qE '^[a-z]+(\([^)]*\))?!:' <<<"$subject" || grep -qE '^BREAKING[ -]CHANGE' <<<"$body"; then
    breaking+=$line
  elif grep -qE '^feat(\([^)]*\))?:' <<<"$subject"; then
    features+=$line
  elif grep -qE '^fix(\([^)]*\))?:' <<<"$subject"; then
    fixes+=$line
  fi
done

if [ -n "$breaking" ]; then
  printf '## Breaking changes\n\n%s\n' "$breaking"
fi
if [ -n "$features" ]; then
  printf '## Features\n\n%s\n' "$features"
fi
if [ -n "$fixes" ]; then
  printf '## Fixes\n\n%s\n' "$fixes"
fi
url="${GITHUB_SERVER_URL:-https://github.com}/$GITHUB_REPOSITORY"
if [ -n "$previous" ]; then
  echo "**Full Changelog**: $url/compare/$previous...$tag"
else
  echo "**Full Changelog**: $url/commits/$tag"
fi
