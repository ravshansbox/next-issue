import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TestContext } from 'node:test';

const JQ_WRAPPER = `#!/bin/sh
raw="$(dirname "$0")/gh-raw"
filter=""
filtered=false
previous=""
for arg in "$@"; do
  if [ "$previous" = "--jq" ]; then filter="$arg"; filtered=true; fi
  previous="$arg"
done
if [ "$filtered" = false ]; then exec sh "$raw" "$@"; fi
output="$(sh "$raw" "$@")" || exit $?
printf '%s\\n' "$output" | jq -r "$filter"
`;

export async function installGh(t: TestContext, dir: string, script: string): Promise<void> {
  await writeFile(join(dir, 'gh-raw'), script);
  await writeFile(join(dir, 'gh'), JQ_WRAPPER, { mode: 0o755 });
  const path = process.env.PATH;
  process.env.PATH = `${dir}:${path}`;
  t.after(() => {
    process.env.PATH = path;
  });
}
