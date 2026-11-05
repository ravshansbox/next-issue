import { readFile } from 'node:fs/promises';
import type { Fields, Recorder } from '../src/observe.mts';

export async function logRecords(target: Recorder): Promise<Fields[]> {
  await target.close();
  const raw = await readFile(target.logFile, 'utf8');
  return raw
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Fields);
}
