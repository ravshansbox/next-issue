#!/usr/bin/env bash
set -euo pipefail

script=$(cd "$(dirname "$0")" && pwd)/check-npm.sh
failures=0

check() {
  local name=$1 version=$2 code=$3 output=$4
  local bin actual status
  bin=$(mktemp -d)
  printf '#!/usr/bin/env bash\necho %s\n' "$version" > "$bin/npm"
  chmod +x "$bin/npm"
  status=0
  actual=$(PATH="$bin:$PATH" "$script" 2>&1) || status=$?
  if [ "$status" = "$code" ] && [ "$actual" = "$output" ]; then
    echo "ok - $name"
  else
    echo "not ok - $name"
    echo "  expected $code: $output"
    echo "  actual $status: $actual"
    failures=$((failures + 1))
  fi
  rm -rf "$bin"
}

check 'the release job goes on when the bundled npm is the oldest with trusted publishing' 11.5.1 0 'npm 11.5.1 supports trusted publishing.'
check 'the release job goes on when the bundled npm is newer than needed' 11.19.1 0 'npm 11.19.1 supports trusted publishing.'
check 'the release job fails with a clear message when the bundled npm is too old' 11.5.0 1 'npm 11.5.0 is too old for trusted publishing: it needs npm 11.5.1 or later. Use a Node version that bundles it.'
check 'the release job fails when the bundled npm is an older major version' 10.9.2 1 'npm 10.9.2 is too old for trusted publishing: it needs npm 11.5.1 or later. Use a Node version that bundles it.'

exit "$failures"
