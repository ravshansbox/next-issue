#!/usr/bin/env bash
set -euo pipefail

script=$(cd "$(dirname "$0")" && pwd)/wait-for-npm.sh
failures=0

setup() {
  root=$(mktemp -d)
  bin=$root/bin
  repo=$root/repo
  mkdir -p "$bin" "$repo/packages/first" "$repo/packages/plugin"
  cat > "$bin/npm" <<'EOF'
#!/usr/bin/env bash
name=${2%@*}
version=${2##*@}
if grep -qx "$name" <<<"$SERVED"; then echo "$version"; else exit 1; fi
EOF
  cat > "$bin/sleep" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
  chmod +x "$bin/npm" "$bin/sleep"
  echo '{"name":"first","version":"0.0.0"}' > "$repo/packages/first/package.json"
  echo '{"name":"plugin","version":"0.0.0","private":true}' > "$repo/packages/plugin/package.json"
}

wait_for() {
  (cd "$repo" && PATH="$bin:$PATH" SERVED="$1" "$script" 1.2.0 0) > /dev/null 2>&1
}

check() {
  if [ "$2" = "$3" ]; then
    echo "ok - $1"
  else
    echo "not ok - $1"
    echo "expected: $2"
    echo "actual: $3"
    failures=$((failures + 1))
  fi
}

setup
if wait_for first; then result=0; else result=1; fi
check 'the release job waits for every public package and none that is private' 0 "$result"

setup
if wait_for ''; then result=0; else result=1; fi
check 'the release job fails when npm does not serve a public package in time' 1 "$result"

exit "$failures"
