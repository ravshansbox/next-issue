#!/usr/bin/env bash
set -euo pipefail

script=$(cd "$(dirname "$0")" && pwd)/wait-for-npm.sh
failures=0
temp=$(mktemp -d)
trap 'rm -rf "$temp"' EXIT

setup() {
  root=$(mktemp -d "$temp/XXXXXX")
  bin=$root/bin
  repo=$root/repo
  mkdir -p "$bin" "$repo"
  cat > "$bin/npm" <<'EOF'
#!/usr/bin/env bash
name=${2%@*}
version=${2##*@}
if [ -e "$SLEPT" ] && grep -qx "$name" <<<"$SERVED_LATER"; then echo "$version"; exit 0; fi
if grep -qx "$name" <<<"$SERVED"; then echo "$version"; else exit 1; fi
EOF
  cat > "$bin/sleep" <<'EOF'
#!/usr/bin/env bash
echo slept >> "$SLEPT"
EOF
  chmod +x "$bin/npm" "$bin/sleep"
  echo '{"name":"first","version":"0.0.0"}' > "$repo/package.json"
}

wait_for() {
  (cd "$repo" && PATH="$bin:$PATH" SERVED="$1" SERVED_LATER="${3:-}" SLEPT="$root/slept" "$script" 1.2.0 "${2:-0}") > /dev/null 2>&1
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
check 'the release job ends once npm serves the root package' 0 "$result"

setup
if wait_for ''; then result=0; else result=1; fi
check 'the release job fails when npm does not serve the root package in time' 1 "$result"

setup
if wait_for '' 600 first; then result=0; else result=1; fi
check 'the release job retries until npm serves the root package after one wait' '0 1' "$result $(wc -l 2>/dev/null < "$root/slept" | tr -d ' ')"

exit "$failures"
