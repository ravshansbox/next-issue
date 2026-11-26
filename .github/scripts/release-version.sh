#!/usr/bin/env bash
set -euo pipefail

last=$1
bump=$2
base=${last#v}
npm version --no-git-tag-version --allow-same-version -w next-issue "${base:-0.0.0}" > /dev/null
npm version --no-git-tag-version -w next-issue "$bump" > /dev/null
version=$(node -p "require('./packages/next-issue/package.json').version")
npm version --no-git-tag-version --allow-same-version --workspaces "$version" > /dev/null
echo "$version"
