import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type IssueState, type Progress, Runner, type Verdict } from '../src/runner.ts';
import { CONFIG, clean, fake, issue } from './fake.ts';

test('the runner implements a ready issue, merges its pull request after a clean review and labels it done', async () => {
  const { ports, calls } = fake({ issues: [issue(7)] });
  const runner = new Runner(ports, CONFIG);
  await runner.run();
  assert.deepEqual(calls, [
    'label #7 +status:in-progress -status:todo',
    'worktree #7 7',
    'work',
    'commit feat: do it',
    'push 7',
    'pr 7 feat: do it Closes #7',
    'checks #50',
    'review',
    'discard /wt/7 7',
    'pr comment #50 ### Review: approved',
    'merge #50',
    'label #7 +status:done -status:in-progress',
    'cleanup #7',
    'drop #7',
  ]);
  assert.equal(runner.progress.status, 'finished');
  assert.deepEqual(runner.progress.handled, [{ issue: 7, outcome: 'merged' }]);
});

test('the runner leaves issues alone that lack the ready label or hold a stop label', async () => {
  const { ports, calls } = fake({
    issues: [
      issue(1, []),
      issue(2, ['status:todo', 'status:blocked']),
      issue(3, ['status:todo', 'status:in-progress']),
      issue(4, ['status:todo', 'status:needs-human']),
    ],
  });
  await new Runner(ports, CONFIG).run();
  assert.deepEqual(calls, []);
});

test('the runner gives the failed check logs to the fixer and waits for the checks again', async () => {
  const { ports, calls, prompts } = fake({
    issues: [issue(7)],
    checks: ['fail', 'pass'],
    replies: ['commit: feat: do it', 'commit: fix: repair the test'],
  });
  await new Runner(ports, CONFIG).run();
  assert.ok(prompts[1]?.includes('test x failed'));
  const tail = calls.slice(calls.indexOf('checks #50'));
  assert.deepEqual(tail.slice(0, 5), [
    'checks #50',
    'work',
    'commit fix: repair the test',
    'push 7',
    'checks #50',
  ]);
});

test('the runner labels an issue needs-human when the checks still fail after the fix budget', async () => {
  const { ports, calls } = fake({ issues: [issue(7)], checks: ['fail', 'fail', 'fail'] });
  const runner = new Runner(ports, CONFIG);
  await runner.run();
  assert.ok(calls.includes('label #7 +status:needs-human -status:in-progress'));
  assert.ok(calls.some((call) => call.startsWith('issue comment #7') && call.includes('2 fixes')));
  assert.ok(!calls.some((call) => call.startsWith('merge')));
  assert.deepEqual(runner.progress.handled, [{ issue: 7, outcome: 'needs-human' }]);
});

test('the runner sends open review findings to the fixer and reviews the fix', async () => {
  const { ports, calls, prompts } = fake({
    issues: [issue(7)],
    verdicts: [{ summary: 'no', findings: [{ severity: 'minor', detail: 'rename foo' }] }, clean()],
  });
  await new Runner(ports, CONFIG).run();
  const fixPrompt = prompts[2] ?? '';
  assert.ok(fixPrompt.includes('rename foo'));
  assert.ok(prompts[3]?.includes('Round 1'));
  assert.equal(calls.filter((call) => call === 'review').length, 2);
  assert.ok(calls.includes('pr comment #50 ### Review: changes requested'));
  assert.ok(calls.includes('merge #50'));
});

test('the runner merges in the last round when only minor findings are left', async () => {
  const minor: Verdict = { summary: 'meh', findings: [{ severity: 'minor', detail: 'style' }] };
  const { ports, calls } = fake({ issues: [issue(7)], verdicts: [minor, minor] });
  await new Runner(ports, CONFIG).run();
  assert.equal(calls.filter((call) => call === 'work').length, 2);
  assert.ok(calls.includes('merge #50'));
});

test('the runner labels an issue needs-human when a blocking finding is left after the last round', async () => {
  const blocking: Verdict = {
    summary: 'bad',
    findings: [{ severity: 'blocking', detail: 'wrong' }],
  };
  const { ports, calls } = fake({ issues: [issue(7)], verdicts: [blocking, blocking] });
  await new Runner(ports, CONFIG).run();
  assert.ok(calls.includes('label #7 +status:needs-human -status:in-progress'));
  assert.ok(!calls.some((call) => call.startsWith('merge')));
});

test('the runner resumes a saved issue at its saved phase without claiming it again', async () => {
  const saved: IssueState = {
    issue: 9,
    branch: '9',
    phase: 'review',
    pr: 51,
    title: 'feat: x',
    ciFixes: 0,
    round: 0,
    earlier: [],
  };
  const { ports, calls } = fake({
    issues: [issue(3), issue(9, ['status:in-progress'])],
    states: [saved],
  });
  await new Runner(ports, CONFIG).run();
  assert.deepEqual(calls.slice(0, 3), ['worktree #9 9', 'review', 'discard /wt/9 9']);
  assert.ok(calls.includes('merge #51'));
  assert.ok(
    calls.indexOf('merge #51') < calls.indexOf('label #3 +status:in-progress -status:todo'),
  );
});

test('the runner publishes the commit it finds when it resumes an issue whose implement phase was cut short', async () => {
  const saved: IssueState = {
    issue: 9,
    branch: '9',
    phase: 'implement',
    ciFixes: 0,
    round: 0,
    earlier: [],
  };
  const { ports, calls } = fake({
    issues: [issue(9, ['status:in-progress'])],
    states: [saved],
    ahead: 'feat: kept',
  });
  const runner = new Runner(ports, CONFIG);
  await runner.run();
  assert.deepEqual(calls.slice(0, 3), ['worktree #9 9', 'push 9', 'pr 9 feat: kept Closes #9']);
  assert.ok(!calls.includes('work'));
  assert.deepEqual(runner.progress.handled, [{ issue: 9, outcome: 'merged' }]);
});

test('the runner skips a saved issue that a user marked with a stop label and keeps its saved state', async () => {
  const saved = (number: number): IssueState => ({
    issue: number,
    branch: String(number),
    phase: 'review',
    pr: 51,
    ciFixes: 0,
    round: 0,
    earlier: [],
  });
  const { ports, calls, states } = fake({
    issues: [
      issue(4, ['status:in-progress', 'status:blocked']),
      issue(5, ['status:in-progress', 'status:needs-human']),
      issue(6, ['status:in-progress', 'status:done']),
    ],
    states: [saved(4), saved(5), saved(6)],
  });
  await new Runner(ports, CONFIG).run();
  assert.deepEqual(calls, []);
  assert.deepEqual([...states.keys()], [4, 5, 6]);
});

test('the runner skips a saved issue that a user marked blocked, resumes the next saved issue and then claims a ready issue', async () => {
  const saved = (number: number, pr: number): IssueState => ({
    issue: number,
    branch: String(number),
    phase: 'review',
    pr,
    title: 'feat: x',
    ciFixes: 0,
    round: 0,
    earlier: [],
  });
  const { ports, calls, states } = fake({
    issues: [
      issue(4, ['status:in-progress', 'status:blocked']),
      issue(3),
      issue(8, ['status:in-progress']),
    ],
    states: [saved(4, 51), saved(8, 52)],
  });
  await new Runner(ports, CONFIG).run();
  assert.ok(!calls.some((call) => call.includes('#4') || call.includes('#51')));
  assert.deepEqual(calls.slice(0, 3), ['worktree #8 8', 'review', 'discard /wt/8 8']);
  assert.ok(calls.includes('merge #52'));
  assert.ok(
    calls.indexOf('merge #52') < calls.indexOf('label #3 +status:in-progress -status:todo'),
  );
  assert.ok(calls.includes('label #3 +status:done -status:in-progress'));
  assert.deepEqual([...states.keys()], [4]);
});

test('the runner shows the issue, the stage and the tool count while an agent works', async () => {
  let seen: Progress | undefined;
  const { ports } = fake({
    issues: [issue(7)],
    onWork: (task) => {
      task.onTool('bash npm test');
      task.onTool('read src/a.ts');
      seen = structuredClone(runner.progress);
    },
  });
  const runner = new Runner(ports, CONFIG);
  await runner.run();
  assert.equal(seen?.status, 'running');
  assert.equal(seen?.issue, 7);
  assert.equal(seen?.stage, 'implement');
  assert.equal(seen?.tools, 2);
  assert.equal(seen?.lastTool, 'read src/a.ts');
});

test('the runner stops when asked and keeps the saved state for a later run', async () => {
  const { ports, calls, states } = fake({
    issues: [issue(7), issue(8)],
    onWork: (task) => {
      runner.stop();
      assert.ok(task.signal.aborted);
    },
  });
  const runner = new Runner(ports, CONFIG);
  await runner.run();
  assert.equal(runner.progress.status, 'stopped');
  assert.equal(states.get(7)?.phase, 'implement');
  assert.ok(!calls.some((call) => call.includes('#8')));
});

test('the runner stops with the error when a step fails and keeps the saved state', async () => {
  const { ports, states } = fake({ issues: [issue(7), issue(8)], failOn: 'push' });
  const runner = new Runner(ports, CONFIG);
  await runner.run();
  assert.equal(runner.progress.status, 'failed');
  assert.match(runner.progress.error ?? '', /push 7 broke/);
  assert.equal(states.get(7)?.phase, 'publish');
  assert.equal(states.has(8), false);
});

test('the runner tells its listeners about each change', async () => {
  const { ports } = fake({ issues: [issue(7)] });
  const runner = new Runner(ports, CONFIG);
  const stages: string[] = [];
  runner.subscribe((progress) => stages.push(progress.stage ?? ''));
  await runner.run();
  for (const stage of ['implement', 'checks', 'review 1/2', 'merge']) {
    assert.ok(stages.includes(stage), stage);
  }
});

test('the runner holds the repository lock while it runs and lets go when it ends', async () => {
  let heldDuringWork = false;
  const { ports, lock } = fake({
    issues: [issue(7)],
    onWork: () => {
      heldDuringWork = lock.held;
    },
  });
  await new Runner(ports, CONFIG).run();
  assert.equal(heldDuringWork, true);
  assert.equal(lock.held, false);
});

test('the runner fails without touching any issue when another run holds the repository lock', async () => {
  const { ports, calls } = fake({ issues: [issue(7)], lockedByOther: true });
  const runner = new Runner(ports, CONFIG);
  await runner.run();
  assert.equal(runner.progress.status, 'failed');
  assert.match(runner.progress.error ?? '', /another run works on this repository/);
  assert.deepEqual(calls, []);
});

test('the runner labels an issue needs-human and says why when its pull request cannot be merged', async () => {
  const { ports, calls } = fake({
    issues: [issue(7)],
    merge: { merged: false, reason: 'the base branch policy prohibits the merge' },
  });
  const runner = new Runner(ports, CONFIG);
  await runner.run();
  assert.ok(calls.includes('label #7 +status:needs-human -status:in-progress'));
  assert.ok(
    calls.includes(
      'issue comment #7 next-issue stopped: pull request #50 could not be merged: the base branch policy prohibits the merge',
    ),
  );
  assert.deepEqual(runner.progress.handled, [{ issue: 7, outcome: 'needs-human' }]);
});
