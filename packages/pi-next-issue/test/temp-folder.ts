import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const folders: string[] = [];

process.on('exit', () => {
  for (const folder of folders) {
    rmSync(folder, { recursive: true, force: true });
  }
});

export function tempFolder(parent = tmpdir()): string {
  const folder = mkdtempSync(join(parent, 'pi-next-issue-'));
  folders.push(folder);
  return folder;
}
