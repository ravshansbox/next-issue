import assert from 'node:assert/strict';
import { test } from 'node:test';
import { processIssue } from '../src/pipeline.mts';
import { APPROVE, harness, ISSUE, roles } from './harness.mts';

test('a user whose change is approved gets it pushed to the base branch as one commit, the issue closed and done', async (t) => {
  const target = await harness(t, { implementerText: ['Done.\ncommit: feat: add the flag'] });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.equal(target.pushes, 0);
  assert.deepEqual(target.landed, ['2']);
  assert.match(target.messages.at(-1)!, /^feat: add the flag\n\nRefs #7$/);
  assert.deepEqual(target.closed, [7]);
  assert.equal(target.labels.at(-1)!.label, 'status:done');
});

test('a user whose change is approved gets it done only after the checks of the pushed commit on the base branch pass', async (t) => {
  const target = await harness(t);
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.deepEqual(target.baseWaits, ['2']);
  assert.equal(report.halt, undefined);
});

test('a user whose base branch moves during the push gets the change rebased and pushed again', async (t) => {
  const target = await harness(t, { pushRejects: 1 });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.equal(target.baseMerges, 2);
  assert.deepEqual(target.landed, ['3']);
  assert.equal(report.ciFixes, 0);
});

test('a user whose push to the base branch lands but reports a failure gets the checks of the landed commit awaited and the issue done', async (t) => {
  const target = await harness(t, { pushLandsAndFails: true });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.equal(target.baseMerges, 1);
  assert.deepEqual(target.landed, ['2']);
  assert.deepEqual(target.baseWaits, ['2']);
  assert.deepEqual(target.closed, [7]);
});

test('a user whose push to the base branch lands but reports a failure and whose checks then fail gets the change reverted and the run halted', async (t) => {
  const target = await harness(t, {
    pushLandsAndFails: true,
    config: { maxCiFixes: 0 },
    baseChecks: ['fail'],
  });
  const report = await target.run();
  assert.equal(report.outcome, 'needs-human');
  assert.equal(report.reason, 'check budget');
  assert.equal(report.halt, true);
  assert.deepEqual(
    target.reverts.map((entry) => entry.shas),
    [['2']],
  );
});

test('a user whose push to the base branch reports a failure and whose fetch of the base then fails gets the issue handed over, the commit kept and the run halted', async (t) => {
  const first = await harness(t, { pushLandsAndFails: true, baseFetchFails: true });
  const report = await first.run();
  assert.equal(report.outcome, 'needs-human');
  assert.equal(report.reason, 'push unknown');
  assert.equal(report.halt, true);
  const saved = await first.state();
  assert.equal(saved?.pushing, '2');
  const target = await harness(t, { saved, issue: { ...ISSUE, labels: [] }, baseMoved: true });
  assert.equal((await target.run()).outcome, 'done');
  assert.deepEqual(roles(target), []);
  assert.deepEqual(target.baseWaits, ['2']);
});

test('a user whose push to the base branch keeps failing gets the issue handed over', async (t) => {
  const target = await harness(t, { pushRejects: 3 });
  const report = await target.run();
  assert.equal(report.outcome, 'needs-human');
  assert.equal(report.reason, 'push failed');
  assert.deepEqual(target.closed, []);
});

test('a user whose checks on main fail once and pass on the rerun gets the issue done with no fixer', async (t) => {
  const target = await harness(t, { baseChecks: ['fail'], rerunChecks: ['pass'] });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.equal(report.ciFixes, 0);
  assert.deepEqual(target.reruns, ['2']);
  assert.deepEqual(roles(target), ['implementer', 'reviewer']);
  assert.deepEqual(target.reverts, []);
  assert.ok(target.events.some((event) => event.kind === 'main-checks.rerun' && event.sha === '2'));
});

test('a user whose checks on main fail again on the rerun gets the fixer only after the second failure', async (t) => {
  const target = await harness(t, {
    baseChecks: ['fail', 'pass'],
    fixerText: 'Done.\ncommit: fix: repair main',
  });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.deepEqual(target.reruns, ['2']);
  assert.deepEqual(roles(target), ['implementer', 'reviewer', 'fixer']);
});

test('a user whose failed jobs on main cannot be rerun gets the fixer for the red build', async (t) => {
  const target = await harness(t, {
    baseChecks: ['fail', 'pass'],
    rerunFails: true,
    fixerText: 'Done.\ncommit: fix: repair main',
  });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.deepEqual(roles(target), ['implementer', 'reviewer', 'fixer']);
  assert.ok(target.events.some((event) => event.kind === 'main-checks.rerun-failed'));
});

test('a user whose checks on main fail after the landing gets the fix landed the same way', async (t) => {
  const target = await harness(t, {
    baseChecks: ['fail', 'pass'],
    fixerText: 'Done.\ncommit: fix: repair main',
  });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.equal(report.ciFixes, 1);
  assert.deepEqual(target.landed, ['2', '4']);
  assert.deepEqual(target.baseWaits, ['2', '4']);
  assert.match(target.messages.at(-1)!, /^fix: repair main\n/);
  assert.deepEqual(roles(target), ['implementer', 'reviewer', 'fixer']);
  assert.match(target.prompts[2]!.prompt, /The checks on main failed after the change landed/);
  assert.match(target.prompts[2]!.prompt, /the failed main logs/);
  assert.deepEqual(target.reverts, []);
});

test('a user whose checks on main fail for an unrelated reason gets the change reverted, the issue handed over and the run halted', async (t) => {
  const target = await harness(t, {
    baseChecks: ['fail'],
    fixerText: 'unrelated: the server does not mount the release',
  });
  const report = await target.run();
  assert.equal(report.outcome, 'needs-human');
  assert.equal(report.reason, 'unrelated failure');
  assert.equal(report.halt, true);
  assert.deepEqual(target.reverts, [{ shas: ['2'], message: 'revert: issue #7\n\nRefs #7' }]);
  assert.match(
    target.comments.at(-1)!,
    /needs help: The checks on main fail for a reason this change did not cause: .* The harness reverted the change on main\./,
  );
  assert.equal((await target.state())?.landed, undefined);
  assert.deepEqual(target.closed, []);
});

test('a user whose fix for main conflicts with the base after the check budget is used up gets the change reverted and the issue handed over', async (t) => {
  const target = await harness(t, {
    config: { maxCiFixes: 1 },
    baseChecks: ['fail'],
    merges: [undefined, ['src/a.ts']],
    fixerText: 'Done.\ncommit: fix: repair main',
  });
  const report = await target.run();
  assert.equal(report.outcome, 'needs-human');
  assert.equal(report.reason, 'merge conflict');
  assert.equal(report.halt, true);
  assert.deepEqual(
    target.reverts.map((entry) => entry.shas),
    [['2']],
  );
  assert.equal(target.head(), '5');
  const handOvers = target.comments.filter((comment) => /needs help/.test(comment));
  assert.equal(handOvers.length, 1);
  assert.match(
    handOvers[0]!,
    /limit of 1 check fixes was reached\. The harness reverted the change on main\./,
  );
});

test('a user whose fixer leaves a conflict of the fix for main unresolved gets the change reverted', async (t) => {
  const target = await harness(t, {
    baseChecks: ['fail'],
    merges: [undefined, ['src/a.ts']],
    mergeResolved: false,
    fixerText: 'Done.\ncommit: fix: repair main',
  });
  const report = await target.run();
  assert.equal(report.reason, 'merge conflict');
  assert.deepEqual(
    target.reverts.map((entry) => entry.shas),
    [['2']],
  );
  assert.match(target.comments.at(-1)!, /unresolved\. The harness reverted the change on main\./);
});

test('a user whose fix for main cannot be pushed gets the change reverted', async (t) => {
  const target = await harness(t, {
    baseChecks: ['fail'],
    fixerText: 'Done.\ncommit: fix: repair main',
  });
  const ports = target.context.ports;
  const pushToBase = ports.pushToBase;
  ports.pushToBase = async (...args) => (target.landed.length > 0 ? false : pushToBase(...args));
  const report = await target.run();
  assert.equal(report.reason, 'push failed');
  assert.deepEqual(
    target.reverts.map((entry) => entry.shas),
    [['2']],
  );
  assert.match(
    target.comments.at(-1)!,
    /failed 3 times\. The harness reverted the change on main\./,
  );
});

test('a user whose landing of the fix for main fails with an error gets the change reverted', async (t) => {
  const target = await harness(t, {
    baseChecks: ['fail'],
    fixerText: 'Done.\ncommit: fix: repair main',
  });
  const ports = target.context.ports;
  const startMerge = ports.startMerge;
  ports.startMerge = async (...args) => {
    if (target.landed.length > 0) {
      throw new Error('git: fetch failed');
    }
    return startMerge(...args);
  };
  const report = await target.run();
  assert.equal(report.outcome, 'error');
  assert.deepEqual(
    target.reverts.map((entry) => entry.shas),
    [['2']],
  );
});

test('a user whose fixer for the failed checks on main fails with an error gets the change reverted, the issue handed over and the run halted', async (t) => {
  const target = await harness(t, { baseChecks: ['fail'], fixerThrows: true });
  const report = await target.run();
  assert.equal(report.outcome, 'needs-human');
  assert.equal(report.reason, 'fixer error');
  assert.equal(report.halt, true);
  assert.deepEqual(
    target.reverts.map((entry) => entry.shas),
    [['2']],
  );
  assert.match(
    target.comments.at(-1)!,
    /needs help: The fixer for the failed checks on main failed: the fixer timed out\. The harness reverted the change on main\./,
  );
  assert.equal((await target.state())?.landed, undefined);
  assert.deepEqual(target.closed, []);
});

test('a user whose fixer fails with an error in a later round on main gets every landed commit reverted and the run halted', async (t) => {
  const target = await harness(t, {
    baseChecks: ['fail', 'fail'],
    fixerText: 'Done.\ncommit: fix: repair main',
  });
  const ports = target.context.ports;
  const runAgent = ports.runAgent;
  ports.runAgent = async (recorder, request) => {
    if (request.name === 'fixer' && target.landed.length > 1) {
      throw new Error('The fixer agent did not finish in 5 ms.');
    }
    return runAgent(recorder, request);
  };
  const report = await target.run();
  assert.equal(report.outcome, 'needs-human');
  assert.equal(report.reason, 'fixer error');
  assert.equal(report.halt, true);
  assert.deepEqual(
    target.reverts.map((entry) => entry.shas),
    [['2', '4']],
  );
  assert.match(
    target.comments.at(-1)!,
    /failed: The fixer agent did not finish in 5 ms\. The harness reverted the change on main\./,
  );
  assert.equal((await target.state())?.landed, undefined);
});

test('a user whose checks on main fail with no check fix left gets the change reverted and the issue handed over', async (t) => {
  const target = await harness(t, { config: { maxCiFixes: 0 }, baseChecks: ['fail'] });
  const report = await target.run();
  assert.equal(report.outcome, 'needs-human');
  assert.equal(report.reason, 'check budget');
  assert.equal(report.halt, true);
  assert.deepEqual(roles(target), ['implementer', 'reviewer']);
  assert.deepEqual(
    target.reverts.map((entry) => entry.shas),
    [['2']],
  );
});

test('a user whose fixes on main keep failing gets every landed commit reverted', async (t) => {
  const target = await harness(t, { config: { maxCiFixes: 1 }, baseChecks: ['fail', 'fail'] });
  const report = await target.run();
  assert.equal(report.reason, 'check budget');
  assert.deepEqual(
    target.reverts.map((entry) => entry.shas),
    [['2', '4']],
  );
});

test('a user whose revert cannot be pushed gets the issue handed over with the landed commits kept', async (t) => {
  const target = await harness(t, {
    config: { maxCiFixes: 0 },
    baseChecks: ['fail'],
    revertFails: true,
  });
  await target.run();
  assert.match(target.comments.at(-1)!, /The revert of the change on main failed/);
  assert.deepEqual((await target.state())?.landed, ['2']);
  assert.equal((await target.state())?.rerun, '2');
});

test('a user whose checks on main fail and whose read of the failed runs then fails gets the change reverted, the issue handed over and the run halted', async (t) => {
  const target = await harness(t, { baseChecks: ['fail'] });
  target.context.ports.failedBaseLogs = async () => {
    throw new Error('gh: API rate limit exceeded');
  };
  const report = await target.run();
  assert.equal(report.outcome, 'needs-human');
  assert.equal(report.reason, 'logs error');
  assert.equal(report.halt, true);
  assert.deepEqual(
    target.reverts.map((entry) => entry.shas),
    [['2']],
  );
  assert.match(
    target.comments.at(-1)!,
    /needs help: The read of the failed checks on main failed: gh: API rate limit exceeded\. The harness reverted the change on main\./,
  );
  assert.equal((await target.state())?.landed, undefined);
});

test('a user whose checks on main fail with no check fix left and whose revert fails with an error gets the issue handed over and the run halted', async (t) => {
  const target = await harness(t, { config: { maxCiFixes: 0 }, baseChecks: ['fail'] });
  target.context.ports.revertOnBase = async () => {
    throw new Error('git: fetch failed');
  };
  const report = await target.run();
  assert.equal(report.outcome, 'needs-human');
  assert.equal(report.reason, 'check budget');
  assert.equal(report.halt, true);
  assert.match(
    target.comments.at(-1)!,
    /needs help: The checks on main failed and the limit of 0 check fixes was reached\. The revert of the change on main failed: git: fetch failed\./,
  );
  assert.deepEqual((await target.state())?.landed, ['2']);
});

test('a user whose checks on main do not finish in time gets the issue handed over and the run halted', async (t) => {
  const target = await harness(t, { baseChecks: ['timeout'] });
  const report = await target.run();
  assert.equal(report.outcome, 'needs-human');
  assert.equal(report.reason, 'main checks timeout');
  assert.equal(report.halt, true);
});

test('a user who asks to stop after the round while main is watched gets the watch finished first', async (t) => {
  const target = await harness(t, { pressDuring: 'reviewer' });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.deepEqual(target.baseWaits, ['2']);
});

test('a user with several approved issues gets each landed only after the checks of the last one end', async (t) => {
  const target = await harness(t, { verdicts: [APPROVE, APPROVE] });
  const ports = target.context.ports;
  const order: string[] = [];
  const waitForBaseChecks = ports.waitForBaseChecks;
  ports.waitForBaseChecks = async (...args) => {
    order.push(`wait ${args[1]}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
    order.push(`end ${args[1]}`);
    return waitForBaseChecks(...args);
  };
  const pushToBase = ports.pushToBase;
  ports.pushToBase = async (...args) => {
    order.push('push');
    return pushToBase(...args);
  };
  const reports = await Promise.all([
    processIssue(target.context, ISSUE),
    processIssue(target.context, { ...ISSUE, number: 8 }),
  ]);
  assert.deepEqual(
    reports.map((report) => report.outcome),
    ['done', 'done'],
  );
  assert.equal(order.length, 6);
  assert.deepEqual(
    order.map((entry) => entry.split(' ')[0]),
    ['push', 'wait', 'end', 'push', 'wait', 'end'],
  );
});

test('a user with several issues gets the others implemented and reviewed while one waits to land', async (t) => {
  const target = await harness(t, { verdicts: [APPROVE, APPROVE] });
  const ports = target.context.ports;
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const waitForBaseChecks = ports.waitForBaseChecks;
  let first = true;
  ports.waitForBaseChecks = async (...args) => {
    if (first) {
      first = false;
      waiting();
      await held;
    }
    return waitForBaseChecks(...args);
  };
  let waiting: () => void = () => {};
  const landingWaits = new Promise<void>((resolve) => {
    waiting = resolve;
  });
  let reviewed: () => void = () => {};
  const otherReviewed = new Promise<void>((resolve) => {
    reviewed = resolve;
  });
  const runAgent = ports.runAgent;
  let reviews = 0;
  ports.runAgent = async (...args) => {
    const result = await runAgent(...args);
    if (args[1].name === 'reviewer') {
      reviews += 1;
      if (reviews === 2) {
        reviewed();
      }
    }
    return result;
  };
  const landing = processIssue(target.context, ISSUE);
  await landingWaits;
  const other = processIssue(target.context, { ...ISSUE, number: 8 });
  await otherReviewed;
  assert.deepEqual(roles(target), ['implementer', 'reviewer', 'implementer', 'reviewer']);
  release();
  const reports = await Promise.all([landing, other]);
  assert.deepEqual(
    reports.map((report) => report.outcome),
    ['done', 'done'],
  );
});

test('a user whose change lands gets the local base moved to the landed commit', async (t) => {
  const target = await harness(t);
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.equal(target.localBase, target.landed.at(-1));
});

test('a user whose fetch fails after landing gets the issue done and a base.behind event', async (t) => {
  const target = await harness(t, { landedFetchFails: true });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.equal(target.localBase, undefined);
  assert.equal(target.context.recorder.summary().counts['base.behind'], 1);
});

test('a user whose local base cannot fast-forward after landing gets the issue done and a base.behind event', async (t) => {
  const target = await harness(t, { landedBaseUpdated: false });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.equal(target.localBase, undefined);
  assert.equal(target.context.recorder.summary().counts['base.behind'], 1);
});
