import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TestContext } from 'node:test';

export async function installGh(t: TestContext, dir: string, script: string): Promise<void> {
  await writeFile(join(dir, 'gh'), script, { mode: 0o755 });
  const path = process.env.PATH;
  process.env.PATH = `${dir}:${path}`;
  t.after(() => {
    process.env.PATH = path;
  });
}
