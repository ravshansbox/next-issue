#!/usr/bin/env bash
set -euo pipefail

version=$1
limit=${2:-600}
deadline=$((SECONDS + limit))
name=$(node -p "require('./package.json').name")
until [ "$(npm view "$name@$version" version --prefer-online 2>/dev/null)" = "$version" ]; do
  if [ "$SECONDS" -ge "$deadline" ]; then
    echo "npm does not serve $name@$version after $limit seconds." >&2
    exit 1
  fi
  sleep 10
done
echo "npm serves $name@$version."
