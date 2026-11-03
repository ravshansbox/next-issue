import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { run } from '../src/exec.mts';
import { type Fields, Recorder } from '../src/observe.mts';
import { recordCommands } from '../src/run.mts';

const NODE = process.execPath;

async function commands(target: Recorder): Promise<string[]> {
  await target.close();
  const raw = await readFile(target.logFile, 'utf8');
  return raw
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Fields)
    .filter((record) => record.kind === 'command')
    .map((record) => String(record.cmd));
}

test('two runs of nested repositories each log only the commands they ran', async () => {
  const outer = await mkdtemp(join(tmpdir(), 'next-issue-'));
  const inner = join(outer, 'inner');
  await mkdir(inner);
  const outerRecorder = await Recorder.create(outer, 'quiet');
  const innerRecorder = await Recorder.create(inner, 'quiet');
  await Promise.all([
    recordCommands(outerRecorder, async () => {
      await run(NODE, ['-e', '"outer-cwd"'], { cwd: outer });
      await run(NODE, ['-e', '"outer-none"']);
    }),
    recordCommands(innerRecorder, async () => {
      await run(NODE, ['-e', '"inner-cwd"'], { cwd: inner });
      await run(NODE, ['-e', '"inner-none"']);
    }),
  ]);
  assert.deepEqual(await commands(outerRecorder), [
    `${NODE} -e "outer-cwd"`,
    `${NODE} -e "outer-none"`,
  ]);
  assert.deepEqual(await commands(innerRecorder), [
    `${NODE} -e "inner-cwd"`,
    `${NODE} -e "inner-none"`,
  ]);
});
