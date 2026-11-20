import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { parseArgs } from '../src/shared/args.mts';
import { must } from '../src/shared/exec.mts';
import { runRepo } from '../src/worker/run.mts';
import { runsDir } from '../src/shared/state.mts';
import type { Outcome } from '../src/shared/job.mts';
import { exitCode } from '../src/shared/loop.mts';
import { onOff } from '../src/shared/switch.mts';
import { hunter as repoHunter } from '../src/shared/hunt.mts';
import { type Watch, watchIssues } from '../src/shared/watch.mts';
import { installGh } from './fake-gh.mts';
import { harness, ISSUE } from './harness.mts';
import { sleep, writeScripts } from './helpers.mts';
import { issue, report } from './loop-harness.mts';
import { tempDir } from './temp-dir.mts';

type FakeWatch = Watch & { processed: number[]; waits: number[]; passes: number[][] };

function watcher(lists: Outcome[][], wakes: boolean[] = []): FakeWatch {
  let pass = 0;
  let done = new Set<number>();
  const fake: FakeWatch = {
    processed: [],
    waits: [],
    passes: [],
    issues: async () =>
      (lists[pass] ?? [])
        .map((_, index) => issue(index + 1))
        .filter((entry) => !done.has(entry.number)),
    process: async (target) => {
      fake.processed.push(target.number);
      done.add(target.number);
      return report(target.number, lists[pass]![target.number - 1]!);
    },
    stop: () => false,
    wait: async (minutes) => {
      fake.waits.push(minutes);
      pass += 1;
      done = new Set();
      return wakes.shift() ?? pass < lists.length;
    },
    passEnd: async (reports) => {
      fake.passes.push(reports.map((entry) => entry.issue));
    },
    unreadable: () => undefined,
  };
  return fake;
}

test('a user who watches gets a wait that grows 1, 2, 3, 5, 10, 10 minutes while every issue is skipped', async () => {
  const fake = watcher([[], ['skipped'], [], [], [], [], []]);
  await watchIssues(fake);
  assert.deepEqual(fake.waits, [1, 2, 3, 5, 10, 10, 10]);
  assert.deepEqual(fake.passes, []);
});

test('a user who watches sees the wait go back to 1 minute after a pass that handled an issue', async () => {
  const fake = watcher([[], [], ['done'], [], ['skipped']]);
  const result = await watchIssues(fake);
  assert.deepEqual(fake.waits, [1, 2, 1, 2, 3]);
  assert.deepEqual(fake.passes, [[1]]);
  assert.deepEqual(
    result.reports.map((entry) => entry.outcome),
    ['done'],
  );
});

test('a user who watches an issue that is skipped in every pass finds one report for it in the summary file and a skipped count of 1 in run.end', async (t) => {
  const root = await tempDir();
  await must('git', ['init', '-q'], { cwd: root });
  await writeScripts(root, ['format', 'lint', 'typecheck', 'test']);
  await must('git', ['remote', 'add', 'origin', 'https://github.com/acme/watch-summary.git'], {
    cwd: root,
  });
  const listed = JSON.stringify([
    {
      number: 5,
      title: 'Blocked',
      body: '',
      createdAt: '2026-01-01T00:00:00Z',
      labels: [{ name: 'status:todo' }, { name: 'status:blocked' }],
    },
  ]);
  await installGh(
    t,
    await tempDir(),
    `#!/bin/sh
case "$1 $2" in
  "repo view") echo '{"defaultBranchRef":{"name":"main"}}' ;;
  "issue list") echo '${listed}' ;;
  *) echo "unexpected: $*" >&2; exit 1 ;;
esac
`,
  );
  let waits = 0;
  const code = await runRepo(root, parseArgs(['start', '--watch', 'on']), {
    interrupts: {
      afterIssue: () => false,
      afterRound: () => false,
      sleep: async () => (waits += 1) < 3,
    },
  });
  assert.equal(code, 0);
  assert.equal(waits, 3);
  const files = await readdir(runsDir(root));
  const summaryFile = files.find((name) => name.endsWith('.summary.json'))!;
  const summary = JSON.parse(await readFile(join(runsDir(root), summaryFile), 'utf8'));
  assert.deepEqual(
    summary.issues.map((entry: { issue: number; outcome: string }) => [entry.issue, entry.outcome]),
    [[5, 'skipped']],
  );
  const log = await readFile(
    join(runsDir(root), summaryFile.replace('.summary.json', '.jsonl')),
    'utf8',
  );
  const runEnd = log
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line))
    .find((record) => record.kind === 'run.end');
  assert.equal(runEnd.skipped, 1);
});

test('a user who watches an issue that is handed over, skipped and then done keeps both handled reports and exit code 1', async () => {
  const fake = watcher([['needs-human'], ['skipped'], ['done']]);
  const result = await watchIssues(fake);
  assert.deepEqual(
    result.reports.map((entry) => [entry.issue, entry.outcome]),
    [
      [1, 'needs-human'],
      [1, 'done'],
    ],
  );
  assert.equal(exitCode(result.reports), 1);
});

test('a user who watches gets the handled report in place of the skips of the same issue', async () => {
  const fake = watcher([
    ['skipped'],
    ['skipped', 'skipped'],
    ['needs-human', 'skipped'],
    ['skipped'],
  ]);
  const result = await watchIssues(fake);
  assert.deepEqual(
    result.reports.map((entry) => [entry.issue, entry.outcome]),
    [
      [1, 'needs-human'],
      [2, 'skipped'],
    ],
  );
});

test('a user who watches gets a summary for each pass that handled an issue', async () => {
  const fake = watcher([['done', 'skipped'], ['skipped'], ['needs-human']]);
  const result = await watchIssues(fake);
  assert.deepEqual(fake.passes, [[1, 2], [1]]);
  assert.equal(exitCode(result.reports), 1);
});

test('a user who watches sees an issue that failed tried only once across passes', async () => {
  const fake = watcher([['error', 'done'], ['error', 'done'], ['error']]);
  const result = await watchIssues(fake);
  assert.deepEqual(fake.processed, [1, 2, 2]);
  assert.deepEqual(fake.passes, [[1, 2], [2]]);
  assert.deepEqual(fake.waits, [1, 1, 2]);
  assert.equal(exitCode(result.reports), 1);
});

test('a user who presses Ctrl-C during a wait stops watching at once', async () => {
  const fake = watcher([['done'], ['done']], [false]);
  const result = await watchIssues(fake);
  assert.deepEqual(fake.processed, [1]);
  assert.equal(result.stoppedAt, undefined);
});

test('a user who presses Ctrl-C during an issue stops watching after that issue', async () => {
  const fake = watcher([['done', 'done'], ['done']]);
  let stopped = false;
  const process = fake.process;
  fake.process = async (target) => {
    stopped = true;
    return process(target);
  };
  fake.stop = () => stopped;
  const result = await watchIssues(fake);
  assert.deepEqual(fake.processed, [1]);
  assert.equal(result.stoppedAt, 1);
  assert.deepEqual(fake.waits, []);
});

test('a user who asks to stop while a pass fetches the open issues gets no issue claimed in that pass', async () => {
  const fake = watcher([['done'], ['done', 'done']]);
  let stopped = false;
  const issues = fake.issues;
  fake.issues = async () => {
    const list = await issues();
    stopped = fake.waits.length === 1;
    return list;
  };
  fake.stop = () => stopped;
  const result = await watchIssues(fake);
  assert.deepEqual(fake.processed, [1]);
  assert.deepEqual(fake.waits, [1]);
  assert.equal(result.reports.length, 1);
});

test('a watching run stops after a pass that halts the run', async () => {
  const fake = watcher([['needs-human'], ['done']]);
  const process = fake.process;
  fake.process = async (target) => ({ ...(await process(target)), halt: true });
  const result = await watchIssues(fake);
  assert.deepEqual(fake.processed, [1]);
  assert.equal(result.stoppedAt, 1);
  assert.deepEqual(fake.passes, [[1]]);
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

type FakeHunter = { steps: string[]; counts: number[]; idle: Promise<void> };

function hunter(
  fake: FakeWatch,
  readyLists: number[][],
  cap = 1,
  results: Array<'filed' | 'failed'> = [],
): FakeHunter {
  const steps: string[] = [];
  const counts: number[] = [];
  const { promise: idle, resolve } = deferred();
  const busy = Array.from({ length: cap }, (_, index) => issue(100 + index));
  let checks = 0;
  fake.hunter = {
    cap,
    ready: async () => {
      const numbers = readyLists[checks];
      checks += 1;
      if (numbers === undefined) {
        resolve();
        return busy;
      }
      return numbers.map(issue);
    },
    hunt: async (count) => {
      counts.push(count);
      const outcome = results.shift() ?? 'filed';
      steps.push(outcome === 'filed' ? 'hunt' : `hunt ${outcome}`);
      return outcome === 'filed';
    },
    wait: async (minutes, signal) => {
      steps.push(`wait ${minutes}`);
      if (checks > readyLists.length) {
        await new Promise((done) => signal.addEventListener('abort', done));
      }
    },
  };
  return { steps, counts, idle };
}

function holdIssues(fake: FakeWatch, until: Promise<void>): void {
  const process = fake.process;
  fake.process = async (target) => {
    const processed = process(target);
    await until;
    return processed;
  };
}

test('a user who watches with --hunt sees the hunter hunt while an issue runs', async () => {
  const fake = watcher([['done']]);
  const hunting = hunter(fake, [[]]);
  holdIssues(fake, hunting.idle);
  await watchIssues(fake);
  assert.deepEqual(hunting.steps, ['hunt', 'wait 1', 'wait 2']);
  assert.deepEqual(fake.processed, [1]);
});

test('a person who reads the run log while an issue runs sees the open count rise right after the hunter files an issue', async () => {
  const fake = watcher([['done', 'done']]);
  const open = new Set([1]);
  let openCount: number | undefined;
  fake.issues = async () => {
    openCount = open.size;
    return [...open].map(issue);
  };
  const hunting = hunter(fake, [[]]);
  const hunt = fake.hunter!.hunt;
  fake.hunter!.hunt = async (count) => {
    open.add(2);
    return hunt(count);
  };
  const statuses: Array<number | undefined> = [];
  const wait = fake.hunter!.wait;
  fake.hunter!.wait = async (minutes, signal) => {
    statuses.push(openCount);
    return wait(minutes, signal);
  };
  holdIssues(fake, hunting.idle);
  await watchIssues(fake);
  assert.equal(statuses[0], 2);
  assert.deepEqual(fake.processed, [1, 2]);
});

test('a user who watches with --hunt sees the hunter hunt only while fewer than huntCap issues are ready, and wait otherwise', async () => {
  const fake = watcher([['done']]);
  const hunting = hunter(fake, [[7], [7, 8], [7, 8], [8]], 2);
  holdIssues(fake, hunting.idle);
  await watchIssues(fake);
  assert.deepEqual(hunting.steps, [
    'hunt',
    'wait 1',
    'wait 2',
    'wait 3',
    'hunt',
    'wait 1',
    'wait 2',
  ]);
});

test('a user who watches with --hunt sees the running issues left out of the ready count', async () => {
  const fake = watcher([['done']]);
  const { promise: started, resolve } = deferred();
  const hunting = hunter(fake, [[1]]);
  const ready = fake.hunter!.ready;
  fake.hunter!.ready = async (running, failed) => {
    await started;
    return ready(running, failed);
  };
  const process = fake.process;
  fake.process = async (target) => {
    resolve();
    await hunting.idle;
    return process(target);
  };
  await watchIssues(fake);
  assert.deepEqual(hunting.steps, ['hunt', 'wait 1', 'wait 2']);
  assert.deepEqual(hunting.counts, [1]);
});

test('a user who watches with --hunt sees the hunter told which issues run, so it can count the issues they block', async () => {
  const fake = watcher([['done']]);
  const { promise: started, resolve } = deferred();
  const hunting = hunter(fake, [[]]);
  const ready = fake.hunter!.ready;
  const seen: number[][] = [];
  fake.hunter!.ready = async (running, failed) => {
    await started;
    seen.push([...running]);
    return ready(running, failed);
  };
  const process = fake.process;
  fake.process = async (target) => {
    resolve();
    await hunting.idle;
    return process(target);
  };
  await watchIssues(fake);
  assert.deepEqual(seen[0], [1]);
});

test('a user who watches with --hunt sees the hunter told which issues failed earlier in the run, so it leaves them out of the count', async () => {
  const fake = watcher([['error'], []]);
  const { promise: failedPass, resolve } = deferred();
  const hunting = hunter(fake, [[]]);
  const ready = fake.hunter!.ready;
  const seen: number[][] = [];
  fake.hunter!.ready = async (running, failed) => {
    await failedPass;
    seen.push([...failed]);
    return ready(running, failed);
  };
  const wait = fake.wait;
  fake.wait = async (minutes) => {
    resolve();
    await hunting.idle;
    return wait(minutes);
  };
  await watchIssues(fake);
  assert.deepEqual(seen[0], [1]);
});

async function huntDuringPass(
  t: TestContext,
  blockers: Record<number, string[]>,
  handedOver = false,
): Promise<number[]> {
  const fake = watcher([['error', 'done']]);
  const target = await harness(t, {
    open: [1, 2, 3].map((number) => ({ ...ISSUE, number })),
  });
  target.context.ports.openBlockers = async (_repo, number) => blockers[number] ?? [];
  const counted = repoHunter(target.context);
  const hunting = hunter(fake, [[]]);
  const ready = fake.hunter!.ready;
  const failedEnded = deferred();
  let first = true;
  fake.hunter!.ready = async (running, failed) => {
    if (!first) {
      return ready(running, failed);
    }
    first = false;
    await failedEnded.promise;
    await sleep(0);
    await ready(running, failed);
    return counted.ready(running, failed);
  };
  const process = fake.process;
  fake.process = async (issued) => {
    const processed = await process(issued);
    if (issued.number === 1) {
      failedEnded.resolve();
      return { ...processed, ...(handedOver ? { handedOver: true } : {}) };
    }
    await hunting.idle;
    return processed;
  };
  await watchIssues(fake);
  return hunting.counts;
}

test('a user who watches with --hunt sees the hunter leave out an issue that failed before the claim earlier in the same pass, and hunt while the pass goes on', async (t) => {
  assert.deepEqual(await huntDuringPass(t, { 3: ['#30'] }), [1]);
});

test('a user who watches with --hunt sees the hunter leave out an issue whose only open blocker failed earlier in the same pass, and hunt while the pass goes on', async (t) => {
  assert.deepEqual(await huntDuringPass(t, { 3: ['#1'] }), [1]);
});

test('a user who watches with --hunt sees the hunter still count an issue handed over after an error earlier in the same pass, and not hunt', async (t) => {
  assert.deepEqual(await huntDuringPass(t, { 3: ['#30'] }, true), []);
});

test('a user who watches with --hunt and whose filed issues do not count as ready sees the hunter wait before each next hunt', async () => {
  const fake = watcher([['done']]);
  const hunting = hunter(fake, [[], []]);
  holdIssues(fake, hunting.idle);
  await watchIssues(fake);
  assert.deepEqual(hunting.steps, ['hunt', 'wait 1', 'hunt', 'wait 1', 'wait 2']);
});

test('a user who watches with --hunt sees each hunt asked to file up to huntCap less the ready issues that are not running', async () => {
  const fake = watcher([['done']]);
  const hunting = hunter(fake, [[], [7], [7, 8]], 3);
  holdIssues(fake, hunting.idle);
  await watchIssues(fake);
  assert.deepEqual(hunting.counts, [3, 2, 1]);
});

test('a user who presses Ctrl-C during a hunt sees the watch stop after that hunt', async () => {
  const fake = watcher([['done'], ['done']]);
  const steps: string[] = [];
  let stopped = false;
  const { promise: hunted, resolve } = deferred();
  const { promise: claimed, resolve: claim } = deferred();
  fake.stop = () => stopped;
  fake.hunter = {
    cap: 1,
    ready: async () => [],
    hunt: async () => {
      await claimed;
      steps.push('hunt start');
      stopped = true;
      resolve();
      await new Promise((done) => setTimeout(done, 10));
      steps.push('hunt end');
      return true;
    },
    wait: async () => {
      steps.push('wait');
    },
  };
  const process = fake.process;
  fake.process = async (target) => {
    claim();
    return process(target);
  };
  holdIssues(fake, hunted);
  const result = await watchIssues(fake);
  steps.push('watch end');
  assert.deepEqual(steps, ['hunt start', 'hunt end', 'watch end']);
  assert.equal(result.stoppedAt, 1);
});

test('a user who asks to stop while the hunter reads the ready issues sees no hunt start and the watch end after the running issue', async () => {
  const fake = watcher([['done'], ['done']]);
  const steps: string[] = [];
  let stopped = false;
  const { promise: read, resolve } = deferred();
  const { promise: claimed, resolve: claim } = deferred();
  fake.stop = () => stopped;
  fake.hunter = {
    cap: 1,
    ready: async () => {
      steps.push('ready');
      await claimed;
      stopped = true;
      resolve();
      return [];
    },
    hunt: async () => {
      steps.push('hunt');
      return true;
    },
    wait: async () => {
      steps.push('wait');
    },
  };
  const process = fake.process;
  fake.process = async (target) => {
    claim();
    return process(target);
  };
  holdIssues(fake, read);
  const result = await watchIssues(fake);
  steps.push('watch end');
  assert.deepEqual(steps, ['ready', 'watch end']);
  assert.deepEqual(fake.processed, [1]);
  assert.equal(result.stoppedAt, 1);
});

test('a user whose watch ends while the hunter reads the ready issues sees no hunt start', async () => {
  const fake = watcher([['done']]);
  const steps: string[] = [];
  const { promise: ended, resolve } = deferred();
  const wait = fake.wait;
  fake.wait = async (minutes) => {
    resolve();
    return wait(minutes);
  };
  fake.hunter = {
    cap: 1,
    ready: async () => {
      steps.push('ready');
      await ended;
      await sleep(0);
      return [];
    },
    hunt: async () => {
      steps.push('hunt');
      return true;
    },
    wait: async () => {
      steps.push('wait');
    },
  };
  await watchIssues(fake);
  steps.push('watch end');
  assert.deepEqual(steps, ['ready', 'watch end']);
});

test('a user who watches with --hunt sees the hunter wait with the back-off after each failed hunt, and back at 1 minute after a hunt that succeeds', async () => {
  const fake = watcher([['done']]);
  const hunting = hunter(fake, [[], [], [], []], 1, ['failed', 'failed', 'filed', 'failed']);
  holdIssues(fake, hunting.idle);
  await watchIssues(fake);
  assert.deepEqual(hunting.steps, [
    'hunt failed',
    'wait 1',
    'hunt failed',
    'wait 2',
    'hunt',
    'wait 1',
    'hunt failed',
    'wait 2',
    'wait 3',
  ]);
});

test('a user whose watch ends while the hunter waits after a failed hunt sees the hunter stop', async () => {
  const fake = watcher([['done']]);
  const steps: string[] = [];
  const { promise: waiting, resolve } = deferred();
  fake.hunter = {
    cap: 1,
    ready: async () => [],
    hunt: async () => {
      steps.push('hunt failed');
      return false;
    },
    wait: async (minutes, signal) => {
      steps.push(`wait ${minutes}`);
      resolve();
      await new Promise((done) => signal.addEventListener('abort', done));
      steps.push('wait end');
    },
  };
  holdIssues(fake, waiting);
  await watchIssues(fake);
  steps.push('watch end');
  assert.deepEqual(steps, ['hunt failed', 'wait 1', 'wait end', 'watch end']);
});

test('a user who watches with --hunt sees a claim leave the waiting hunter alone, with no new read of the open issues or their blockers before its back-off ends', async (t) => {
  const target = await harness(t, { open: [{ ...ISSUE, number: 100 }] });
  const ports = target.context.ports;
  const list = ports.openIssues;
  let listings = 0;
  let blockerReads = 0;
  ports.openIssues = async (...args) => {
    listings += 1;
    return list(...args);
  };
  ports.openBlockers = async () => {
    blockerReads += 1;
    return [];
  };
  const fake = watcher([['done']]);
  const waits: number[] = [];
  const waiting = deferred();
  let stopped = false;
  fake.stop = () => stopped;
  fake.hunter = {
    cap: 1,
    ready: repoHunter(target.context).ready,
    hunt: async () => assert.fail('no hunt while enough issues are ready'),
    wait: async (minutes, signal) => {
      waits.push(minutes);
      waiting.resolve();
      await new Promise((done) => signal.addEventListener('abort', done, { once: true }));
    },
  };
  const process = fake.process;
  fake.process = async (claimedIssue) => {
    await waiting.promise;
    const processed = await process(claimedIssue);
    await sleep(50);
    return processed;
  };
  fake.wait = async () => {
    stopped = true;
    return false;
  };
  await watchIssues(fake);
  assert.deepEqual(fake.processed, [1]);
  assert.deepEqual(waits, [1]);
  assert.equal(listings, 2);
  assert.equal(blockerReads, 1);
});

test('a user who watches with --hunt sees passes that each skip an issue during a hunt not wake the hunter, which waits 1, 2, 3, 5, 10, 10 minutes', async () => {
  const fake = watcher(Array.from({ length: 6 }, () => ['skipped']));
  let hunting = deferred();
  let skipped = deferred();
  let waited = deferred();
  const steps: string[] = [];
  fake.hunter = {
    cap: 1,
    ready: async () => [],
    hunt: async () => {
      steps.push('hunt');
      const seen = skipped;
      hunting.resolve();
      await Promise.race([seen.promise, sleep(50)]);
      return false;
    },
    wait: async (minutes, signal) => {
      steps.push(`wait ${minutes}`);
      waited.resolve();
      if (steps.length >= 12 && !signal.aborted) {
        await new Promise((done) => signal.addEventListener('abort', done, { once: true }));
      }
    },
  };
  const process = fake.process;
  fake.process = async (target) => {
    await hunting.promise;
    hunting = deferred();
    const processed = await process(target);
    skipped.resolve();
    skipped = deferred();
    return processed;
  };
  const wait = fake.wait;
  fake.wait = async (minutes) => {
    await Promise.race([waited.promise, sleep(50)]);
    waited = deferred();
    return wait(minutes);
  };
  await watchIssues(fake);
  assert.deepEqual(
    steps,
    [1, 2, 3, 5, 10, 10].flatMap((minutes) => ['hunt', `wait ${minutes}`]),
  );
});

test('a user who watches with --hunt sees passes that each skip an issue during a hunter wait not wake the hunter, which waits 1, 2, 3, 5, 10, 10 minutes', async () => {
  const fake = watcher(Array.from({ length: 6 }, () => ['skipped']));
  const waits: number[] = [];
  let hunterWaiting = deferred();
  let skipped = deferred();
  fake.hunter = {
    cap: 1,
    ready: async () => [],
    hunt: async () => false,
    wait: async (minutes, signal) => {
      waits.push(minutes);
      hunterWaiting.resolve();
      const aborted = new Promise((done) => signal.addEventListener('abort', done, { once: true }));
      await Promise.race([skipped.promise, aborted]);
    },
  };
  const process = fake.process;
  fake.process = async (target) => {
    await hunterWaiting.promise;
    hunterWaiting = deferred();
    const processed = await process(target);
    skipped.resolve();
    skipped = deferred();
    return processed;
  };
  const wait = fake.wait;
  fake.wait = async (minutes) => {
    await hunterWaiting.promise;
    return wait(minutes);
  };
  await watchIssues(fake);
  assert.deepEqual(waits, [1, 2, 3, 5, 10, 10, 10]);
});

test('a user who turns hunting on for a watch that started with it off sees the hunter start at once while the issue runs', async () => {
  const fake = watcher([['done']]);
  const toggle = onOff(false);
  fake.hunting = toggle;
  const steps: string[] = [];
  const hunted = deferred();
  fake.hunter = {
    cap: 1,
    ready: async () => {
      steps.push('ready');
      return [];
    },
    hunt: async () => {
      steps.push('hunt');
      toggle.set(false);
      hunted.resolve();
      return true;
    },
    wait: async () => {
      steps.push('wait');
    },
  };
  const process = fake.process;
  fake.process = async (target) => {
    await sleep(20);
    steps.push('on');
    toggle.set(true);
    await hunted.promise;
    return process(target);
  };
  await watchIssues(fake);
  assert.deepEqual(steps, ['on', 'ready', 'hunt']);
  assert.deepEqual(fake.processed, [1]);
});

test('a user who turns hunting off during a hunt sees that hunt finish with its result and no new hunt start', async () => {
  const fake = watcher([['done'], ['done']]);
  const toggle = onOff(true);
  fake.hunting = toggle;
  const steps: string[] = [];
  const hunted = deferred();
  fake.hunter = {
    cap: 1,
    ready: async () => {
      steps.push('ready');
      return [];
    },
    hunt: async () => {
      steps.push('hunt start');
      toggle.set(false);
      await sleep(10);
      steps.push('hunt end');
      hunted.resolve();
      return true;
    },
    wait: async () => {
      steps.push('wait');
    },
  };
  const process = fake.process;
  fake.process = async (target) => {
    await hunted.promise;
    await sleep(20);
    return process(target);
  };
  await watchIssues(fake);
  assert.deepEqual(steps, ['ready', 'hunt start', 'hunt end']);
  assert.deepEqual(fake.processed, [1, 1]);
});

test('a user who turns hunting off and on during a hunter back-off sees the hunter hunt again at once, with the back-off back at 1 minute', async () => {
  const fake = watcher([['done']]);
  const toggle = onOff(true);
  fake.hunting = toggle;
  const steps: string[] = [];
  const waiting = deferred();
  const done = deferred();
  let hunts = 0;
  fake.hunter = {
    cap: 1,
    ready: async () => [],
    hunt: async () => {
      hunts += 1;
      steps.push('hunt failed');
      return false;
    },
    wait: async (minutes, signal) => {
      steps.push(`wait ${minutes}`);
      if (hunts === 1) {
        waiting.resolve();
      } else {
        done.resolve();
      }
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      steps.push('wait end');
    },
  };
  const process = fake.process;
  fake.process = async (target) => {
    await waiting.promise;
    toggle.set(false);
    toggle.set(true);
    await done.promise;
    return process(target);
  };
  await watchIssues(fake);
  assert.deepEqual(steps, [
    'hunt failed',
    'wait 1',
    'wait end',
    'hunt failed',
    'wait 1',
    'wait end',
  ]);
});

test('a user whose watch ends while hunting is off sees the hunter never read the ready issues', async () => {
  const fake = watcher([['done']]);
  fake.hunting = onOff(false);
  const steps: string[] = [];
  fake.hunter = {
    cap: 1,
    ready: async () => {
      steps.push('ready');
      return [];
    },
    hunt: async () => true,
    wait: async () => undefined,
  };
  await watchIssues(fake);
  assert.deepEqual(steps, []);
  assert.deepEqual(fake.processed, [1]);
});

test('a user who watches with --hunt sees the hunter count an issue handed over after an error as ready once a person answers, and hunt for one issue fewer', async () => {
  const fake = watcher([['error'], []]);
  const process = fake.process;
  fake.process = async (target) => ({
    ...(await process(target)),
    handedOver: true,
  });
  const { promise: failedPass, resolve } = deferred();
  const hunting = hunter(fake, [[1]], 2);
  const ready = fake.hunter!.ready;
  fake.hunter!.ready = async (running, failed) => {
    await failedPass;
    const issues = await ready(running, failed);
    return issues.filter((entry) => !failed.has(entry.number));
  };
  const wait = fake.wait;
  fake.wait = async (minutes) => {
    resolve();
    await hunting.idle;
    return wait(minutes);
  };
  await watchIssues(fake);
  assert.deepEqual(hunting.counts, [1]);
});
