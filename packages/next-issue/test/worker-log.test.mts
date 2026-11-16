import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';
import { run } from '../src/exec.mts';
import { LOG_KEEP_BYTES, LOG_LIMIT_BYTES, trimLog } from '../src/worker-log.mts';

test('a worker leaves worker.log whole while a shown command can write to it, and trims it after', async () => {
  const root = await mkdtemp(join(tmpdir(), 'worker-log-'));
  const logPath = join(root, 'worker.log');
  const line = `${'x'.repeat(99)}\n`;
  await writeFile(logPath, line.repeat(LOG_LIMIT_BYTES / line.length + 10));
  const before = (await stat(logPath)).size;
  const command = run(process.execPath, ['-e', 'setTimeout(() => {}, 300)'], { show: true });
  trimLog(logPath);
  assert.equal((await stat(logPath)).size, before);
  await command;
  trimLog(logPath);
  const text = await readFile(logPath, 'utf8');
  assert.ok(text.length <= LOG_KEEP_BYTES, `worker.log holds ${text.length} bytes`);
  assert.ok(text.endsWith(line));
});

test('a worker that trims worker.log keeps a line that another process appends during the trim', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'worker-log-'));
  const logPath = join(root, 'worker.log');
  const line = `${'x'.repeat(99)}\n`;
  await writeFile(logPath, line.repeat(LOG_LIMIT_BYTES / line.length + 10));
  const readSync = fs.readSync;
  let appended = false;
  t.mock.method(fs, 'readSync', (...args: Parameters<typeof fs.readSync>) => {
    const read = readSync(...args);
    if (!appended) {
      appended = true;
      fs.appendFileSync(logPath, 'written during the trim\n');
    }
    return read;
  });
  syncBuiltinESMExports();
  t.after(syncBuiltinESMExports);
  trimLog(logPath);
  t.mock.restoreAll();
  syncBuiltinESMExports();
  const text = await readFile(logPath, 'utf8');
  assert.equal(appended, true);
  assert.ok(text.length <= LOG_KEEP_BYTES + 100, `worker.log holds ${text.length} bytes`);
  assert.ok(text.endsWith(`${line}written during the trim\n`));
});
