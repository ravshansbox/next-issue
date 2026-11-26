#!/usr/bin/env bash
set -euo pipefail

script=$(cd "$(dirname "$0")" && pwd)/repair-release.sh
failures=0
temp=$(mktemp -d)
trap 'rm -rf "$temp"' EXIT

setup() {
  root=$(mktemp -d "$temp/XXXXXX")
  bin=$root/bin
  repo=$root/repo
  log=$root/log
  mkdir -p "$bin" "$repo"
  touch "$log"
  cat > "$bin/npm" <<'EOF'
#!/usr/bin/env bash
package() { node -p "require('./package.json').name"; }
if [ "$1" = view ]; then
  name=${2%@*}
  version=${2##*@}
  if grep -qx "$name" <<<"$HELD"; then echo "$version"; else exit 1; fi
else
  echo "npm $*" >> "$LOG"
  if [ "$1" = publish ] && grep -qx "$(package)" <<<"$REFUSED"; then
    echo "npm error 403 403 Forbidden - PUT https://registry.npmjs.org/$(package) - You cannot publish over the previously published versions: 1.2.0." >&2
    exit 1
  fi
  if [ "$1" = publish ] && grep -qx "$(package)" <<<"$STAGED"; then
    echo "npm error code E409" >&2
    echo "npm error 409 Conflict - PUT https://registry.npmjs.org/$(package) - Cannot publish over previously staged version \"1.2.0\"" >&2
    exit 1
  fi
  if [ "$1" = publish ] && grep -qx "$(package)" <<<"$BROKEN"; then
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
  if [ "${*: -1}" = - ]; then cat >> "$LOG"; fi
fi
EOF
  chmod +x "$bin/npm" "$bin/gh"
  echo '{"name":"first","version":"0.0.0"}' > "$repo/package.json"
  git -C "$repo" init --quiet
  git -C "$repo" config user.name test
  git -C "$repo" config user.email test@example.com
  git -C "$repo" add .
  git -C "$repo" commit --quiet -m 'feat: start'
  start=$(git -C "$repo" rev-parse --short HEAD)
}

repair() {
  (
    cd "$repo"
    export GITHUB_REPOSITORY=owner/repo
    if [ -n "${UNNAMED:-}" ]; then unset GITHUB_REPOSITORY; fi
    PATH="$bin:$PATH" LOG="$log" HELD="$1" RELEASED="$2" REFUSED="${3:-}" BROKEN="${4:-}" STAGED="${5:-}" "$script"
  ) > /dev/null 2>&1 || true
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
repair '' ''
check 'the release job publishes the package that npm lacks at the last tag version and makes the missing release' "npm ci --ignore-scripts
npm version --no-git-tag-version --allow-same-version 1.2.0
npm publish --provenance=false
gh release create v1.2.0 --title v1.2.0 --notes-file -
## Features

- feat: start ($start)

**Full Changelog**: https://github.com/owner/repo/commits/v1.2.0"

setup
git -C "$repo" tag v1.2.0
repair first ''
check 'the release job publishes nothing when npm holds the package and makes the missing release' "gh release create v1.2.0 --title v1.2.0 --notes-file -
## Features

- feat: start ($start)

**Full Changelog**: https://github.com/owner/repo/commits/v1.2.0"

setup
git -C "$repo" tag v1.2.0
repair first yes
check 'the release job changes nothing when npm holds the package of the last tag and the release exists' ''

setup
echo '{"name":"first-monorepo","private":true}' > "$repo/package.json"
git -C "$repo" commit --quiet -am 'feat: private root'
start=$(git -C "$repo" rev-parse --short HEAD)
git -C "$repo" tag v1.2.0
repair '' ''
check 'the release job publishes nothing for a tag with a private root package and makes the missing release' "gh release create v1.2.0 --title v1.2.0 --notes-file -
## Features

- feat: private root ($start)
- feat: start ($(git -C "$repo" rev-parse --short HEAD~1))

**Full Changelog**: https://github.com/owner/repo/commits/v1.2.0"

setup
git -C "$repo" tag v1.2.0
repair '' '' first
check 'the release job counts a package that npm refuses as previously published as held and makes the missing release' "npm ci --ignore-scripts
npm version --no-git-tag-version --allow-same-version 1.2.0
npm publish --provenance=false
gh release create v1.2.0 --title v1.2.0 --notes-file -
## Features

- feat: start ($start)

**Full Changelog**: https://github.com/owner/repo/commits/v1.2.0"

setup
git -C "$repo" tag v1.2.0
repair '' '' '' '' first
check 'the release job counts a package that npm refuses as previously staged as held and makes the missing release' "npm ci --ignore-scripts
npm version --no-git-tag-version --allow-same-version 1.2.0
npm publish --provenance=false
gh release create v1.2.0 --title v1.2.0 --notes-file -
## Features

- feat: start ($start)

**Full Changelog**: https://github.com/owner/repo/commits/v1.2.0"

setup
git -C "$repo" tag v1.2.0
repair '' '' '' first
check 'the release job stops before the release when a publish fails for another reason' "npm ci --ignore-scripts
npm version --no-git-tag-version --allow-same-version 1.2.0
npm publish --provenance=false"

setup
git -C "$repo" tag v1.1.0
git -C "$repo" commit --quiet --allow-empty -m 'fix: mend'
mend=$(git -C "$repo" rev-parse --short HEAD)
git -C "$repo" tag v1.2.0
git -C "$repo" commit --quiet --allow-empty -m 'feat: later'
repair first ''
check 'the release job makes the missing release with the notes from the tag before it' "gh release create v1.2.0 --title v1.2.0 --notes-file -
## Fixes

- fix: mend ($mend)

**Full Changelog**: https://github.com/owner/repo/compare/v1.1.0...v1.2.0"

setup
git -C "$repo" tag v1.2.0
UNNAMED=yes repair first ''
check 'the release job makes no release when the notes fail' ''

setup
repair '' ''
check 'the release job changes nothing when there is no tag' ''

exit "$failures"
