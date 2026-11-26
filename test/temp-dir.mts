import { rmSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const folders: string[] = [];

process.on('exit', () => {
  for (const folder of folders) {
    rmSync(folder, { recursive: true, force: true });
  }
});

export async function tempDir(parent = tmpdir()): Promise<string> {
  const folder = await mkdtemp(join(parent, 'next-issue-'));
  folders.push(folder);
  return folder;
}
