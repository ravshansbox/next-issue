#!/usr/bin/env bash
set -euo pipefail

last=$1
bump=$2
base=${last#v}
npm version --no-git-tag-version --allow-same-version "${base:-0.0.0}" > /dev/null
npm version --no-git-tag-version "$bump" > /dev/null
node -p "require('./package.json').version"
