import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import {
  access,
  appendFile,
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { must } from '../src/exec.mts';
import { processStart } from '../src/lock.mts';
import { runsDir, stateDir } from '../src/state.mts';
import { workerPaths } from '../src/worker-paths.mts';
import { tempDir } from './temp-dir.mts';
import { connect } from './worker-harness.mts';

const CLI = fileURLToPath(new URL('../src/cli.mts', import.meta.url));

async function stopCommand(root: string): Promise<string> {
  const { stdout } = await promisify(execFile)(process.execPath, [CLI, 'stop'], { cwd: root });
  return stdout;
}

async function repository(): Promise<string> {
  const root = await tempDir();
  await must('git', ['init', '-q'], { cwd: root });
  return root;
}

async function serveWorker(root: string, env: NodeJS.ProcessEnv = process.env) {
  const child = spawn(process.execPath, [CLI, 'serve'], { cwd: root, env });
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

async function linkedWorktree(root: string): Promise<string> {
  await must(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'first'],
    { cwd: root },
  );
  const linked = join(root, '.worktrees', '42');
  await must('git', ['worktree', 'add', '-q', '-b', '42', linked], { cwd: root });
  return linked;
}

async function initCommand(cwd: string) {
  return promisify(execFile)(process.execPath, [CLI, 'init'], { cwd });
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

test('a user who runs init gets .next-issue/ and .worktrees/ once in info/exclude and no .gitignore', async () => {
  const root = await repository();
  await initCommand(root);
  await initCommand(root).catch(() => undefined);
  const exclude = await readFile(join(root, '.git/info/exclude'), 'utf8');
  assert.equal(exclude.split('\n').filter((line) => line === '.next-issue/').length, 1);
  assert.equal(exclude.split('\n').filter((line) => line === '.worktrees/').length, 1);
  assert.equal(await exists(join(root, '.gitignore')), false);
});

test('a user who runs init in a linked worktree gets the entries in the shared info/exclude and the config in the main worktree', async () => {
  const root = await repository();
  const linked = await linkedWorktree(root);
  await initCommand(linked);
  const exclude = await readFile(join(root, '.git/info/exclude'), 'utf8');
  assert.match(exclude, /^\.next-issue\/$/m);
  assert.match(exclude, /^\.worktrees\/$/m);
  assert.equal(await exists(join(root, '.next-issue/config.json')), true);
  assert.equal(await exists(join(linked, '.next-issue')), false);
});

test('a user who runs init sees .next-issue/ and .worktrees/ removed from .gitignore and other lines kept', async () => {
  const root = await repository();
  await writeFile(join(root, '.gitignore'), 'node_modules/\n.next-issue/\n  dist/\n.worktrees/\n');
  await initCommand(root);
  assert.equal(await readFile(join(root, '.gitignore'), 'utf8'), 'node_modules/\n  dist/\n');
});

test('a user who runs init sees a .gitignore deleted when only next-issue entries were in it', async () => {
  const root = await repository();
  await writeFile(join(root, '.gitignore'), '.next-issue/\n.worktrees/\n');
  await initCommand(root);
  assert.equal(await exists(join(root, '.gitignore')), false);
});

test('a user who runs init outside a git repository gets an error, a non-zero exit code and no file', async () => {
  const root = await tempDir();
  await assert.rejects(initCommand(root), (error: { code: number; stderr: string }) => {
    assert.notEqual(error.code, 0);
    assert.match(error.stderr, /not a git repository/);
    return true;
  });
  assert.deepEqual(await readdir(root), []);
});

test('a user who runs init gets the config at .next-issue/config.json and output that names it and info/exclude', async () => {
  const root = await repository();
  const { stdout } = await initCommand(root);
  assert.equal(await exists(join(root, '.next-issue/config.json')), true);
  assert.equal(await exists(join(root, 'next-issue.config.json')), false);
  assert.match(stdout, /\.next-issue\/config\.json/);
  assert.match(stdout, /added \.next-issue\/ to .*info\/exclude/);
  assert.match(stdout, /added \.worktrees\/ to .*info\/exclude/);
});

test('a user who runs init with a root next-issue.config.json sees it moved to .next-issue/config.json', async () => {
  const root = await repository();
  await writeFile(join(root, 'next-issue.config.json'), '{ "maxCiFixes": 9 }\n');
  const { stdout } = await initCommand(root);
  assert.equal(await exists(join(root, 'next-issue.config.json')), false);
  assert.equal(
    await readFile(join(root, '.next-issue/config.json'), 'utf8'),
    '{ "maxCiFixes": 9 }\n',
  );
  assert.match(stdout, /moved next-issue\.config\.json to .*\.next-issue\/config\.json/);
});

test('a user who runs another command with a root next-issue.config.json gets an error that the config moved', async () => {
  const root = await repository();
  await writeFile(join(root, 'next-issue.config.json'), '{}\n');
  await assert.rejects(
    promisify(execFile)(process.execPath, [CLI, 'stop'], { cwd: root }),
    (error: { code: number; stderr: string }) => {
      assert.notEqual(error.code, 0);
      assert.match(error.stderr, /moved to \.next-issue\/config\.json/);
      return true;
    },
  );
});

test('a user who runs --watch with no open issue sees one wait of 1 minute and no summary after Ctrl-C', async () => {
  const root = await tempDir();
  await must('git', ['init', '-q'], { cwd: root });
  await must('git', ['remote', 'add', 'origin', 'https://github.com/acme/watch.git'], {
    cwd: root,
  });
  const bin = await tempDir();
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

const RUNNING = (pid: number | undefined) =>
  new RegExp(
    `another next-issue worker or run \\(process id ${pid}\\) is going in this repository`,
  );

async function holdLock(root: string, pid: number): Promise<string> {
  await mkdir(stateDir(root), { recursive: true });
  const lock = `${pid} ${await processStart(pid)}\n`;
  await writeFile(workerPaths(root).lockPath, lock);
  return lock;
}

async function refusedRun(root: string, cwd = root) {
  const lockPath = workerPaths(root).lockPath;
  const lock = await readFile(lockPath, 'utf8');
  const bin = await tempDir();
  const called = join(bin, 'called');
  await writeFile(join(bin, 'gh'), `#!/bin/sh\ntouch "${called}"\nexit 1\n`, { mode: 0o755 });
  const error = await promisify(execFile)(process.execPath, [CLI, '--once'], {
    cwd,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  }).then(
    () => undefined,
    (failure: { code: number; stderr: string }) => failure,
  );
  assert.equal(error?.code, 1);
  assert.equal(await exists(called), false);
  assert.equal(await readFile(lockPath, 'utf8'), lock);
  assert.equal(await exists(join(stateDir(root), 'run.lock')), false);
  return error?.stderr ?? '';
}

async function idleGh(): Promise<NodeJS.ProcessEnv> {
  const bin = await tempDir();
  const script = `#!/bin/sh
case "$1 $2" in
  "repo view") echo '{"defaultBranchRef":{"name":"main"}}' ;;
  "issue list") echo '[]' ;;
  *) echo "unexpected: $*" >&2; exit 1 ;;
esac
`;
  await writeFile(join(bin, 'gh'), script, { mode: 0o755 });
  return { ...process.env, PATH: `${bin}:${process.env.PATH}` };
}

async function watchingRun(root: string) {
  await must('git', ['remote', 'add', 'origin', 'https://github.com/acme/watch.git'], {
    cwd: root,
  });
  const child = spawn(process.execPath, [CLI, '--watch'], { cwd: root, env: await idleGh() });
  let stderr = '';
  child.stderr.on('data', (chunk) => (stderr += chunk));
  const exited = new Promise<number | null>((resolve) => child.on('exit', resolve));
  while (!stderr.includes('watch.wait')) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return { child, exited };
}

test('a user who runs next-issue while another run is going in the repository sees an error that names it, exit code 1 and no issue read', async (t) => {
  const root = await repository();
  const { child, exited } = await watchingRun(root);
  t.after(() => child.kill('SIGKILL'));
  assert.match(await refusedRun(root), RUNNING(child.pid));
  child.kill('SIGINT');
  assert.equal(await exited, 0);
});

test('a user who runs next-issue while an idle worker is alive in the repository sees an error that names the worker, exit code 1 and no issue read', async (t) => {
  const root = await repository();
  const { child } = await serveWorker(root);
  t.after(() => child.kill('SIGKILL'));
  assert.match(await refusedRun(root), RUNNING(child.pid));
});

test('a user who runs next-issue while the worker has a run going sees an error that names the worker, exit code 1 and no issue read', async (t) => {
  const root = await realpath(await repository());
  await must('git', ['remote', 'add', 'origin', 'https://github.com/acme/watch.git'], {
    cwd: root,
  });
  const { child } = await serveWorker(root, await idleGh());
  t.after(() => child.kill('SIGKILL'));
  const client = await connect(t, workerPaths(root).socketPath);
  client.send({ type: 'start', root, args: ['--watch'] });
  await client.next(
    (value) =>
      value.type === 'runs' &&
      value.runs[root]?.status === 'running' &&
      value.runs[root].error === undefined,
  );
  assert.match(await refusedRun(root), RUNNING(child.pid));
  client.send({ type: 'start', root });
  const refusal = await client.next((value) => value.type === 'error');
  assert.equal(refusal.type === 'error' && refusal.root, root);
});

test('a user who runs next-issue in a linked worktree while another run is going in the main worktree sees the same error', async (t) => {
  const root = await repository();
  const linked = await linkedWorktree(root);
  const other = spawn('sleep', ['30']);
  t.after(() => other.kill('SIGKILL'));
  await holdLock(root, other.pid!);
  assert.match(await refusedRun(root, linked), RUNNING(other.pid));
  assert.equal(await exists(join(linked, '.next-issue')), false);
});

test('a user who runs next-issue while worker.lock holds only the process id of a live process sees that another run is going', async (t) => {
  const root = await repository();
  const other = spawn('sleep', ['30']);
  t.after(() => other.kill('SIGKILL'));
  await mkdir(stateDir(root), { recursive: true });
  await writeFile(workerPaths(root).lockPath, `${other.pid}\n`);
  assert.match(await refusedRun(root), RUNNING(other.pid));
});

test('a user who serves a linked worktree while the worker of the main worktree is going sees that another worker is running', async (t) => {
  const root = await repository();
  const linked = await linkedWorktree(root);
  const { child } = await serveWorker(root);
  t.after(() => child.kill('SIGKILL'));
  const error = await promisify(execFile)(process.execPath, [CLI, 'serve'], { cwd: linked }).then(
    () => undefined,
    (failure: { code: number; stderr: string }) => failure,
  );
  assert.equal(error?.code, 1);
  assert.equal(error?.stderr, 'next-issue: another worker is running\n');
});

test('a user who serves the repository while a command-line run is going sees that another worker is running and gets no worker', async (t) => {
  const root = await repository();
  const { child, exited } = await watchingRun(root);
  t.after(() => child.kill('SIGKILL'));
  const error = await promisify(execFile)(process.execPath, [CLI, 'serve'], { cwd: root }).then(
    () => undefined,
    (failure: { code: number; stderr: string }) => failure,
  );
  assert.equal(error?.code, 1);
  assert.equal(error?.stderr, 'next-issue: another worker is running\n');
  assert.equal(await exists(workerPaths(root).socketPath), false);
  child.kill('SIGINT');
  assert.equal(await exited, 0);
  assert.deepEqual((await readdir(stateDir(root))).includes('worker.lock'), false);
});

async function onceRun(root: string) {
  return promisify(execFile)(process.execPath, [CLI, '--once'], { cwd: root }).then(
    () => '',
    (failure: { stderr: string }) => failure.stderr,
  );
}

test('a user whose run ends finds no worker.lock and no run.lock left in the repository', async () => {
  const root = await repository();
  assert.match(await onceRun(root), /No such remote 'origin'/);
  assert.equal(await exists(workerPaths(root).lockPath), false);
  assert.equal(await exists(join(stateDir(root), 'run.lock')), false);
});

test('a user who runs next-issue over a worker.lock that a dead process left takes it over and leaves no worker.lock', async () => {
  const root = await repository();
  const dead = spawn('true');
  await new Promise((resolve) => dead.on('exit', resolve));
  await mkdir(stateDir(root), { recursive: true });
  await writeFile(workerPaths(root).lockPath, `${dead.pid} gone\n`);
  const stderr = await onceRun(root);
  assert.doesNotMatch(stderr, /is going in this repository/);
  assert.match(stderr, /No such remote 'origin'/);
  assert.equal(await exists(workerPaths(root).lockPath), false);
});

test('a user who starts a run in the worker sees it go past the worker lock and create no run.lock', async (t) => {
  const root = await realpath(await repository());
  const { child } = await serveWorker(root);
  t.after(() => child.kill('SIGKILL'));
  const client = await connect(t, workerPaths(root).socketPath);
  client.send({ type: 'start', root });
  const ended = await client.next(
    (value) => value.type === 'runs' && value.runs[root]?.status === 'failed',
  );
  assert.match(ended.type === 'runs' ? ended.runs[root]!.error! : '', /No such remote 'origin'/);
  assert.equal(await exists(join(stateDir(root), 'run.lock')), false);
});

test('a user who stops the worker with SIGTERM sees it exit and remove its socket and lock files', async () => {
  const root = await repository();
  const { child, exited, stderr } = await serveWorker(root);
  assert.match(stderr(), /worker listening on .*\.next-issue\/worker\.sock/);
  child.kill('SIGTERM');
  assert.equal(await exited, 'SIGTERM');
  assert.deepEqual(await readdir(stateDir(root)), []);
});

test('a user who stops a worker with SIGTERM leaves the socket and lock files that another worker owns', async (t) => {
  const root = await repository();
  const { child, exited } = await serveWorker(root);
  t.after(() => child.kill('SIGKILL'));
  const other = spawn('sleep', ['30']);
  t.after(() => other.kill('SIGKILL'));
  const { socketPath, lockPath } = workerPaths(root);
  const otherLock = `${other.pid} ${await processStart(other.pid!)}\n`;
  await rm(lockPath);
  await writeFile(lockPath, otherLock);
  await rm(socketPath);
  await writeFile(socketPath, '');
  child.kill('SIGTERM');
  assert.equal(await exited, 'SIGTERM');
  assert.equal(await readFile(lockPath, 'utf8'), otherLock);
  assert.equal(await exists(socketPath), true);
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
  assert.deepEqual(await readdir(stateDir(root)), []);
});

test('a user who runs stop while worker.lock holds only the process id of a live worker sees that worker exit', async (t) => {
  const root = await repository();
  const { child, exited } = await serveWorker(root);
  t.after(() => child.kill('SIGKILL'));
  const { lockPath } = workerPaths(root);
  await rm(lockPath);
  await writeFile(lockPath, `${child.pid}\n`);
  assert.equal(
    await stopCommand(root),
    `next-issue: stopped the worker with process id ${child.pid}\n`,
  );
  assert.equal(await exited, 'SIGTERM');
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
  assert.deepEqual((await readdir(stateDir(second))).sort(), ['worker.lock', 'worker.sock']);
});

test('a user who runs stop with no worker alive sees that none is running', async () => {
  const root = await repository();
  assert.equal(await stopCommand(root), 'next-issue: no worker is running\n');
  const dead = spawn(process.execPath, ['-e', '']);
  await new Promise((resolve) => dead.on('exit', resolve));
  await mkdir(stateDir(root));
  await writeFile(workerPaths(root).lockPath, `${dead.pid}\n`);
  assert.equal(await stopCommand(root), 'next-issue: no worker is running\n');
});

test('a user who runs stop while the lock holds the id of a live process that is not a worker sees that none is running and the process keeps going', async (t) => {
  const root = await repository();
  const other = spawn('sleep', ['30']);
  t.after(() => other.kill('SIGKILL'));
  await mkdir(stateDir(root));
  await writeFile(workerPaths(root).lockPath, `${other.pid} Thu Jan  1 00:00:00 1970\n`);
  assert.equal(await stopCommand(root), 'next-issue: no worker is running\n');
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(other.signalCode, null);
  assert.equal(other.exitCode, null);
});

test('a user who runs stop while a command-line run is going sees that no worker is running and the run keeps going', async (t) => {
  const root = await repository();
  const { child, exited } = await watchingRun(root);
  t.after(() => child.kill('SIGKILL'));
  assert.equal(
    await stopCommand(root),
    `next-issue: no worker is running; a command-line run (process id ${child.pid}) is going, press Ctrl-C there to stop it\n`,
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(child.exitCode, null);
  assert.equal(child.signalCode, null);
  child.kill('SIGINT');
  assert.equal(await exited, 0);
});

test('a user who serves a repository whose socket path is too long sees an error that says so', async () => {
  const root = join(await tempDir(), 'a'.repeat(120));
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
  const root = await tempDir();
  await must('git', ['init', '-q'], { cwd: root });
  const dir = runsDir(root);
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

const NEW_RUN = '2026-01-03T00-00-00-000Z.jsonl';

async function restart(file: string, lines: string[]): Promise<void> {
  await appendFile(file, `${event(2)}\n`);
  await writeFile(join(dirname(file), NEW_RUN), lines.map((line) => `${line}\n`).join(''));
}

test('a user who pipes logs sees the rest of the old run log, a new run marker, then the new run log when the worker restarts', async (t) => {
  const { root, file } = await runLog([event(1)]);
  const { child, read, exited } = followLogs(root, []);
  t.after(() => child.kill('SIGKILL'));
  await until(read, /step1\.end/);
  await restart(file, [event(3)]);
  await until(read, /step3\.end/);
  child.kill('SIGINT');
  assert.equal(await exited, 0);
  assert.deepEqual(
    read()
      .trimEnd()
      .split('\n')
      .map((line) => line.replace(/^\S+ #/, '#')),
    ['#7 step1.end ms=1', '#7 step2.end ms=2', `— new run: ${NEW_RUN} —`, '#7 step3.end ms=3'],
  );
});

test('a user who pipes logs --json sees only raw JSON lines of the old and new run logs when the worker restarts', async (t) => {
  const { root, file } = await runLog([event(1)]);
  const { child, read, exited } = followLogs(root, ['--json']);
  t.after(() => child.kill('SIGKILL'));
  await until(read, /step1\.end/);
  await restart(file, [event(3)]);
  await until(read, /step3\.end/);
  child.kill('SIGINT');
  assert.equal(await exited, 0);
  assert.equal(read(), `${event(1)}\n${event(2)}\n${event(3)}\n`);
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
  const root = await tempDir();
  await must('git', ['init', '-q'], { cwd: root });
  const error = await promisify(execFile)(process.execPath, [CLI, 'logs'], { cwd: root }).then(
    () => undefined,
    (failure: { code: number; stderr: string }) => failure,
  );
  assert.equal(error?.code, 1);
  assert.equal(error?.stderr, 'next-issue: no run log in .next-issue/runs\n');
});

async function inTerminal(command: string): Promise<string[]> {
  const dir = await tempDir();
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

test('a user who runs logs in a terminal sees every event of the new run log from its first when the worker restarts', async (t) => {
  const { root, file } = await runLog([event(1)]);
  const command = `stty rows 4 cols 300; trap : INT; "${process.execPath}" "${CLI}" logs; echo "exit=$?"`;
  const child = spawn('sh', await inTerminal(command), { cwd: root });
  t.after(() => child.kill('SIGKILL'));
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  const read = () => output.replace(/\r/g, '');
  await until(read, /step1\.end/);
  await restart(
    file,
    Array.from({ length: 10 }, (_, index) => event(index + 3)),
  );
  await until(read, /step12\.end/);
  child.stdin.write('\x03');
  await until(read, /exit=\d+/);
  assert.deepEqual(
    read()
      .split('\n')
      .filter((line) => line.includes('step'))
      .map((line) => /step\d+/.exec(line)![0]),
    Array.from({ length: 12 }, (_, index) => `step${index + 1}`),
  );
  assert.match(read(), /exit=0/);
});

test('a user who runs --help sees the logs command', async () => {
  const { stdout } = await promisify(execFile)(process.execPath, [CLI, '--help']);
  assert.match(stdout, /^ {2}logs {9}show the latest run log and follow it$/m);
});

test('a user who runs serve --hunt gets an error, exit code 1 and no worker', async () => {
  const root = await repository();
  await assert.rejects(
    promisify(execFile)(process.execPath, [CLI, 'serve', '--hunt'], { cwd: root }),
    (error: { code: number; stderr: string }) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /serve does not take --hunt/);
      return true;
    },
  );
  assert.equal(await exists(workerPaths(root).lockPath), false);
});
