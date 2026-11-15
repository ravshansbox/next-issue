#!/usr/bin/env bash
set -euo pipefail

minimum=11.5.1
version=$(npm --version)
oldest=$(printf '%s\n%s\n' "$minimum" "$version" | sort -V | head -n 1)
if [ "$oldest" != "$minimum" ]; then
  echo "npm $version is too old for trusted publishing: it needs npm $minimum or later. Use a Node version that bundles it." >&2
  exit 1
fi
echo "npm $version supports trusted publishing."
