import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import {
  access,
  appendFile,
  mkdir,
  readdir,
  readFile,
  realpath,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { must } from '../src/shared/exec.mts';
import { processStart } from '../src/shared/lock.mts';
import { runsDir, stateDir } from '../src/shared/state.mts';
import { workerPaths } from '../src/shared/worker-paths.mts';
import { idleGh, installGh } from './fake-gh.mts';
import { linkedWorktree, repository, until } from './helpers.mts';
import { tempDir } from './temp-dir.mts';
import { connect } from './worker-harness.mts';

const CLI = fileURLToPath(new URL('../src/cli.mts', import.meta.url));

async function serveWorker(root: string, env: NodeJS.ProcessEnv = process.env) {
  const child = spawn(process.execPath, [CLI, 'serve'], { cwd: root, env });
  let stderr = '';
  child.stderr.on('data', (chunk) => (stderr += chunk));
  const exited = new Promise<NodeJS.Signals | null>((resolve) =>
    child.on('exit', (_code, signal) => resolve(signal)),
  );
  for (let left = 600; left > 0 && !stderr.includes('listening'); left -= 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return { child, exited, stderr: () => stderr };
}

async function initCommand(cwd: string) {
  return promisify(execFile)(process.execPath, [CLI, 'init', '--scope', 'user'], {
    cwd,
    env: { ...process.env, HOME: await tempDir() },
  });
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

test('a user who runs another command with a root next-issue.config.json gets an error that the config moved and says to run npx -y next-issue@latest init', async () => {
  const root = await repository();
  await writeFile(join(root, 'next-issue.config.json'), '{}\n');
  await assert.rejects(
    promisify(execFile)(process.execPath, [CLI, 'stop'], { cwd: root }),
    (error: { code: number; stderr: string }) => {
      assert.notEqual(error.code, 0);
      assert.match(
        error.stderr,
        /moved to \.next-issue\/config\.json\. Run npx -y next-issue@latest init to move it\./,
      );
      return true;
    },
  );
});

test('a user who starts a watch run with no open issue sees start exit with 0 and one wait of 1 minute in the worker log', async (t) => {
  const root = await repository();
  await watchingRun(t, root);
  const waits = readFileSync(workerPaths(root).logPath, 'utf8')
    .split('\n')
    .filter((line) => line.includes('watch.wait'))
    .map((line) => line.replace(/^\S+ /, ''));
  assert.deepEqual(waits, ['watch.wait minutes=1']);
});

const STARTED = /^the run started in the worker/m;

const HELD =
  /^the next-issue worker exited before it listened: exit code 1 \(see \.next-issue\/worker\.log\)$/m;

async function holdLock(root: string, pid: number): Promise<string> {
  await mkdir(stateDir(root), { recursive: true });
  const lock = `${pid} ${await processStart(pid)}\n`;
  await writeFile(workerPaths(root).lockPath, lock);
  return lock;
}

async function refusedRun(t: TestContext, root: string, cwd = root) {
  const lockPath = workerPaths(root).lockPath;
  const lock = await readFile(lockPath, 'utf8');
  const bin = await tempDir();
  const called = join(bin, 'called');
  await installGh(t, bin, `#!/bin/sh\ntouch "${called}"\nexit 1\n`);
  const error = await promisify(execFile)(process.execPath, [CLI, 'start'], { cwd }).then(
    () => undefined,
    (failure: { code: number; stderr: string }) => failure,
  );
  assert.equal(error?.code, 1);
  assert.equal(await exists(called), false);
  assert.equal(await readFile(lockPath, 'utf8'), lock);
  return error?.stderr ?? '';
}

async function watchingRun(t: TestContext, root: string) {
  await must('git', ['remote', 'add', 'origin', 'https://github.com/acme/watch.git'], {
    cwd: root,
  });
  const env = await idleGh(t);
  await promisify(execFile)(process.execPath, [CLI, 'start', '--watch', 'on'], { cwd: root, env });
  t.after(async () => {
    await promisify(execFile)(process.execPath, [CLI, 'stop'], { cwd: root });
    assert.equal(await gone(workerPaths(root).lockPath), true);
  });
  const log = workerPaths(root).logPath;
  await until(() => readFileSync(log, 'utf8').includes('watch.wait'), 'the wait after the pass');
}

test('a user who runs refresh sees an unknown command error and exit code 1', async () => {
  const root = await repository();
  const error = await cliFails(['refresh'], { cwd: root });
  assert.equal(error?.code, 1);
  assert.match(error?.stderr ?? '', /Unknown command: refresh/);
});

test('a user who starts a run without init gets .next-issue/ and .worktrees/ in info/exclude, out of .gitignore, and no config file', async (t) => {
  const root = await repository();
  await writeFile(join(root, '.gitignore'), 'node_modules/\n.next-issue/\n');
  await watchingRun(t, root);
  const exclude = await readFile(join(root, '.git/info/exclude'), 'utf8');
  assert.match(exclude, /^\.next-issue\/$/m);
  assert.match(exclude, /^\.worktrees\/$/m);
  assert.equal(await readFile(join(root, '.gitignore'), 'utf8'), 'node_modules/\n');
  assert.equal(await exists(join(root, '.next-issue/config.json')), false);
});

test('a user who starts the worker without init gets .next-issue/ and .worktrees/ once in info/exclude', async (t) => {
  const root = await repository();
  await appendFile(join(root, '.git/info/exclude'), '.worktrees/\n');
  const { child } = await serveWorker(root);
  t.after(() => child.kill('SIGKILL'));
  const exclude = await readFile(join(root, '.git/info/exclude'), 'utf8');
  assert.equal(exclude.split('\n').filter((line) => line === '.next-issue/').length, 1);
  assert.equal(exclude.split('\n').filter((line) => line === '.worktrees/').length, 1);
});

test('a user who runs next-issue start while another run of start is going in the repository sees the status of that run, exit code 0 and no issue read', async (t) => {
  const root = await repository();
  await watchingRun(t, root);
  const bin = await tempDir();
  const called = join(bin, 'called');
  await installGh(t, bin, `#!/bin/sh\ntouch "${called}"\nexit 1\n`);
  const { stderr } = await promisify(execFile)(process.execPath, [CLI, 'start'], { cwd: root });
  assert.match(stderr, /^the run is running in worker .*\nwatching on, hunting off\n/m);
  assert.equal(await exists(called), false);
});

test('a user who runs next-issue in a linked worktree while a process that does not listen holds worker.lock of the main worktree sees that the worker it started exited, exit code 1 and no issue read', async (t) => {
  const root = await repository();
  const linked = await linkedWorktree(root);
  const other = spawn('sleep', ['30']);
  t.after(() => other.kill('SIGKILL'));
  await holdLock(root, other.pid!);
  assert.match(await refusedRun(t, root, linked), HELD);
  assert.equal(await exists(join(linked, '.next-issue')), false);
});

test('a user who runs next-issue while worker.lock holds only the process id of a live process sees that the worker it started exited, exit code 1 and no issue read', async (t) => {
  const root = await repository();
  const other = spawn('sleep', ['30']);
  t.after(() => other.kill('SIGKILL'));
  await mkdir(stateDir(root), { recursive: true });
  await writeFile(workerPaths(root).lockPath, `${other.pid}\n`);
  assert.match(await refusedRun(t, root), HELD);
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
  assert.equal(error?.stderr, 'another worker is running\n');
});

test('a user who serves the repository while another process holds worker.lock sees that another worker is running and gets no worker', async (t) => {
  const root = await repository();
  const other = spawn('sleep', ['30']);
  t.after(() => other.kill('SIGKILL'));
  const lock = await holdLock(root, other.pid!);
  const error = await promisify(execFile)(process.execPath, [CLI, 'serve'], { cwd: root }).then(
    () => undefined,
    (failure: { code: number; stderr: string }) => failure,
  );
  assert.equal(error?.code, 1);
  assert.match(error?.stderr ?? '', /\nanother worker is running\n$/);
  assert.equal(await exists(workerPaths(root).socketPath), false);
  assert.equal(await readFile(workerPaths(root).lockPath, 'utf8'), lock);
});

async function singleRun(root: string) {
  const { stderr } = await promisify(execFile)(process.execPath, [CLI, 'start'], { cwd: root });
  return stderr;
}

async function gone(path: string): Promise<boolean> {
  for (let left = 100; left > 0 && (await exists(path)); left -= 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !(await exists(path));
}

test('a user whose run ends finds no worker.lock left in the repository once the worker it started closes', async () => {
  const root = await repository();
  assert.match(await singleRun(root), STARTED);
  assert.equal(await gone(workerPaths(root).lockPath), true);
});

test('a user who starts a run in a repository with no origin finds the error of the run in the worker log once the worker closes', async () => {
  const root = await repository();
  await singleRun(root);
  assert.equal(await gone(workerPaths(root).lockPath), true);
  const log = await readFile(workerPaths(root).logPath, 'utf8');
  assert.match(log, /No such remote 'origin'/);
  assert.doesNotMatch(log, /^next-issue/m);
});

test('a user who runs next-issue over a worker.lock that a dead process left takes it over and leaves no worker.lock', async () => {
  const root = await repository();
  const dead = spawn('true');
  await new Promise((resolve) => dead.on('exit', resolve));
  await mkdir(stateDir(root), { recursive: true });
  await writeFile(workerPaths(root).lockPath, `${dead.pid} gone\n`);
  const stderr = await singleRun(root);
  assert.doesNotMatch(stderr, /exited before it listened/);
  assert.match(stderr, STARTED);
  assert.equal(await gone(workerPaths(root).lockPath), true);
});

test('a user who stops the worker with SIGTERM sees it exit and remove its socket and lock files', async () => {
  const root = await repository();
  const { child, exited, stderr } = await serveWorker(root);
  assert.match(stderr(), /^worker listening on .*\.next-issue\/worker\.sock$/m);
  child.kill('SIGTERM');
  assert.equal(await exited, 'SIGTERM');
  assert.deepEqual(await readdir(stateDir(root)), []);
});

test('a user whose terminal closes (SIGHUP) on a worker started by hand sees it exit and remove its socket and lock files', async () => {
  const root = await repository();
  const { child, exited } = await serveWorker(root);
  child.kill('SIGHUP');
  assert.equal(await exited, 'SIGHUP');
  assert.deepEqual(await readdir(stateDir(root)), []);
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
  const root = await repository();
  const dir = runsDir(root);
  await mkdir(join(dir, '2026-01-02T03-04-05-000Z', 'sessions'), { recursive: true });
  await writeFile(join(dir, '2026-01-01T00-00-00-000Z.jsonl'), `${event(99)}\n`);
  const file = join(dir, '2026-01-02T03-04-05-000Z.jsonl');
  await writeFile(file, lines.map((line) => `${line}\n`).join(''));
  return { root, file };
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
  await until(() => /step2\.end/.test(read()), 'step2.end in the output');
  await appendFile(file, `${event(3)}\n`);
  await until(() => /step3\.end/.test(read()), 'step3.end in the output');
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

const NEW_RUN = '2026-01-03T00-00-00-000Z.jsonl';

async function restart(file: string, lines: string[]): Promise<void> {
  await appendFile(file, `${event(2)}\n`);
  await writeFile(join(dirname(file), NEW_RUN), lines.map((line) => `${line}\n`).join(''));
}

test('a user who pipes logs sees the rest of the old run log, a new run marker, then the new run log when the worker restarts', async (t) => {
  const { root, file } = await runLog([event(1)]);
  const { child, read, exited } = followLogs(root, []);
  t.after(() => child.kill('SIGKILL'));
  await until(() => /step1\.end/.test(read()), 'step1.end in the output');
  await restart(file, [event(3)]);
  await until(() => /step3\.end/.test(read()), 'step3.end in the output');
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

test('a user who pipes logs sees multi-byte characters intact across a long line', async (t) => {
  const long = JSON.stringify({
    ts: '2026-01-02T03:04:05.000Z',
    kind: 'xy',
    text: 'é'.repeat(40000),
  });
  const { root } = await runLog([long]);
  const { child, read, exited } = followLogs(root, []);
  t.after(() => child.kill('SIGKILL'));
  await until(() => read().endsWith('\n'), 'a full line of output');
  child.kill('SIGINT');
  assert.equal(await exited, 0);
  assert.match(read(), /^\S+ xy text=é{117}\.\.\.\n$/);
});

test('a user who pipes logs sees a tool call as the role and kind, the tool name and the long Bash command in full', async (t) => {
  const command = `echo ${'a'.repeat(300)}`;
  const long = JSON.stringify({
    ts: '2026-01-02T03:04:05.000Z',
    issue: 607,
    role: 'fixer',
    kind: 'tool',
    tool: 'Bash',
    command,
  });
  const { root } = await runLog([long]);
  const { child, read, exited } = followLogs(root, []);
  t.after(() => child.kill('SIGKILL'));
  await until(() => read().endsWith('\n'), 'a full line of output');
  child.kill('SIGINT');
  assert.equal(await exited, 0);
  assert.match(read(), new RegExp(`^\\S+ #607 fixer\\.tool name=Bash command=${command}\\n$`));
});

test('a user who pipes logs sees the role of an agent event before its kind and not among its fields', async (t) => {
  const usage = JSON.stringify({
    ts: '2026-01-02T03:04:05.000Z',
    issue: 607,
    role: 'fixer',
    kind: 'usage',
    ms: 5,
  });
  const failed = JSON.stringify({
    ts: '2026-01-02T03:04:05.000Z',
    issue: 607,
    role: 'fixer',
    kind: 'tool.error',
    tool: 'Bash',
  });
  const { root } = await runLog([usage, failed]);
  const { child, read, exited } = followLogs(root, []);
  t.after(() => child.kill('SIGKILL'));
  await until(() => /tool\.error/.test(read()), 'tool.error in the output');
  child.kill('SIGINT');
  assert.equal(await exited, 0);
  assert.deepEqual(
    read()
      .trimEnd()
      .split('\n')
      .map((line) => line.replace(/^\S+ /, '')),
    ['#607 fixer.usage ms=5', '#607 fixer.tool.error name=Bash'],
  );
});

test('a user who pipes logs sees the valid events rendered and the line that is not JSON skipped', async (t) => {
  const { root } = await runLog([event(1), 'not json', event(2)]);
  const { child, read, exited } = followLogs(root, []);
  t.after(() => child.kill('SIGKILL'));
  await until(() => /step2\.end/.test(read()), 'step2.end in the output');
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
  await until(() => /step1\.end/.test(stdout), 'step1.end on stdout');
  await appendFile(file, `${event(2)}\n${event(3)}\n`);
  await until(() => /exit=\d+/.test(stderr), 'the exit line');
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
    await until(() => /exit=\d+/.test(stderr), 'the exit line');
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
  assert.equal(error?.stderr, 'no run log in .next-issue/runs\n');
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

test('a user who runs logs in a terminal sees the last events that fit the screen, then new ones, until Ctrl-C', async (t) => {
  const { root, file } = await runLog(Array.from({ length: 10 }, (_, index) => event(index + 1)));
  const command = `stty rows 4 cols 300; trap : INT; "${process.execPath}" "${CLI}" logs; echo "exit=$?"`;
  const child = spawn('sh', await inTerminal(command), { cwd: root });
  t.after(() => child.kill('SIGKILL'));
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  const read = () => output.replace(/\r/g, '');
  await until(() => /step10\.end/.test(read()), 'step10.end in the output');
  await appendFile(file, `${event(11)}\n`);
  await until(() => /step11\.end/.test(read()), 'step11.end in the output');
  child.stdin.write('\x03');
  await until(() => /exit=\d+/.test(read()), 'the exit line');
  const lines = read()
    .split('\n')
    .filter((line) => line.includes('step'));
  assert.deepEqual(
    lines.map((line) => /step\d+/.exec(line)![0]),
    ['step8', 'step9', 'step10', 'step11'],
  );
  assert.match(read(), /exit=0/);
});

test('a user who runs logs in a terminal sees every event of the new run log from its first when the worker restarts', async (t) => {
  const { root, file } = await runLog([event(1)]);
  const command = `stty rows 4 cols 300; trap : INT; "${process.execPath}" "${CLI}" logs; echo "exit=$?"`;
  const child = spawn('sh', await inTerminal(command), { cwd: root });
  t.after(() => child.kill('SIGKILL'));
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  const read = () => output.replace(/\r/g, '');
  await until(() => /step1\.end/.test(read()), 'step1.end in the output');
  await restart(
    file,
    Array.from({ length: 10 }, (_, index) => event(index + 3)),
  );
  await until(() => /step12\.end/.test(read()), 'step12.end in the output');
  child.stdin.write('\x03');
  await until(() => /exit=\d+/.test(read()), 'the exit line');
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
  assert.match(stdout, /^ {2}logs {14}show the latest run log and follow it$/m);
});

test('a user who runs --help sees the status command', async () => {
  const { stdout } = await promisify(execFile)(process.execPath, [CLI, '--help']);
  assert.match(stdout, /^ {2}status {12}show the going run, its worker and its running issues$/m);
});

test('a user who runs --help does not see the internal serve command', async () => {
  const { stdout } = await promisify(execFile)(process.execPath, [CLI, '--help']);
  assert.doesNotMatch(stdout, /serve/);
});

function cliFails(args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  return promisify(execFile)(process.execPath, [CLI, ...args], options).then(
    () => undefined,
    (failure: { code: number; stdout: string; stderr: string }) => failure,
  );
}

test('a user who runs next-issue with no argument sees the usage on standard error, exit code 1 and no issue read', async (t) => {
  const root = await repository();
  const { env, called } = await oldGit(t, '2.50.0');
  const error = await cliFails([], { cwd: root, env });
  const { stdout: usage } = await promisify(execFile)(process.execPath, [CLI, '--help']);
  assert.equal(error?.code, 1);
  assert.equal(error?.stdout, '');
  assert.equal(error?.stderr, usage);
  assert.equal(await exists(called), false);
});

test('a user who runs next-issue --watch on sees an error that says to use npx -y next-issue@latest start, exit code 1 and no issue read', async (t) => {
  const root = await repository();
  const { env, called } = await oldGit(t, '2.50.0');
  const error = await cliFails(['--watch', 'on'], { cwd: root, env });
  assert.equal(error?.code, 1);
  assert.match(
    error?.stderr ?? '',
    /no command given: use npx -y next-issue@latest start to start a run, or see npx -y next-issue@latest --help/,
  );
  assert.equal(await exists(called), false);
});

test('a user who runs next-issue start --once sees an unknown argument error, exit code 1 and no issue read', async (t) => {
  const root = await repository();
  const { env, called } = await oldGit(t, '2.50.0');
  const error = await cliFails(['start', '--once'], { cwd: root, env });
  assert.equal(error?.code, 1);
  assert.match(error?.stderr ?? '', /Unknown argument: --once/);
  assert.equal(await exists(called), false);
});

for (const args of [
  ['start', '--max', '1'],
  ['start', '--reset'],
  ['start', '--json'],
  ['start', '--verbose'],
  ['start', '--quiet'],
  ['logs', '--json'],
]) {
  test(`a user who runs next-issue ${args.join(' ')} sees an unknown argument error, exit code 1 and no issue read`, async (t) => {
    const root = await repository();
    const { env, called } = await oldGit(t, '2.50.0');
    const error = await cliFails(args, { cwd: root, env });
    assert.equal(error?.code, 1);
    assert.match(error?.stderr ?? '', new RegExp(`Unknown argument: ${args[1]}`));
    assert.equal(await exists(called), false);
  });
}

test('a user who runs --help sees none of the removed flags', async () => {
  const { stdout } = await promisify(execFile)(process.execPath, [CLI, '--help']);
  assert.doesNotMatch(stdout, /--max|--reset|--json|--verbose|--quiet/);
});

test('a user who runs start --help sees the usage and exit code 0', async () => {
  const help = await promisify(execFile)(process.execPath, [CLI, '--help']);
  const startHelp = await promisify(execFile)(process.execPath, [CLI, 'start', '--help']);
  assert.equal(startHelp.stdout, help.stdout);
});

test('a user who runs --help start sees the same usage as start --help and exit code 0', async () => {
  const startHelp = await promisify(execFile)(process.execPath, [CLI, 'start', '--help']);
  const helpStart = await promisify(execFile)(process.execPath, [CLI, '--help', 'start']);
  assert.equal(helpStart.stdout, startHelp.stdout);
});

test('a user who runs --help sees the npx usage line first, start as a command with the on|off run flags under it, then the watch and hunt commands', async () => {
  const { stdout } = await promisify(execFile)(process.execPath, [CLI, '--help']);
  assert.match(stdout, /^npx -y next-issue@latest <command> \[options\]\n/);
  assert.match(
    stdout,
    /^ {2}start {13}.*\n {4}--watch on\|off {2}.*default on.*\n {4}--hunt on\|off {3}.*default off.*\n {2}watch on\|off {6}.*\n {2}hunt on\|off {7}.*\n {2}init /m,
  );
});

for (const args of [
  ['logs', '--watch', 'on'],
  ['stop', '--hunt', 'off'],
]) {
  test(`a user who runs ${args.join(' ')} sees an error that says the flag belongs to start and exit code 1`, async () => {
    const root = await repository();
    const error = await cliFails(args, { cwd: root });
    assert.equal(error?.code, 1);
    assert.match(
      error?.stderr ?? '',
      new RegExp(`${args[0]} does not take ${args[1]}: it belongs to start`),
    );
  });
}

test('a user who runs serve --hunt on gets an error, exit code 1 and no worker', async () => {
  const root = await repository();
  await assert.rejects(
    promisify(execFile)(process.execPath, [CLI, 'serve', '--hunt', 'on'], { cwd: root }),
    (error: { code: number; stderr: string }) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /serve does not take --hunt/);
      return true;
    },
  );
  assert.equal(await exists(workerPaths(root).lockPath), false);
});

async function oldGit(
  t: TestContext,
  version: string,
): Promise<{ env: NodeJS.ProcessEnv; called: string }> {
  const { stdout } = await promisify(execFile)('sh', ['-c', 'command -v git']);
  const bin = await tempDir();
  const called = join(bin, 'called');
  await writeFile(
    join(bin, 'git'),
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "git version ${version}"; exit 0; fi\nexec "${stdout.trim()}" "$@"\n`,
    { mode: 0o755 },
  );
  await installGh(t, bin, `#!/bin/sh\ntouch "${called}"\nexit 1\n`);
  return { env: { ...process.env }, called };
}

const OLD_GIT = /git 2\.39\.5 is too old: next-issue needs git 2\.40 or later/;

test('a user who starts a run in the worker on git 2.39 sees the run end with an error that names the git versions and no issue read', async (t) => {
  const root = await realpath(await repository());
  await must('git', ['remote', 'add', 'origin', 'https://github.com/acme/old.git'], { cwd: root });
  const { env, called } = await oldGit(t, '2.39.5');
  const { child } = await serveWorker(root, env);
  t.after(() => child.kill('SIGKILL'));
  const client = await connect(t, workerPaths(root).socketPath);
  client.send({ type: 'start', root });
  const ended = await client.next(
    (value) => value.type === 'runs' && value.runs[root]?.error !== undefined,
  );
  assert.match((ended.type === 'runs' && ended.runs[root]?.error) || '', OLD_GIT);
  assert.equal(await exists(called), false);
});
