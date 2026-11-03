import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { must } from '../src/exec.mts';

const CLI = fileURLToPath(new URL('../src/cli.mts', import.meta.url));

async function stopCommand(root: string): Promise<string> {
  const { stdout } = await promisify(execFile)(process.execPath, [CLI, 'stop'], { cwd: root });
  return stdout;
}

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'next-issue-'));
  await must('git', ['init', '-q'], { cwd: root });
  return root;
}

async function serveWorker(root: string) {
  const child = spawn(process.execPath, [CLI, 'serve'], { cwd: root });
  let stderr = '';
  child.stderr.on('data', (chunk) => (stderr += chunk));
  const exited = new Promise<NodeJS.Signals | null>((resolve) =>
    child.on('exit', (_code, signal) => resolve(signal)),
  );
  for (let left = 100; left > 0 && !stderr.includes('listening'); left -= 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return { child, exited, stderr: () => stderr };
}

test('a user who runs init gets .next-issue/ and .worktrees/ in .gitignore', async () => {
  const root = await mkdtemp(join(tmpdir(), 'next-issue-'));
  await must('git', ['init', '-q'], { cwd: root });
  await must(process.execPath, [CLI, 'init'], { cwd: root });
  assert.equal(await readFile(join(root, '.gitignore'), 'utf8'), '.next-issue/\n.worktrees/\n');
});

test('a user who runs --watch with no open issue sees one wait of 1 minute and no summary after Ctrl-C', async () => {
  const root = await mkdtemp(join(tmpdir(), 'next-issue-'));
  await must('git', ['init', '-q'], { cwd: root });
  await must('git', ['remote', 'add', 'origin', 'https://github.com/acme/watch.git'], {
    cwd: root,
  });
  const bin = await mkdtemp(join(tmpdir(), 'next-issue-'));
  const script = `#!/bin/sh
case "$1 $2" in
  "repo view") echo '{"defaultBranchRef":{"name":"main"}}' ;;
  "issue list") echo '[]' ;;
  *) echo "unexpected: $*" >&2; exit 1 ;;
esac
`;
  await writeFile(join(bin, 'gh'), script, { mode: 0o755 });
  const child = spawn(process.execPath, [CLI, '--watch'], {
    cwd: root,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => (stdout += chunk));
  child.stderr.on('data', (chunk) => (stderr += chunk));
  const exited = new Promise<number | null>((resolve) => child.on('exit', resolve));
  while (!stderr.includes('watch.wait')) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await new Promise((resolve) => setTimeout(resolve, 1000));
  child.kill('SIGINT');
  assert.equal(await exited, 0);
  assert.deepEqual(
    stderr
      .split('\n')
      .filter((line) => line.includes('watch.wait'))
      .map((line) => line.replace(/^\S+ /, '')),
    ['watch.wait minutes=1'],
  );
  assert.match(stderr, /Stopping now\./);
  assert.equal(stdout, '');
});

test('a user who stops the worker with SIGTERM sees it exit and remove its socket and lock files', async () => {
  const root = await repository();
  const { child, exited, stderr } = await serveWorker(root);
  assert.match(stderr(), /worker listening on .*\.next-issue\/worker\.sock/);
  child.kill('SIGTERM');
  assert.equal(await exited, 'SIGTERM');
  assert.deepEqual(await readdir(join(root, '.next-issue')), []);
});

test('a user who runs stop sees the worker of this repository exit and remove its socket and lock files', async (t) => {
  const root = await repository();
  const { child, exited } = await serveWorker(root);
  t.after(() => child.kill('SIGKILL'));
  assert.equal(
    await stopCommand(root),
    `next-issue: stopped the worker with process id ${child.pid}\n`,
  );
  assert.equal(await exited, 'SIGTERM');
  assert.deepEqual(await readdir(join(root, '.next-issue')), []);
});

test('a user who runs stop in one repository leaves the worker of another repository going', async (t) => {
  const first = await repository();
  const second = await repository();
  const one = await serveWorker(first);
  const two = await serveWorker(second);
  t.after(() => one.child.kill('SIGKILL'));
  t.after(() => two.child.kill('SIGKILL'));
  await stopCommand(first);
  assert.equal(await one.exited, 'SIGTERM');
  assert.equal(two.child.exitCode, null);
  assert.equal(two.child.signalCode, null);
  assert.deepEqual((await readdir(join(second, '.next-issue'))).sort(), [
    'worker.lock',
    'worker.sock',
  ]);
});

test('a user who runs stop with no worker alive sees that none is running', async () => {
  const root = await repository();
  assert.equal(await stopCommand(root), 'next-issue: no worker is running\n');
  const dead = spawn(process.execPath, ['-e', '']);
  await new Promise((resolve) => dead.on('exit', resolve));
  await mkdir(join(root, '.next-issue'));
  await writeFile(join(root, '.next-issue', 'worker.lock'), `${dead.pid}\n`);
  assert.equal(await stopCommand(root), 'next-issue: no worker is running\n');
});

test('a user who serves a repository whose socket path is too long sees an error that says so', async () => {
  const root = join(await mkdtemp(join(tmpdir(), 'next-issue-')), 'a'.repeat(120));
  await mkdir(root);
  await must('git', ['init', '-q'], { cwd: root });
  const error = await promisify(execFile)(process.execPath, [CLI, 'serve'], { cwd: root }).then(
    () => undefined,
    (failure: { code: number; stderr: string }) => failure,
  );
  assert.equal(error?.code, 1);
  assert.match(error?.stderr ?? '', /the socket path .*worker\.sock is too long for this system/);
});

function event(index: number): string {
  return JSON.stringify({
    ts: '2026-01-02T03:04:05.000Z',
    runId: 'r',
    kind: `step${index}.end`,
    issue: 7,
    ms: index,
  });
}

async function runLog(lines: string[]): Promise<{ root: string; file: string }> {
  const root = await mkdtemp(join(tmpdir(), 'next-issue-'));
  await must('git', ['init', '-q'], { cwd: root });
  const dir = join(root, '.next-issue', 'runs');
  await mkdir(join(dir, '2026-01-02T03-04-05-000Z', 'sessions'), { recursive: true });
  await writeFile(join(dir, '2026-01-01T00-00-00-000Z.jsonl'), `${event(99)}\n`);
  const file = join(dir, '2026-01-02T03-04-05-000Z.jsonl');
  await writeFile(file, lines.map((line) => `${line}\n`).join(''));
  return { root, file };
}

async function until(read: () => string, pattern: RegExp): Promise<void> {
  for (let left = 200; left > 0 && !pattern.test(read()); left -= 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.match(read(), pattern);
}

function followLogs(root: string, extra: string[]) {
  const child = spawn(process.execPath, [CLI, 'logs', ...extra], { cwd: root });
  let stdout = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => (stdout += chunk));
  const exited = new Promise<number | null>((resolve) => child.on('exit', resolve));
  return { child, read: () => stdout, exited };
}

test('a user who pipes logs sees every event of the newest run log rendered, then new ones, until Ctrl-C', async (t) => {
  const { root, file } = await runLog([event(1), event(2)]);
  const { child, read, exited } = followLogs(root, []);
  t.after(() => child.kill('SIGKILL'));
  await until(read, /step2\.end/);
  await appendFile(file, `${event(3)}\n`);
  await until(read, /step3\.end/);
  child.kill('SIGINT');
  assert.equal(await exited, 0);
  assert.deepEqual(
    read()
      .trimEnd()
      .split('\n')
      .map((line) => line.replace(/^\S+ /, '')),
    ['#7 step1.end ms=1', '#7 step2.end ms=2', '#7 step3.end ms=3'],
  );
});

test('a user who pipes logs --json sees the raw JSON lines, then new ones', async (t) => {
  const { root, file } = await runLog([event(1)]);
  const { child, read, exited } = followLogs(root, ['--json']);
  t.after(() => child.kill('SIGKILL'));
  await until(read, /step1\.end/);
  await appendFile(file, `${event(2)}\n`);
  await until(read, /step2\.end/);
  child.kill('SIGINT');
  assert.equal(await exited, 0);
  assert.equal(read(), `${event(1)}\n${event(2)}\n`);
});

test('a user who pipes logs --json sees multi-byte characters intact across a long line', async (t) => {
  const long = JSON.stringify({
    ts: '2026-01-02T03:04:05.000Z',
    kind: 'xy',
    text: 'é'.repeat(40000),
  });
  const { root } = await runLog([long]);
  const { child, read, exited } = followLogs(root, ['--json']);
  t.after(() => child.kill('SIGKILL'));
  await until(read, /\n$/);
  child.kill('SIGINT');
  assert.equal(await exited, 0);
  assert.equal(read(), `${long}\n`);
});

test('a user who pipes logs sees the valid events rendered and the line that is not JSON skipped', async (t) => {
  const { root } = await runLog([event(1), 'not json', event(2)]);
  const { child, read, exited } = followLogs(root, []);
  t.after(() => child.kill('SIGKILL'));
  await until(read, /step2\.end/);
  child.kill('SIGINT');
  assert.equal(await exited, 0);
  assert.doesNotMatch(read(), /not json/);
  assert.match(read(), /step1\.end/);
});

test('a user whose reader closes the pipe sees logs exit with 0 at the next event', async (t) => {
  const { root, file } = await runLog([event(1)]);
  const child = spawn(
    'sh',
    ['-c', `{ "${process.execPath}" "${CLI}" logs; echo "exit=$?" >&2; } | head -n 1`],
    { cwd: root },
  );
  t.after(() => child.kill('SIGKILL'));
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => (stdout += chunk));
  child.stderr.on('data', (chunk) => (stderr += chunk));
  await until(() => stdout, /step1\.end/);
  await appendFile(file, `${event(2)}\n${event(3)}\n`);
  await until(() => stderr, /exit=\d+/);
  assert.equal(stderr, 'exit=0\n');
});

test(
  'a user whose reader closes the pipe sees logs exit with 0 while the run adds no events',
  { skip: process.platform === 'linux' && 'Linux reports a closed pipe only on a write of data' },
  async (t) => {
    const { root } = await runLog([event(1)]);
    const child = spawn(
      'sh',
      ['-c', `{ "${process.execPath}" "${CLI}" logs; echo "exit=$?" >&2; } | head -n 1`],
      { cwd: root },
    );
    t.after(() => child.kill('SIGKILL'));
    let stderr = '';
    child.stderr.on('data', (chunk) => (stderr += chunk));
    await until(() => stderr, /exit=\d+/);
    assert.equal(stderr, 'exit=0\n');
  },
);

test('a user who runs logs in a repository with no run log sees an error and exit code 1', async () => {
  const root = await mkdtemp(join(tmpdir(), 'next-issue-'));
  await must('git', ['init', '-q'], { cwd: root });
  const error = await promisify(execFile)(process.execPath, [CLI, 'logs'], { cwd: root }).then(
    () => undefined,
    (failure: { code: number; stderr: string }) => failure,
  );
  assert.equal(error?.code, 1);
  assert.equal(error?.stderr, 'next-issue: no run log in .next-issue/runs\n');
});

async function inTerminal(command: string): Promise<string[]> {
  const dir = await mkdtemp(join(tmpdir(), 'next-issue-'));
  const script = join(dir, 'run.sh');
  await writeFile(script, command);
  return [
    '-c',
    process.platform === 'darwin'
      ? `cat | script -q /dev/null sh "${script}"`
      : `cat | script -qfc 'sh "${script}"' /dev/null`,
  ];
}

for (const json of [false, true]) {
  test(`a user who runs logs${json ? ' --json' : ''} in a terminal sees the last events that fit the screen, then new ones, until Ctrl-C`, async (t) => {
    const { root, file } = await runLog(Array.from({ length: 10 }, (_, index) => event(index + 1)));
    const command = `stty rows 4 cols 300; trap : INT; "${process.execPath}" "${CLI}" logs${json ? ' --json' : ''}; echo "exit=$?"`;
    const child = spawn('sh', await inTerminal(command), { cwd: root });
    t.after(() => child.kill('SIGKILL'));
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    const read = () => output.replace(/\r/g, '');
    await until(read, /step10\.end/);
    await appendFile(file, `${event(11)}\n`);
    await until(read, /step11\.end/);
    child.stdin.write('\x03');
    await until(read, /exit=\d+/);
    const lines = read()
      .split('\n')
      .filter((line) => line.includes('step'));
    assert.deepEqual(
      lines.map((line) => /step\d+/.exec(line)![0]),
      ['step8', 'step9', 'step10', 'step11'],
    );
    assert.equal(
      lines.every((line) => line.startsWith('{')),
      json,
    );
    assert.match(read(), /exit=0/);
  });
}

test('a user who runs --help sees the logs command', async () => {
  const { stdout } = await promisify(execFile)(process.execPath, [CLI, '--help']);
  assert.match(stdout, /^ {2}logs {9}show the latest run log and follow it$/m);
});
