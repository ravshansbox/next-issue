import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function tempFolder(): string {
  return mkdtempSync(join(tmpdir(), 'pi-next-issue-'));
}
