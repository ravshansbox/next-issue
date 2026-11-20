import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { cp, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { hasCode } from '../src/shared/errors.mts';
import { must } from '../src/shared/exec.mts';
import { lockHolder } from '../src/shared/lock.mts';
import type { RunControls } from '../src/worker/run.mts';
import { type RunRepo, startWorker } from '../src/worker/serve.mts';
import { packageVersion } from '../src/shared/version.mts';
import { type Connection, findWorker } from '../src/shared/worker-client.mts';
import { workerPaths } from '../src/shared/worker-paths.mts';
import { idleGh } from './fake-gh.mts';
import { repository, sleep, until } from './helpers.mts';
import { tempDir } from './temp-dir.mts';
import { type Client, connect, fakeRuns } from './worker-harness.mts';

const CLI = fileURLToPath(new URL('../src/cli.mts', import.meta.url));

const ORIGIN = 'https://github.com/acme/start.git';

const SKILLS = fileURLToPath(new URL('../skills/', import.meta.url));

process.env.HOME = await tempDir();

type Started = {
  child: ChildProcess;
  stdout: () => string;
  stderr: () => string;
  exited: Promise<number | null>;
};

function startCommand(
  t: TestContext,
  root: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): Started {
  return cliCommand(t, root, ['start', ...args], env);
}

function cliCommand(
  t: TestContext,
  root: string,
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): Started {
  const child = spawn(process.execPath, [CLI, ...argv], { cwd: root, env });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => (stdout += chunk));
  child.stderr.on('data', (chunk) => (stderr += chunk));
  const exited = new Promise<number | null>((resolve) => child.on('exit', resolve));
  t.after(() => child.kill('SIGKILL'));
  return { child, stdout: () => stdout, stderr: () => stderr, exited };
}

async function killWorker(root: string): Promise<void> {
  const holder = await lockHolder(workerPaths(root).lockPath);
  if (holder !== undefined && holder !== process.pid) {
    try {
      process.kill(holder, 'SIGTERM');
    } catch (error) {
      if (!hasCode(error, 'ESRCH')) {
        throw error;
      }
    }
  }
}

async function fakeWorker(
  t: TestContext,
  root: string,
  runRepo: RunRepo,
  version?: string,
  options: Pick<Parameters<typeof startWorker>[0], 'registry' | 'successorLaunch'> = {},
) {
  const { logPath: _logPath, ...paths } = workerPaths(root);
  const worker = await startWorker({
    root,
    ...paths,
    version: version ?? (await packageVersion()),
    runRepo,
    ...options,
  });
  assert.ok(worker);
  t.after(() => worker.close());
  return worker;
}

function withoutSetupNotes(text: string): string {
  return text
    .replace(/^added .* to .*\/info\/exclude\n/gm, '')
    .replace(/^wrote .*\/\.claude\/skills\/.*\n/gm, '');
}

const STARTED =
  'the run started in the worker; follow it with `npx -y next-issue@latest logs` and stop it with `npx -y next-issue@latest stop`\n';

test('a user who runs start sees one line that the run started naming logs and stop, nothing on stdout, exit code 0 and the run keep going in the worker', async (t) => {
  const root = await repository(ORIGIN);
  const fake = fakeRuns();
  await fakeWorker(t, root, fake.runRepo);
  const observer = await connect(t, workerPaths(root).socketPath);
  const started = startCommand(t, root, []);
  assert.equal(await started.exited, 0, started.stderr());
  assert.equal(withoutSetupNotes(started.stderr()), STARTED);
  assert.equal(started.stdout(), '');
  fake.controls().output?.('after start\n');
  await observer.next((value) => value.type === 'output' && value.text === 'after start\n');
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.controls().interrupts.afterIssue(), false);
  fake.finish();
});

async function assertShipped(folder: string, name: string): Promise<void> {
  const files = await readdir(join(SKILLS, name));
  assert.deepEqual((await readdir(folder)).sort(), files.sort());
  for (const file of files) {
    assert.equal(
      await readFile(join(folder, file), 'utf8'),
      await readFile(join(SKILLS, name, file), 'utf8'),
    );
  }
}

async function startWithSkills(t: TestContext, root: string, home: string): Promise<string> {
  const fake = fakeRuns();
  await fakeWorker(t, root, fake.runRepo);
  const started = startCommand(t, root, [], { ...process.env, HOME: home });
  assert.equal(await started.exited, 0, started.stderr());
  fake.finish();
  return started.stderr();
}

test('a user with outdated copies of the skills in ~/.claude/skills and .claude/skills who runs start gets each copy replaced with the shipped skill and sees updated with its folder', async (t) => {
  const root = await repository(ORIGIN);
  const home = await tempDir();
  const user = join(home, '.claude', 'skills', 'create-issue');
  const project = join(root, '.claude', 'skills', 'answer-hand-over');
  await cp(join(SKILLS, 'create-issue'), user, { recursive: true });
  await writeFile(join(user, 'old.md'), 'old');
  await cp(join(SKILLS, 'answer-hand-over'), project, { recursive: true });
  await writeFile(
    join(project, 'SKILL.md'),
    '---\nname: answer-hand-over\ndescription: Answer a next-issue hand-over.\n---\n\nold\n',
  );
  const stderr = await startWithSkills(t, root, home);
  await assertShipped(user, 'create-issue');
  await assertShipped(project, 'answer-hand-over');
  assert.match(stderr, new RegExp(`^updated ${user}$`, 'm'));
  assert.match(stderr, new RegExp(`^updated ${project}$`, 'm'));
  assert.doesNotMatch(stderr, /^wrote /m);
  assert.deepEqual(await readdir(join(home, '.claude', 'skills')), ['create-issue']);
  assert.deepEqual(await readdir(join(root, '.claude', 'skills')), ['answer-hand-over']);
});

test('a user with neither copy of a skill who runs start gets it installed in .claude/skills of the main worktree and sees wrote with its folder', async (t) => {
  const root = await repository(ORIGIN);
  const home = await tempDir();
  const stderr = await startWithSkills(t, root, home);
  for (const name of ['create-issue', 'answer-hand-over']) {
    const folder = join(root, '.claude', 'skills', name);
    await assertShipped(folder, name);
    assert.match(stderr, new RegExp(`^wrote ${folder}$`, 'm'));
  }
  assert.deepEqual(await readdir(home), []);
});

test('a user with their own create-issue skill in ~/.claude/skills who runs start keeps it unchanged, sees kept with its folder and gets no project copy of it', async (t) => {
  const root = await repository(ORIGIN);
  const home = await tempDir();
  const user = join(home, '.claude', 'skills', 'create-issue');
  const own = '---\nname: create-issue\ndescription: File a Jira issue.\n---\n\nmine\n';
  await mkdir(user, { recursive: true });
  await writeFile(join(user, 'SKILL.md'), own);
  const stderr = await startWithSkills(t, root, home);
  assert.deepEqual(await readdir(user), ['SKILL.md']);
  assert.equal(await readFile(join(user, 'SKILL.md'), 'utf8'), own);
  assert.match(stderr, new RegExp(`^kept ${user}: not a next-issue skill$`, 'm'));
  assert.doesNotMatch(stderr, /^updated /m);
  assert.deepEqual(await readdir(join(root, '.claude', 'skills')), ['answer-hand-over']);
});

test('a user whose repository tracks an outdated .claude/skills/create-issue with uncommitted edits who runs start keeps every file of it as it is, sees kept with its folder and gets no other copy of it', async (t) => {
  const root = await repository(ORIGIN);
  const home = await tempDir();
  const project = join(root, '.claude', 'skills', 'create-issue');
  await cp(join(SKILLS, 'create-issue'), project, { recursive: true });
  await writeFile(join(project, 'old.md'), 'old');
  await must('git', ['add', '.claude/skills/create-issue'], { cwd: root });
  const edited = '---\nname: create-issue\ndescription: File a next-issue issue.\n---\n\nedited\n';
  await writeFile(join(project, 'SKILL.md'), edited);
  const before = await readdir(project, { recursive: true });
  const stderr = await startWithSkills(t, root, home);
  assert.deepEqual(await readdir(project, { recursive: true }), before);
  assert.equal(await readFile(join(project, 'SKILL.md'), 'utf8'), edited);
  assert.equal(await readFile(join(project, 'old.md'), 'utf8'), 'old');
  assert.match(stderr, new RegExp(`^kept ${project}: tracked by git$`, 'm'));
  assert.doesNotMatch(stderr, /create-issue$/m);
  assert.deepEqual(await readdir(home), []);
});

test('a user whose copies of the skills match the shipped ones who runs start keeps them as they are and sees nothing about them', async (t) => {
  const root = await repository(ORIGIN);
  const home = await tempDir();
  const user = join(home, '.claude', 'skills', 'create-issue');
  const project = join(root, '.claude', 'skills', 'answer-hand-over');
  await cp(join(SKILLS, 'create-issue'), user, { recursive: true });
  await cp(join(SKILLS, 'answer-hand-over'), project, { recursive: true });
  const before = [(await stat(user)).ino, (await stat(project)).ino];
  const stderr = await startWithSkills(t, root, home);
  assert.deepEqual([(await stat(user)).ino, (await stat(project)).ino], before);
  assert.doesNotMatch(stderr, /\.claude\/skills/);
  assert.equal(await readdir(join(root, '.claude', 'skills')).then((names) => names.length), 1);
});

test('a user who runs start with no flags sees start exit with 0 and the run wait for new issues in the worker after a pass instead of ending', async (t) => {
  const root = await repository(ORIGIN);
  t.after(() => killWorker(root));
  const started = startCommand(t, root, [], await idleGh(t));
  assert.equal(await started.exited, 0, started.stderr());
  const log = workerPaths(root).logPath;
  await until(() => / watch\.wait /.test(readFileSync(log, 'utf8')), 'the wait after the pass');
});

test('a user who runs start with --hunt on and --watch off sees an error that hunting needs watching and exit code 1', async (t) => {
  const root = await repository(ORIGIN);
  const started = startCommand(t, root, ['--hunt', 'on', '--watch', 'off']);
  assert.equal(await started.exited, 1);
  assert.match(
    started.stderr(),
    /hunting needs watching: `--hunt on` does not go with `--watch off`/,
  );
});

test('a user who runs start with --watch and no value or another value sees an error and exit code 1', async (t) => {
  const root = await repository(ORIGIN);
  for (const args of [['--watch'], ['--watch', 'yes']]) {
    const started = startCommand(t, root, args);
    assert.equal(await started.exited, 1);
    assert.match(started.stderr(), /`--watch` takes `on` or `off`/);
  }
});

test('a user who runs watch or hunt with a run going sees the run switch, the new setting printed and exit code 0', async (t) => {
  const root = await repository(ORIGIN);
  const fake = fakeRuns();
  await fakeWorker(t, root, fake.runRepo);
  const other = await connect(t, workerPaths(root).socketPath);
  other.send({ type: 'start', root });
  await other.next((value) => value.type === 'runs' && value.runs[root]?.status === 'running');
  for (const [argv, printed, watching, hunting] of [
    [['hunt', 'on'], 'watching on, hunting on\n', true, true],
    [['watch', 'off'], 'watching off, hunting off\n', false, false],
    [['watch', 'on'], 'watching on, hunting off\n', true, false],
    [['hunt', 'off'], 'watching on, hunting off\n', true, false],
  ] as const) {
    const switched = cliCommand(t, root, [...argv]);
    assert.equal(await switched.exited, 0, switched.stderr());
    assert.equal(switched.stdout(), printed);
    assert.equal(fake.controls().watching?.on(), watching);
    assert.equal(fake.controls().hunting?.on(), hunting);
  }
  fake.finish();
});

test('a user who runs watch or hunt with no worker or no run going sees that no run is going, exit code 0 and no worker started', async (t) => {
  const root = await repository(ORIGIN);
  for (const argv of [
    ['watch', 'on'],
    ['hunt', 'off'],
  ]) {
    const switched = cliCommand(t, root, argv);
    assert.equal(await switched.exited, 0);
    assert.equal(switched.stdout(), 'no run is going in this repository\n');
  }
  await assert.rejects(readFile(workerPaths(root).logPath, 'utf8'));
  const fake = fakeRuns();
  await fakeWorker(t, root, fake.runRepo);
  const switched = cliCommand(t, root, ['watch', 'off']);
  assert.equal(await switched.exited, 0);
  assert.equal(switched.stdout(), 'no run is going in this repository\n');
  assert.equal(fake.calls.length, 0);
});

async function runningInWorker(t: TestContext, root: string) {
  const fake = fakeRuns();
  await fakeWorker(t, root, fake.runRepo);
  const other = await connect(t, workerPaths(root).socketPath);
  other.send({ type: 'start', root });
  await other.next((value) => value.type === 'runs' && value.runs[root]?.status === 'running');
  return { fake, other };
}

async function runIssues(other: Client, root: string, controls: RunControls, issues: number[]) {
  for (const issue of issues) {
    controls.onEvent!({ kind: 'issue.start', issue });
  }
  await other.next(
    (value) => value.type === 'runs' && value.runs[root]?.issues.length === issues.length,
  );
}

test('a user who runs stop while the run waits between passes with no hunt going sees that the run stopped, exit code 0 and the wait ended', async (t) => {
  const root = await repository(ORIGIN);
  const { fake, other } = await runningInWorker(t, root);
  const slept = fake.controls().interrupts.sleep(60_000);
  const stopped = cliCommand(t, root, ['stop']);
  assert.equal(await stopped.exited, 0, stopped.stderr());
  assert.equal(stopped.stdout(), 'the run stopped\n');
  assert.equal(await slept, false);
  fake.finish();
  await other.next((value) => value.type === 'runs' && value.runs[root]?.status === 'stopped');
});

test('a user who runs stop while the run is between steps of a pass with no issue held and no hunt going sees that the run is stopping and exit code 0', async (t) => {
  const root = await repository(ORIGIN);
  const { fake } = await runningInWorker(t, root);
  const stopped = cliCommand(t, root, ['stop']);
  assert.equal(await stopped.exited, 0, stopped.stderr());
  assert.equal(stopped.stdout(), 'the run is stopping\n');
  fake.finish();
});

test('a user who runs stop while the run holds issues sees that the run will stop after each of them, exit code 0 at once, and the worker go on with no signal', async (t) => {
  const root = await repository(ORIGIN);
  const { fake, other } = await runningInWorker(t, root);
  await runIssues(other, root, fake.controls(), [12, 15, 16]);
  const stopped = cliCommand(t, root, ['stop']);
  assert.equal(await stopped.exited, 0, stopped.stderr());
  assert.equal(stopped.stdout(), 'the run will stop after #12, #15 and #16\n');
  assert.equal(fake.controls().interrupts.afterIssue(), true);
  assert.equal(fake.controls().interrupts.afterRound(), false);
  await other.next((value) => value.type === 'runs' && value.runs[root]?.status === 'stopping');
  fake.finish();
  await other.next((value) => value.type === 'runs' && value.runs[root]?.status === 'stopped');
});

test('a user who runs stop while a hunt is going and no issue runs sees that the run will stop after its current hunt and exit code 0', async (t) => {
  const root = await repository(ORIGIN);
  const { fake } = await runningInWorker(t, root);
  fake.controls().onHunter!(() => true);
  const stopped = cliCommand(t, root, ['stop']);
  assert.equal(await stopped.exited, 0, stopped.stderr());
  assert.equal(stopped.stdout(), 'the run will stop after its current hunt\n');
  fake.finish();
});

test('a user who runs stop while the run holds issues and a hunt is going sees that the run will stop after them and its current hunt and exit code 0', async (t) => {
  const root = await repository(ORIGIN);
  const { fake, other } = await runningInWorker(t, root);
  await runIssues(other, root, fake.controls(), [12, 15]);
  fake.controls().onHunter!(() => true);
  const stopped = cliCommand(t, root, ['stop']);
  assert.equal(await stopped.exited, 0, stopped.stderr());
  assert.equal(stopped.stdout(), 'the run will stop after #12, #15 and its current hunt\n');
  fake.finish();
});

test('a user who runs stop with a worker that sends no stopping reply sees that the run will stop after its current issues and exit code 0', async (t) => {
  const root = await repository(ORIGIN);
  const { socketPath } = workerPaths(root);
  await mkdir(dirname(socketPath), { recursive: true });
  const progress = { status: 'running', watching: true, hunting: false, issues: [] };
  const server = new WebSocketServer({ server: createServer().listen(socketPath) });
  t.after(() => new Promise((resolve) => server.close(() => resolve(undefined))));
  t.after(() => server.options.server?.close());
  const received: unknown[] = [];
  server.on('connection', (socket) => {
    socket.send(JSON.stringify({ type: 'hello', version: '0.0.0-old' }));
    socket.send(JSON.stringify({ type: 'runs', runs: { [root]: progress } }));
    socket.on('message', (data) => received.push(JSON.parse(String(data))));
  });
  const stopped = cliCommand(t, root, ['stop']);
  assert.equal(await stopped.exited, 0, stopped.stderr());
  assert.equal(stopped.stdout(), 'the run will stop after its current issues\n');
  assert.equal(received.length, 1);
  assert.deepEqual(
    { ...(received[0] as object), id: undefined },
    {
      type: 'stop',
      root,
      after: 'issue',
      id: undefined,
    },
  );
});

test('a user who runs stop while the run is stopping sees that it is stopping already and exit code 0', async (t) => {
  const root = await repository(ORIGIN);
  const fake = fakeRuns();
  await fakeWorker(t, root, fake.runRepo);
  const other = await connect(t, workerPaths(root).socketPath);
  other.send({ type: 'start', root });
  await other.next((value) => value.type === 'runs' && value.runs[root]?.status === 'running');
  other.send({ type: 'stop', root, after: 'round' });
  await other.next((value) => value.type === 'runs' && value.runs[root]?.status === 'stopping');
  const stopped = cliCommand(t, root, ['stop']);
  assert.equal(await stopped.exited, 0, stopped.stderr());
  assert.equal(stopped.stdout(), 'the run is stopping already\n');
  assert.equal(fake.controls().interrupts.afterRound(), true);
  fake.finish();
});

test('a user who runs stop while the run stops for an upgrade sees that it will stop and not start again, exit code 0, and the upgrade dropped', async (t) => {
  const root = await repository(ORIGIN);
  const fake = fakeRuns();
  await fakeWorker(t, root, fake.runRepo, '0.0.0-old');
  const other = await connect(t, workerPaths(root).socketPath);
  other.send({ type: 'start', root, args: ['--watch', 'on'] });
  await other.next((value) => value.type === 'runs' && value.runs[root]?.status === 'running');
  other.send({ type: 'hello', version: await packageVersion() });
  await other.next((value) => value.type === 'runs' && value.runs[root]?.upgrade !== undefined);
  await runIssues(other, root, fake.controls(), [7]);
  const stopped = cliCommand(t, root, ['stop']);
  assert.equal(await stopped.exited, 0, stopped.stderr());
  assert.equal(stopped.stdout(), 'the run will stop after #7 and not start again\n');
  const dropped = await other.next(
    (value) => value.type === 'runs' && value.runs[root]?.upgrade === undefined,
  );
  assert.equal(dropped.type === 'runs' && dropped.runs[root]!.status, 'stopping');
  fake.finish();
});

test('a user who runs stop with no worker or no run going sees that no run is going, exit code 0 and no worker started', async (t) => {
  const root = await repository(ORIGIN);
  const alone = cliCommand(t, root, ['stop']);
  assert.equal(await alone.exited, 0);
  assert.equal(alone.stdout(), 'no run is going in this repository\n');
  await assert.rejects(readFile(workerPaths(root).logPath, 'utf8'));
  const fake = fakeRuns();
  await fakeWorker(t, root, fake.runRepo);
  const idle = cliCommand(t, root, ['stop']);
  assert.equal(await idle.exited, 0);
  assert.equal(idle.stdout(), 'no run is going in this repository\n');
  assert.equal(fake.calls.length, 0);
});

test('a user who runs status with a run going sees its status, the worker version, watching, hunting and each running issue with its step, exit code 0 and the run unchanged', async (t) => {
  const root = await repository(ORIGIN);
  const fake = fakeRuns();
  await fakeWorker(t, root, fake.runRepo);
  const other = await connect(t, workerPaths(root).socketPath);
  other.send({ type: 'start', root, args: ['--hunt', 'on'] });
  await other.next((value) => value.type === 'runs' && value.runs[root]?.status === 'running');
  const controls = fake.controls();
  controls.onEvent!({ kind: 'issue.start', issue: 624 });
  controls.onEvent!({ kind: 'review.start', issue: 624, round: 2 });
  controls.onEvent!({ kind: 'issue.start', issue: 625 });
  controls.onEvent!({ kind: 'issue.start', issue: 626 });
  controls.onEvent!({ kind: 'ci-checks.start', issue: 626 });
  await other.next((value) => value.type === 'runs' && value.runs[root]?.issues.length === 3);
  const status = cliCommand(t, root, ['status']);
  assert.equal(await status.exited, 0, status.stderr());
  assert.equal(
    status.stdout(),
    [
      `running in worker ${await packageVersion()}`,
      'watching on, hunting on',
      '#624 reviewing (round 2)',
      '#625 starting',
      '#626 waiting for checks',
      '',
    ].join('\n'),
  );
  assert.equal(controls.interrupts.afterIssue(), false);
  assert.equal(controls.hunting?.on(), true);
  assert.equal(controls.watching?.on(), true);
  fake.finish();
});

test('a user who runs status while the worker looks for an issue or waits to look again sees "looking for an issue", then "looking again in <n> minutes", and only the issue lines while an issue runs', async (t) => {
  const root = await repository(ORIGIN);
  const fake = fakeRuns();
  await fakeWorker(t, root, fake.runRepo);
  const other = await connect(t, workerPaths(root).socketPath);
  other.send({ type: 'start', root });
  await other.next((value) => value.type === 'runs' && value.runs[root]?.status === 'running');
  const controls = fake.controls();
  const statusLine = async (): Promise<string> => {
    const status = cliCommand(t, root, ['status']);
    assert.equal(await status.exited, 0, status.stderr());
    return status.stdout().split('\n').slice(2).join('\n');
  };
  assert.equal(await statusLine(), 'looking for an issue\n');
  controls.onEvent!({ kind: 'issue.start', issue: 636 });
  await other.next((value) => value.type === 'runs' && value.runs[root]?.issues.length === 1);
  assert.equal(await statusLine(), '#636 starting\n');
  controls.onEvent!({ kind: 'issue.end', issue: 636 });
  await other.next((value) => value.type === 'runs' && value.runs[root]?.issues.length === 0);
  assert.equal(await statusLine(), 'looking for an issue\n');
  const ago = new Date(Date.now() - 61_000).toISOString();
  controls.onEvent!({ kind: 'watch.wait', minutes: 3, ts: ago });
  await other.next((value) => value.type === 'runs' && value.runs[root]?.looking === false);
  assert.equal(await statusLine(), 'looking again in 2 minutes\n');
  controls.onEvent!({ kind: 'watch.wait', minutes: 1, ts: new Date().toISOString() });
  await other.next((value) => value.type === 'runs' && value.runs[root]?.nextLook !== undefined);
  assert.equal(await statusLine(), 'looking again in 1 minute\n');
  controls.onEvent!({ kind: 'watch.wake' });
  await other.next((value) => value.type === 'runs' && value.runs[root]?.looking === true);
  assert.equal(await statusLine(), 'looking for an issue\n');
  fake.finish();
});

test('a user who runs status while a hunt runs sees "hunting for bugs" after the idle line or the issue lines, and no such line once the hunt ends', async (t) => {
  const root = await repository(ORIGIN);
  const fake = fakeRuns();
  await fakeWorker(t, root, fake.runRepo);
  const other = await connect(t, workerPaths(root).socketPath);
  other.send({ type: 'start', root, args: ['--hunt', 'on'] });
  await other.next((value) => value.type === 'runs' && value.runs[root]?.status === 'running');
  const controls = fake.controls();
  const statusLines = async (): Promise<string> => {
    const status = cliCommand(t, root, ['status']);
    assert.equal(await status.exited, 0, status.stderr());
    return status.stdout().split('\n').slice(1).join('\n');
  };
  assert.equal(await statusLines(), 'watching on, hunting on\nlooking for an issue\n');
  controls.onEvent!({ kind: 'hunt.start' });
  await other.next((value) => value.type === 'runs' && value.runs[root]?.hunt === true);
  assert.equal(
    await statusLines(),
    'watching on, hunting on\nlooking for an issue\nhunting for bugs\n',
  );
  controls.onEvent!({ kind: 'issue.start', issue: 654 });
  await other.next((value) => value.type === 'runs' && value.runs[root]?.issues.length === 1);
  assert.equal(await statusLines(), 'watching on, hunting on\n#654 starting\nhunting for bugs\n');
  controls.onEvent!({ kind: 'hunt.end' });
  await other.next((value) => value.type === 'runs' && value.runs[root]?.hunt === undefined);
  assert.equal(await statusLines(), 'watching on, hunting on\n#654 starting\n');
  fake.finish();
});

test('a user who runs status while the run stops for an upgrade sees the run stopping, the upgrade and that no issue is running', async (t) => {
  const root = await repository(ORIGIN);
  const fake = fakeRuns();
  await fakeWorker(t, root, fake.runRepo, '0.0.0-old');
  const other = await connect(t, workerPaths(root).socketPath);
  other.send({ type: 'start', root });
  await other.next((value) => value.type === 'runs' && value.runs[root]?.status === 'running');
  other.send({ type: 'hello', version: await packageVersion() });
  await other.next((value) => value.type === 'runs' && value.runs[root]?.upgrade !== undefined);
  const status = cliCommand(t, root, ['status']);
  assert.equal(await status.exited, 0, status.stderr());
  assert.equal(
    status.stdout(),
    [
      'stopping in worker 0.0.0-old',
      'watching on, hunting off',
      `stopping for an upgrade to ${await packageVersion()}`,
      'no issue is running',
      '',
    ].join('\n'),
  );
  fake.finish();
});

test('a user who runs status with no worker or no run going sees that no run is going, exit code 0 and no worker started', async (t) => {
  const root = await repository(ORIGIN);
  const alone = cliCommand(t, root, ['status']);
  assert.equal(await alone.exited, 0);
  assert.equal(alone.stdout(), 'no run is going in this repository\n');
  await assert.rejects(readFile(workerPaths(root).logPath, 'utf8'));
  const fake = fakeRuns();
  await fakeWorker(t, root, fake.runRepo);
  const idle = cliCommand(t, root, ['status']);
  assert.equal(await idle.exited, 0);
  assert.equal(idle.stdout(), 'no run is going in this repository\n');
  assert.equal(fake.calls.length, 0);
});

test('a user who runs watch or hunt with no value or another value sees an error and exit code 1', async (t) => {
  const root = await repository(ORIGIN);
  for (const argv of [['watch'], ['hunt', 'yes']]) {
    const switched = cliCommand(t, root, argv);
    assert.equal(await switched.exited, 1);
    assert.match(switched.stderr(), new RegExp(`\`${argv[0]}\` takes \`on\` or \`off\``));
  }
});

test('a user who runs start with no worker sees a worker start in the background with its output in .next-issue/worker.log, the started line and exit code 0', async (t) => {
  const root = await repository();
  const started = startCommand(t, root, []);
  assert.equal(await started.exited, 0, started.stderr());
  assert.equal(withoutSetupNotes(started.stderr()), STARTED);
  const log = await readFile(workerPaths(root).logPath, 'utf8');
  assert.match(log, /^worker listening on .*worker\.sock$/m);
});

test('a user who runs start while an idle worker is alive sees the run go in that worker, the started line and nothing on stdout', async (t) => {
  const root = await repository(ORIGIN);
  const env = await idleGh(t);
  const worker = spawn(process.execPath, [CLI, 'serve'], { cwd: root, env });
  t.after(() => worker.kill('SIGKILL'));
  let workerOutput = '';
  worker.stderr.on('data', (chunk) => (workerOutput += chunk));
  await until(() => workerOutput.includes('listening'), 'the worker to listen');
  const started = startCommand(t, root, ['--watch', 'off'], env);
  assert.equal(await started.exited, 0);
  await until(() => / run\.start /.test(workerOutput), 'the run to start in the worker');
  assert.equal(withoutSetupNotes(started.stderr()), STARTED);
  assert.equal(started.stdout(), '');
});

test('a user who runs start while an older idle worker is alive sees it close and the run go in a new worker', async (t) => {
  const root = await repository();
  const fake = fakeRuns();
  const older = await fakeWorker(t, root, fake.runRepo, '0.0.0-old');
  const started = startCommand(t, root, []);
  await older.closed;
  assert.equal(await started.exited, 0, started.stderr());
  assert.equal(withoutSetupNotes(started.stderr()), STARTED);
  assert.equal(fake.calls.length, 0);
});

test('a user who runs start while an older worker has a watch run going sees the status with the coming update and exit code 0, and the run go on in the newer worker with the hunting start switched on', async (t) => {
  const root = await repository(ORIGIN);
  await idleGh(t);
  t.after(() => killWorker(root));
  const fake = fakeRuns();
  const older = await fakeWorker(t, root, fake.runRepo, '0.0.0-old');
  const other = await connect(t, workerPaths(root).socketPath);
  other.send({ type: 'start', root, args: ['--watch', 'on'] });
  await other.next((value) => value.type === 'runs' && value.runs[root]?.status === 'running');
  const started = startCommand(t, root, ['--hunt', 'on']);
  assert.equal(await started.exited, 0, started.stderr());
  const version = await packageVersion();
  assert.equal(
    withoutSetupNotes(started.stderr()),
    [
      'a run is going already',
      'stopping in worker 0.0.0-old',
      'watching on, hunting on',
      `stopping for an upgrade to ${version}`,
      'no issue is running',
      '',
    ].join('\n'),
  );
  assert.equal(fake.calls.length, 1);
  fake.finish();
  await older.closed;
  let newer: Connection | undefined;
  while (newer?.runs[root] === undefined) {
    newer?.close();
    await sleep(50);
    newer = await findWorker(root);
  }
  t.after(() => newer.close());
  assert.equal(newer.version, version);
  assert.equal(newer.runs[root]?.watching, true);
  assert.equal(newer.runs[root]?.hunting, true);
});

async function goingRun(t: TestContext, root: string, args: string[] = []) {
  const fake = fakeRuns();
  await fakeWorker(t, root, fake.runRepo);
  const other = await connect(t, workerPaths(root).socketPath);
  other.send({ type: 'start', root, args });
  await other.next((value) => value.type === 'runs' && value.runs[root]?.status === 'running');
  return { fake, other };
}

function statusLines(status: string, settings: string, idle = 'looking for an issue'): string {
  return ['a run is going already', status, settings, idle, ''].join('\n');
}

test('a user who runs start while a run is going sees the status of that run on stderr, exit code 0, and the run keep going with its settings and no second run', async (t) => {
  const root = await repository(ORIGIN);
  const { fake } = await goingRun(t, root, ['--hunt', 'on']);
  const started = startCommand(t, root, []);
  assert.equal(await started.exited, 0, started.stderr());
  assert.equal(
    withoutSetupNotes(started.stderr()),
    statusLines(`running in worker ${await packageVersion()}`, 'watching on, hunting on'),
  );
  assert.equal(started.stdout(), '');
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.controls().interrupts.afterIssue(), false);
  assert.equal(fake.controls().hunting?.on(), true);
  fake.finish();
});

test('a user who runs start with --watch or --hunt while a run is going sees the run switch to the given settings, the new settings in the status and exit code 0', async (t) => {
  const root = await repository(ORIGIN);
  const { fake } = await goingRun(t, root);
  for (const [args, settings, watching, hunting] of [
    [['--hunt', 'on'], 'watching on, hunting on', true, true],
    [['--watch', 'off'], 'watching off, hunting off', false, false],
    [['--watch', 'on', '--hunt', 'off'], 'watching on, hunting off', true, false],
  ] as const) {
    const started = startCommand(t, root, [...args]);
    assert.equal(await started.exited, 0, started.stderr());
    assert.equal(
      withoutSetupNotes(started.stderr()),
      statusLines(`running in worker ${await packageVersion()}`, settings),
    );
    assert.equal(fake.controls().watching?.on(), watching);
    assert.equal(fake.controls().hunting?.on(), hunting);
  }
  assert.equal(fake.calls.length, 1);
  fake.finish();
});

test('a user who runs start after a stop sees start fail with exit code 1 and the stop go on', async (t) => {
  for (const after of ['issue', 'round', 'now'] as const) {
    const root = await repository(ORIGIN);
    const { fake, other } = await goingRun(t, root);
    other.send({ type: 'stop', root, after });
    await other.next((value) => value.type === 'runs' && value.runs[root]?.status === 'stopping');
    const started = startCommand(t, root, ['--hunt', 'on']);
    assert.equal(await started.exited, 1);
    assert.match(started.stderr(), /^the run is stopping$/m);
    assert.equal(fake.controls().interrupts.afterIssue(), true);
    assert.equal(fake.controls().interrupts.afterRound(), after !== 'issue');
    assert.equal(fake.controls().hunting?.on(), false);
    assert.equal(fake.calls.length, 1);
    fake.finish();
  }
});

test('a user who runs a newer start with --watch off after a stop after the round in a worker that joins runs sees start fail with exit code 1 and the run keep watching', async (t) => {
  const root = await repository(ORIGIN);
  const fake = fakeRuns();
  await fakeWorker(t, root, fake.runRepo, '0.0.0-old');
  const other = await connect(t, workerPaths(root).socketPath);
  other.send({ type: 'start', root });
  await other.next((value) => value.type === 'runs' && value.runs[root]?.status === 'running');
  other.send({ type: 'stop', root, after: 'round' });
  await other.next((value) => value.type === 'runs' && value.runs[root]?.status === 'stopping');
  const started = startCommand(t, root, ['--watch', 'off']);
  assert.equal(await started.exited, 1);
  assert.match(started.stderr(), /^the run is stopping$/m);
  assert.equal(fake.controls().watching?.on(), true);
  assert.equal(fake.controls().interrupts.afterRound(), true);
  fake.finish();
});

test('a user who runs start --hunt on while a worker older than request ids has a run going sees the run switch hunting on, the status and exit code 0', async (t) => {
  const root = await repository(ORIGIN);
  const { socketPath } = workerPaths(root);
  await mkdir(dirname(socketPath), { recursive: true });
  const progress = { status: 'running', watching: true, hunting: false, issues: [] };
  const server = new WebSocketServer({ server: createServer().listen(socketPath) });
  t.after(() => new Promise((resolve) => server.close(() => resolve(undefined))));
  t.after(() => server.options.server?.close());
  server.on('connection', (socket) => {
    socket.send(JSON.stringify({ type: 'hello', version: '0.0.0-old' }));
    socket.send(JSON.stringify({ type: 'runs', runs: { [root]: progress } }));
    socket.on('message', (data) => {
      const value = JSON.parse(String(data));
      if (value.type === 'start') {
        socket.send(
          JSON.stringify({
            type: 'error',
            root,
            message: 'a run is going in this repository already',
          }),
        );
      } else if (value.type === 'hunt') {
        Object.assign(progress, { hunting: value.on, watching: true });
        socket.send(JSON.stringify({ type: 'runs', runs: { [root]: progress } }));
      }
    });
  });
  const started = startCommand(t, root, ['--hunt', 'on']);
  assert.equal(await started.exited, 0, started.stderr());
  assert.equal(
    withoutSetupNotes(started.stderr()),
    statusLines('running in worker 0.0.0-old', 'watching on, hunting on', 'no issue is running'),
  );
});

test('a user who runs stop while the run stops for an upgrade with no issue held and no hunt going sees that it is stopping and will not start again', async (t) => {
  const root = await repository(ORIGIN);
  const fake = fakeRuns();
  await fakeWorker(t, root, fake.runRepo, '0.0.0-old');
  const other = await connect(t, workerPaths(root).socketPath);
  other.send({ type: 'start', root, args: ['--watch', 'on'] });
  await other.next((value) => value.type === 'runs' && value.runs[root]?.status === 'running');
  other.send({ type: 'hello', version: await packageVersion() });
  await other.next((value) => value.type === 'runs' && value.runs[root]?.upgrade !== undefined);
  const stopped = cliCommand(t, root, ['stop']);
  assert.equal(await stopped.exited, 0, stopped.stderr());
  assert.equal(stopped.stdout(), 'the run is stopping and will not start again\n');
  fake.finish();
});
