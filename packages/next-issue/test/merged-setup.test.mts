import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { PORTS } from '../src/ports.mts';
import { type IssueState, writeState } from '../src/state.mts';
import { clones, git } from './clones.mts';
import { harness, ISSUE, roles } from './harness.mts';
import { pushBase, remoteMain, useGit } from './real-git.mts';
import { tempDir } from './temp-dir.mts';

test('a user whose base gains a dependency after the setup gets the dependency installed before the local checks and the change landed', async (t) => {
  const { repo, other } = await clones();
  await git(repo.root, 'config', 'user.name', 't');
  await git(repo.root, 'config', 'user.email', 't@t');
  const installed = join(await tempDir(), 'installed');
  const target = await harness(t, {
    root: repo.root,
    config: {
      setupCommand: `cat deps.txt > ${installed} 2>/dev/null || : > ${installed}`,
      checks: [`grep -q left-pad ${installed}`],
    },
  });
  useGit(target, async () => {});
  const { ports } = target.context;
  let setups = 0;
  ports.runSetup = async (command, cwd, timeoutMs) => {
    const result = await PORTS.runSetup(command, cwd, timeoutMs);
    setups += 1;
    if (setups === 1) {
      await pushBase(other, { 'deps.txt': 'left-pad\n' });
    }
    return result;
  };
  ports.runCheck = PORTS.runCheck;
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.equal(report.ciFixes, 0);
  const landed = await remoteMain(other);
  assert.deepEqual((await git(other, 'ls-tree', '--name-only', landed)).split('\n'), [
    'a.txt',
    'deps.txt',
    'implementer.txt',
  ]);
});

test('a user whose setup before the local checks writes a file that git does not ignore gets every check run on that file and the change landed without it', async (t) => {
  const { repo, other } = await clones();
  await git(repo.root, 'config', 'user.name', 't');
  await git(repo.root, 'config', 'user.email', 't@t');
  const target = await harness(t, {
    root: repo.root,
    config: {
      setupCommand: 'if [ -f deps.txt ]; then cat deps.txt > sums.txt; fi',
      checks: ['grep -q left-pad sums.txt', 'grep -q left-pad sums.txt'],
    },
  });
  useGit(target, async () => {});
  const { ports } = target.context;
  let setups = 0;
  ports.runSetup = async (command, cwd, timeoutMs) => {
    const result = await PORTS.runSetup(command, cwd, timeoutMs);
    setups += 1;
    if (setups === 1) {
      await pushBase(other, { 'deps.txt': 'left-pad\n' });
    }
    return result;
  };
  ports.runCheck = PORTS.runCheck;
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.equal(report.ciFixes, 0);
  const landed = await remoteMain(other);
  assert.deepEqual((await git(other, 'ls-tree', '--name-only', landed)).split('\n'), [
    'a.txt',
    'deps.txt',
    'implementer.txt',
  ]);
});

test('a user whose run dies during a local check after the setup wrote a file that git does not ignore gets the change landed by the next run without that file', async (t) => {
  const { repo, other } = await clones();
  await git(repo.root, 'config', 'user.name', 't');
  await git(repo.root, 'config', 'user.email', 't@t');
  const config = {
    setupCommand: 'if [ -f deps.txt ]; then cat deps.txt > sums.txt; fi',
    checks: ['grep -q left-pad sums.txt'],
  };
  const first = await harness(t, { root: repo.root, config });
  useGit(first, async () => {});
  let setups = 0;
  first.context.ports.runSetup = async (command, cwd, timeoutMs) => {
    const result = await PORTS.runSetup(command, cwd, timeoutMs);
    setups += 1;
    if (setups === 1) {
      await pushBase(other, { 'deps.txt': 'left-pad\n' });
    }
    return result;
  };
  let killed: IssueState | undefined;
  let worktree = '';
  let sitting = '';
  first.context.ports.runCheck = async (_command, cwd) => {
    killed = await first.state();
    worktree = cwd;
    sitting = await git(cwd, 'rev-parse', 'HEAD');
    first.stopNow();
    return { code: 143, output: '', timedOut: false };
  };
  assert.equal((await first.run()).outcome, 'stopped');
  await writeState(first.context.repo, killed!);
  await git(worktree, 'reset', '-q', '--hard', sitting);
  const resumed = await harness(t, {
    root: repo.root,
    config,
    issue: { ...ISSUE, labels: ['status:in-review'] },
  });
  useGit(resumed, async () => {});
  Object.assign(resumed.context.ports, { runSetup: PORTS.runSetup, runCheck: PORTS.runCheck });
  const report = await resumed.run();
  assert.equal(report.outcome, 'done');
  const landed = await remoteMain(other);
  assert.deepEqual((await git(other, 'ls-tree', '--name-only', landed)).split('\n'), [
    'a.txt',
    'deps.txt',
    'implementer.txt',
  ]);
});

test('a user whose base already holds the change and whose setup writes a tracked file gets the issue handed over as an empty change and nothing landed', async (t) => {
  const { repo, other } = await clones();
  await git(repo.root, 'config', 'user.name', 't');
  await git(repo.root, 'config', 'user.email', 't@t');
  const target = await harness(t, {
    root: repo.root,
    config: { setupCommand: 'if [ -f implementer.txt ]; then date >> a.txt; fi', checks: ['true'] },
  });
  useGit(target, async () => {});
  const { ports } = target.context;
  let setups = 0;
  let before = '';
  ports.runSetup = async (command, cwd, timeoutMs) => {
    const result = await PORTS.runSetup(command, cwd, timeoutMs);
    setups += 1;
    if (setups === 1) {
      await pushBase(other, { 'implementer.txt': 'implementer\n' });
      before = await remoteMain(other);
    }
    return result;
  };
  ports.runCheck = PORTS.runCheck;
  const report = await target.run();
  assert.equal(report.outcome, 'needs-human');
  assert.equal(report.reason, 'empty change');
  assert.equal(await remoteMain(other), before);
});

for (const [timedOut, reason, note] of [
  [false, 'setup failed', /setup command failed in the worktree before the local checks/],
  [true, 'setup timeout', /setup command did not finish in 15 minutes before the local checks/],
] as const) {
  test(`a user whose setup before the local checks ends in ${reason} gets the issue handed over and nothing pushed`, async (t) => {
    const target = await harness(t, {
      config: { setupCommand: 'npm ci', checks: ['npm test'] },
    });
    let setups = 0;
    target.context.ports.runSetup = async () => {
      setups += 1;
      return setups === 1 ? { code: 0, stderr: '' } : { code: 1, stderr: '', timedOut };
    };
    const report = await target.run();
    assert.equal(report.outcome, 'needs-human');
    assert.equal(report.reason, reason);
    assert.equal(setups, 2);
    assert.deepEqual(target.mergeAborts, []);
    assert.deepEqual(target.checks, []);
    assert.deepEqual(target.landed, []);
    assert.match(target.comments.at(-1) ?? '', note);
    assert.ok(roles(target).includes('implementer'));
  });
}
