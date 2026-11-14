#!/usr/bin/env bash
set -euo pipefail

script=$(cd "$(dirname "$0")" && pwd)/repair-release.sh
failures=0

setup() {
  root=$(mktemp -d)
  bin=$root/bin
  repo=$root/repo
  log=$root/log
  mkdir -p "$bin" "$repo/packages/first" "$repo/packages/second"
  touch "$log"
  cat > "$bin/npm" <<'EOF'
#!/usr/bin/env bash
if [ "$1" = view ]; then
  name=${2%@*}
  version=${2##*@}
  if grep -qx "$name" <<<"$HELD"; then echo "$version"; else exit 1; fi
else
  echo "npm $*" >> "$LOG"
  if [ "$1" = publish ] && grep -qx "${3#packages/}" <<<"$REFUSED"; then
    echo "npm error 403 403 Forbidden - PUT https://registry.npmjs.org/${3#packages/} - You cannot publish over the previously published versions: 1.2.0." >&2
    exit 1
  fi
  if [ "$1" = publish ] && grep -qx "${3#packages/}" <<<"$BROKEN"; then
    echo "npm error 500 Internal Server Error" >&2
    exit 1
  fi
fi
EOF
  cat > "$bin/gh" <<'EOF'
#!/usr/bin/env bash
if [ "$2" = view ]; then
  [ -n "$RELEASED" ]
else
  echo "gh $*" >> "$LOG"
fi
EOF
  chmod +x "$bin/npm" "$bin/gh"
  echo '{"name":"first","version":"0.0.0"}' > "$repo/packages/first/package.json"
  echo '{"name":"second","version":"0.0.0"}' > "$repo/packages/second/package.json"
  git -C "$repo" init --quiet
  git -C "$repo" config user.name test
  git -C "$repo" config user.email test@example.com
  git -C "$repo" add .
  git -C "$repo" commit --quiet -m first
}

repair() {
  (cd "$repo" && PATH="$bin:$PATH" LOG="$log" HELD="$1" RELEASED="$2" REFUSED="${3:-}" BROKEN="${4:-}" "$script") > /dev/null 2>&1 || true
}

check() {
  if [ "$(cat "$log")" != "$2" ]; then
    echo "not ok - $1"
    echo "expected: $2"
    echo "actual: $(cat "$log")"
    failures=$((failures + 1))
  else
    echo "ok - $1"
  fi
}

setup
git -C "$repo" tag v1.2.0
repair first ''
check 'the release job publishes only the package that npm lacks at the last tag version and makes the missing release' "npm ci
npm version --no-git-tag-version --allow-same-version --workspaces 1.2.0
npm publish -w packages/second
gh release create v1.2.0 --title v1.2.0 --generate-notes"

setup
git -C "$repo" tag v1.2.0
repair '' ''
check 'the release job publishes every package when nothing of the last tag reached npm' "npm ci
npm version --no-git-tag-version --allow-same-version --workspaces 1.2.0
npm publish -w packages/first
npm publish -w packages/second
gh release create v1.2.0 --title v1.2.0 --generate-notes"

setup
git -C "$repo" tag v1.2.0
repair "first
second" yes
check 'the release job changes nothing when npm holds every package of the last tag and the release exists' ''

setup
git -C "$repo" tag v1.2.0
repair first '' second
check 'the release job counts a package that npm refuses as previously published as held and makes the missing release' "npm ci
npm version --no-git-tag-version --allow-same-version --workspaces 1.2.0
npm publish -w packages/second
gh release create v1.2.0 --title v1.2.0 --generate-notes"

setup
git -C "$repo" tag v1.2.0
repair first '' '' second
check 'the release job stops before the release when a publish fails for another reason' "npm ci
npm version --no-git-tag-version --allow-same-version --workspaces 1.2.0
npm publish -w packages/second"

setup
repair '' ''
check 'the release job changes nothing when there is no tag' ''

exit "$failures"
