#!/usr/bin/env bash
set -euo pipefail

script=$(cd "$(dirname "$0")" && pwd)/release-version.sh
failures=0

setup() {
  repo=$(mktemp -d)
  mkdir -p "$repo/packages/next-issue" "$repo/packages/plugin"
  echo '{"name":"root","private":true,"workspaces":["packages/next-issue","packages/plugin"]}' > "$repo/package.json"
  echo '{"name":"next-issue","version":"0.0.0"}' > "$repo/packages/next-issue/package.json"
  echo '{"name":"plugin","version":"0.0.0"}' > "$repo/packages/plugin/package.json"
}

version_of() {
  node -p "require('$repo/packages/$1/package.json').version"
}

check() {
  local printed actual
  printed=$(cd "$repo" && "$script" "$2" "$3" 2> /dev/null) || true
  actual="$printed $(version_of next-issue) $(version_of plugin)"
  if [ "$actual" != "$4" ]; then
    echo "not ok - $1"
    echo "expected: $4"
    echo "actual: $actual"
    failures=$((failures + 1))
  else
    echo "ok - $1"
  fi
}

setup
check 'the release job gives every package the first minor version when there is no tag' '' minor '0.1.0 0.1.0 0.1.0'

setup
check 'the release job gives every package the first patch version when there is no tag' '' patch '0.0.1 0.0.1 0.0.1'

setup
check 'the release job gives every package the next patch version after the last tag' v1.2.3 patch '1.2.4 1.2.4 1.2.4'

setup
check 'the release job gives every package the next minor version after the last tag' v1.2.3 minor '1.3.0 1.3.0 1.3.0'

setup
check 'the release job gives every package the next major version after the last tag' v1.2.3 major '2.0.0 2.0.0 2.0.0'

setup
echo '{"name":"next-issue","version":"1.2.3"}' > "$repo/packages/next-issue/package.json"
check 'the release job counts from the last tag when the package already holds its version' v1.2.3 patch '1.2.4 1.2.4 1.2.4'

exit "$failures"
