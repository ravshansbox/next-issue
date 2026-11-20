import assert from 'node:assert/strict';
import { test } from 'node:test';
import { processIssue } from '../src/worker/pipeline.mts';
import { readState, type IssueState } from '../src/shared/state.mts';
import { APPROVE, commentFails, harness, ISSUE, PUSH_REJECTED, roles } from './harness.mts';

test('a user whose change is approved gets it pushed to the base branch as one commit, the issue closed and done', async (t) => {
  const target = await harness(t, { implementerText: ['Done.\ncommit: feat: add the flag'] });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.deepEqual(target.landed, ['2']);
  assert.match(target.messages.at(-1)!, /^feat: add the flag \(#7\)$/);
  assert.deepEqual(target.closed, [7]);
  assert.equal(target.labels.at(-1)!.label, 'status:done');
});

test('a user whose change lands sees the wait for the checks on the base branch logged as the ci-checks step', async (t) => {
  const target = await harness(t);
  await target.run();
  const kinds = target.events.map((event) => event.kind);
  assert.ok(kinds.includes('ci-checks.end'));
  assert.ok(kinds.includes('ci-checks.state'));
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

test('a user who stops the run after the revert of main reaches the base and then resumes gets the issue handed over with the revert reported and no second revert', async (t) => {
  const first = await harness(t, {
    config: { maxCiFixes: 0 },
    baseChecks: ['fail'],
    revertLandsAndStops: true,
  });
  assert.equal((await first.run()).outcome, 'stopped');
  const saved = await first.state();
  const target = await harness(t, {
    saved,
    issue: { ...ISSUE, labels: [] },
    config: { maxCiFixes: 0 },
    baseChecks: ['fail'],
    revertFails: true,
  });
  target.context.ports.isOnBase = async (_worktree, _base, _remote, sha) =>
    sha === saved?.reverting;
  const report = await target.run();
  assert.equal(report.outcome, 'needs-human');
  assert.equal(report.halt, true);
  assert.deepEqual(target.baseWaits, []);
  assert.deepEqual(target.reverts, []);
  assert.match(
    target.comments.at(-1)!,
    /needs help\n\nThe run stopped during the revert of the change on main\. The harness reverted the change on main\.$/,
  );
  const state = await target.state();
  assert.equal(state?.landed, undefined);
  assert.equal(state?.reverting, undefined);
});

test('a user who stops the run before the revert of main reaches the base and then resumes gets the change reverted again and the run halted', async (t) => {
  const first = await harness(t, {
    config: { maxCiFixes: 0 },
    baseChecks: ['fail'],
    revertLandsAndStops: true,
  });
  assert.equal((await first.run()).outcome, 'stopped');
  const saved = await first.state();
  const target = await harness(t, {
    saved,
    issue: { ...ISSUE, labels: [] },
    config: { maxCiFixes: 0 },
    baseChecks: ['fail'],
    baseMoved: true,
  });
  target.context.ports.isOnBase = async (_worktree, _base, _remote, sha) =>
    target.landed.includes(sha);
  const report = await target.run();
  assert.equal(report.outcome, 'needs-human');
  assert.equal(report.reason, 'check budget');
  assert.equal(report.halt, true);
  assert.deepEqual(
    target.reverts.map((entry) => entry.shas),
    [['2']],
  );
  const state = await target.state();
  assert.equal(state?.landed, undefined);
  assert.equal(state?.reverting, undefined);
});

test('a user whose push to the base branch reports a failure, whose fetch of the base fails and whose hand-over fails gets the run halted with both reasons', async (t) => {
  const target = await harness(t, { pushLandsAndFails: true, baseFetchFails: true });
  commentFails(target, 'gh: could not resolve host');
  const report = await target.run();
  assert.equal(report.outcome, 'error');
  assert.equal(report.reason, 'push unknown; the hand-over failed: gh: could not resolve host');
  assert.equal(report.halt, true);
  assert.deepEqual(
    target.events
      .filter((record) => record.kind === 'hand-over.error')
      .map((record) => [record.reason, record.error]),
    [['push unknown', 'gh: could not resolve host']],
  );
});

test('a user whose push to the base branch keeps failing gets the issue handed over', async (t) => {
  const target = await harness(t, { pushRejects: 3 });
  const report = await target.run();
  assert.equal(report.outcome, 'needs-human');
  assert.equal(report.reason, 'push failed');
  assert.deepEqual(target.closed, []);
  assert.equal(target.baseMerges, 3);
  assert.match(
    target.comments.at(-1)!,
    /The push to main failed 3 times\. The last error of git:\n\n```\n! \[rejected\] HEAD -> main \(fetch first\)\n```/,
  );
});

test('a user whose push to the base branch is refused while the base stays put gets the issue handed over at once with the error of git and the checks run once', async (t) => {
  const target = await harness(t, {
    pushRefused: 'remote: Permission to acme/tool.git denied to bot.',
  });
  const report = await target.run();
  assert.equal(report.outcome, 'needs-human');
  assert.equal(report.reason, 'push failed');
  assert.equal(target.checks.length, 4);
  assert.equal(target.baseMerges, 1);
  assert.deepEqual(target.landed, []);
  assert.match(
    target.comments.at(-1)!,
    /needs help\n\nThe push to main failed, and main did not move, so the harness did not try again\. The error of git:\n\n```\nremote: Permission to acme\/tool\.git denied to bot\.\n```/,
  );
});

test('a user whose push is refused with no error from git gets a hand-over that names no error of git', async (t) => {
  const target = await harness(t, { pushRefused: '' });
  const report = await target.run();
  assert.equal(report.outcome, 'needs-human');
  assert.match(
    target.comments.at(-1)!,
    /needs help\n\nThe push to main failed, and main did not move, so the harness did not try again\.$/,
  );
});

test('a user whose checks on main fail once and pass on the rerun gets the issue done with no fixer', async (t) => {
  const target = await harness(t, { baseChecks: ['fail'], rerunChecks: ['pass'] });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.equal(report.ciFixes, 0);
  assert.deepEqual(target.reruns, ['2']);
  assert.deepEqual(roles(target), ['implementer', 'reviewer']);
  assert.deepEqual(target.reverts, []);
  assert.ok(target.events.some((event) => event.kind === 'ci-checks.rerun' && event.sha === '2'));
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
  assert.ok(target.events.some((event) => event.kind === 'ci-checks.rerun-failed'));
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
  assert.match(target.messages.at(-1)!, /^fix: repair main \(#7\)$/);
  assert.deepEqual(roles(target), ['implementer', 'reviewer', 'fixer']);
  assert.match(target.prompts[2]!.prompt, /The checks on main failed after the change landed/);
  assert.match(target.prompts[2]!.prompt, /the failed main logs/);
  assert.deepEqual(target.reverts, []);
});

test('a user whose issue title holds a closing keyword gets a revert on main that closes no issue', async (t) => {
  const target = await harness(t, {
    issue: { ...ISSUE, title: 'Crash fixes #12' },
    baseChecks: ['fail'],
    fixerText: 'unrelated: the server does not mount the release',
  });
  await target.run();
  assert.deepEqual(target.reverts, [{ shas: ['2'], message: 'revert: Crash (#7)' }]);
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
  assert.deepEqual(target.reverts, [{ shas: ['2'], message: 'revert: Add a flag (#7)' }]);
  assert.match(
    target.comments.at(-1)!,
    /needs help\n\nThe checks on main fail for a reason this change did not cause: .* The harness reverted the change on main\./,
  );
  assert.equal((await target.state())?.landed, undefined);
  assert.deepEqual(target.closed, []);
});

test('a user whose fixer calls a failure in a test file that the change added unrelated gets the claim refused and another fix round', async (t) => {
  const target = await harness(t, {
    baseChecks: ['fail', 'pass'],
    baseLogs: 'not ok 3 - /home/runner/work/tool/tool/test/local-checks.test.mts:126:5',
    changedFiles: ['src/local-checks.mts', 'test/local-checks.test.mts'],
    fixerText: [
      'unrelated: serve.test.mts is a known flaky test',
      'Done.\ncommit: fix: repair the new test',
    ],
  });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.equal(report.ciFixes, 2);
  assert.deepEqual(roles(target), ['implementer', 'reviewer', 'fixer', 'fixer']);
  assert.match(
    target.prompts[3]!.prompt,
    /the failed logs name a file of this change, so the failure is not unrelated:\n```untrusted\ntest\/local-checks\.test\.mts\n```/,
  );
  assert.deepEqual(target.reverts, []);
});

test('a user whose fixer calls a failure unrelated when the failed logs name a tail of a changed file with no folder before it gets the claim refused and another fix round', async (t) => {
  const target = await harness(t, {
    baseChecks: ['fail', 'pass'],
    baseLogs: 'error at src/index.ts:12',
    changedFiles: ['packages/b/src/index.ts'],
    fixerText: ['unrelated: index.ts is flaky', 'Done.\ncommit: fix: repair the index'],
  });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.equal(report.ciFixes, 2);
  assert.match(
    target.prompts[3]!.prompt,
    /the failed logs name a file of this change, so the failure is not unrelated:\n```untrusted\npackages\/b\/src\/index\.ts\n```/,
  );
});

test('a user whose fixer calls a failure unrelated when the failed logs name a file of the same tail in another folder gets the change reverted and the issue handed over', async (t) => {
  const target = await harness(t, {
    baseChecks: ['fail'],
    baseLogs: 'not ok 3 - /home/runner/work/tool/tool/packages/a/src/index.ts:12:5',
    changedFiles: ['packages/b/src/index.ts'],
    fixerText: 'unrelated: packages/a is a known flaky test',
  });
  const report = await target.run();
  assert.equal(report.reason, 'unrelated failure');
  assert.equal(report.ciFixes, 1);
  assert.deepEqual(roles(target), ['implementer', 'reviewer', 'fixer']);
  assert.deepEqual(
    target.reverts.map((entry) => entry.shas),
    [['2']],
  );
});

test('a user whose fixer calls a failure unrelated and whose read of the changed files then fails gets the change reverted and the issue handed over', async (t) => {
  const target = await harness(t, {
    baseChecks: ['fail'],
    fixerText: 'unrelated: serve.test.mts is a known flaky test',
  });
  target.context.ports.changedFiles = async () => {
    throw new Error('git: bad object 2');
  };
  const report = await target.run();
  assert.equal(report.outcome, 'needs-human');
  assert.equal(report.reason, 'files error');
  assert.deepEqual(
    target.reverts.map((entry) => entry.shas),
    [['2']],
  );
  assert.match(
    target.comments.at(-1)!,
    /needs help\n\nThe read of the files of the change failed: git: bad object 2\. The harness reverted the change on main\./,
  );
});

test('a user whose fixer calls a failure in a file the change did not touch unrelated gets the change reverted and the issue handed over', async (t) => {
  const target = await harness(t, {
    baseChecks: ['fail'],
    baseLogs: 'not ok 3 - /home/runner/work/tool/tool/test/serve.test.mts:40:5',
    changedFiles: ['src/local-checks.mts', 'test/local-checks.test.mts'],
    fixerText: 'unrelated: serve.test.mts is a known flaky test',
  });
  const report = await target.run();
  assert.equal(report.reason, 'unrelated failure');
  assert.equal(report.ciFixes, 1);
  assert.deepEqual(roles(target), ['implementer', 'reviewer', 'fixer']);
  assert.deepEqual(
    target.reverts.map((entry) => entry.shas),
    [['2']],
  );
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
  ports.pushToBase = async (...args) =>
    target.landed.length > 0 ? { pushed: false, error: PUSH_REJECTED } : pushToBase(...args);
  const report = await target.run();
  assert.equal(report.reason, 'push failed');
  assert.deepEqual(
    target.reverts.map((entry) => entry.shas),
    [['2']],
  );
  assert.match(
    target.comments.at(-1)!,
    /failed 3 times\. The last error of git:\n\n```\n.+\n```\n The harness reverted the change on main\./,
  );
});

function revertThrows(target: Awaited<ReturnType<typeof harness>>) {
  target.context.ports.revertOnBase = async () => {
    throw new Error('git: fetch failed');
  };
}

test('a user whose fix for main cannot be pushed and whose revert throws gets the landed commits kept, the issue handed over and the run halted', async (t) => {
  const target = await harness(t, {
    baseChecks: ['fail'],
    fixerText: 'Done.\ncommit: fix: repair main',
  });
  const ports = target.context.ports;
  const pushToBase = ports.pushToBase;
  ports.pushToBase = async (...args) =>
    target.landed.length > 0 ? { pushed: false, error: PUSH_REJECTED } : pushToBase(...args);
  revertThrows(target);
  const report = await target.run();
  assert.equal(report.outcome, 'needs-human');
  assert.equal(report.reason, 'push failed');
  assert.equal(report.halt, true);
  assert.match(
    target.comments.at(-1)!,
    /needs help\n\nThe push to main failed 3 times\. The last error of git:\n\n```\n.+\n```\n The revert of the change on main failed: git: fetch failed\. The landed commits stay on main\./,
  );
  assert.deepEqual((await target.state())?.landed, ['2']);
});

test('a user whose push of the fix for main reports a failure and whose fetch of the base fails gets no revert pushed, the issue handed over and the fix checks awaited on resume', async (t) => {
  const first = await harness(t, {
    baseChecks: ['fail'],
    fixerText: 'Done.\ncommit: fix: repair main',
  });
  const ports = first.context.ports;
  const pushToBase = ports.pushToBase;
  ports.pushToBase = async (...args) => {
    const fix = first.landed.length > 0;
    const push = await pushToBase(...args);
    return fix ? { pushed: false, error: PUSH_REJECTED } : push;
  };
  ports.isOnBase = async () => {
    throw new Error('fetch failed');
  };
  const report = await first.run();
  assert.equal(report.outcome, 'needs-human');
  assert.equal(report.reason, 'push unknown');
  assert.equal(report.halt, true);
  assert.deepEqual(first.reverts, []);
  assert.doesNotMatch(first.comments.at(-1)!, /reverted/);
  const saved = await first.state();
  assert.deepEqual(saved?.landed, ['2']);
  const fix = saved?.pushing;
  assert.equal(fix, first.landed.at(-1));
  const target = await harness(t, { saved, issue: { ...ISSUE, labels: [] }, baseMoved: true });
  assert.equal((await target.run()).outcome, 'done');
  assert.deepEqual(target.reverts, []);
  assert.deepEqual(target.baseWaits, [fix]);
});

async function fixLandingFails(t: Parameters<typeof harness>[0], options = {}) {
  const target = await harness(t, {
    baseChecks: ['fail'],
    fixerText: 'Done.\ncommit: fix: repair main',
    ...options,
  });
  const ports = target.context.ports;
  const startMerge = ports.startMerge;
  ports.startMerge = async (...args) => {
    if (target.landed.length > 0) {
      throw new Error('git: merge failed');
    }
    return startMerge(...args);
  };
  return target;
}

test('a user whose landing of the fix for main fails with an error gets the change reverted, the issue handed over and the run halted', async (t) => {
  const target = await fixLandingFails(t);
  const report = await target.run();
  assert.equal(report.outcome, 'needs-human');
  assert.equal(report.reason, 'fix landing error');
  assert.equal(report.halt, true);
  assert.deepEqual(
    target.reverts.map((entry) => entry.shas),
    [['2']],
  );
  assert.match(
    target.comments.at(-1)!,
    /needs help\n\nThe landing of the fix for the checks on main failed: git: merge failed\. The harness reverted the change on main\./,
  );
  assert.equal((await target.state())?.landed, undefined);
});

test('a user who stops the run now while the fix for main lands gets the run stopped with no revert tried and the landed commits kept', async (t) => {
  const target = await harness(t, {
    baseChecks: ['fail'],
    fixerText: 'Done.\ncommit: fix: repair main',
  });
  const ports = target.context.ports;
  const startMerge = ports.startMerge;
  ports.startMerge = async (...args) => {
    if (target.landed.length > 0) {
      target.stopNow();
      throw new Error('The run stopped.');
    }
    return startMerge(...args);
  };
  const report = await target.run();
  assert.equal(report.outcome, 'stopped');
  assert.deepEqual(target.reverts, []);
  assert.deepEqual((await target.state())?.landed, ['2']);
});

test('a user whose landing of the fix for main fails with an error and whose revert fails gets the landed commits kept, the issue handed over and the run halted', async (t) => {
  const target = await fixLandingFails(t, { revertFails: true });
  const report = await target.run();
  assert.equal(report.reason, 'fix landing error');
  assert.equal(report.halt, true);
  assert.match(
    target.comments.at(-1)!,
    /failed: git: merge failed\. The revert of the change on main failed, so the landed commits stay on main\./,
  );
  assert.deepEqual((await target.state())?.landed, ['2']);
});

test('a user whose landing of the fix for main fails with an error and whose revert throws gets the original error handed over and the run halted', async (t) => {
  const target = await fixLandingFails(t);
  target.context.ports.revertOnBase = async () => {
    throw new Error('git: fetch failed');
  };
  const report = await target.run();
  assert.equal(report.reason, 'fix landing error');
  assert.equal(report.halt, true);
  assert.match(
    target.comments.at(-1)!,
    /failed: git: merge failed\. The revert of the change on main failed: git: fetch failed\. The landed commits stay on main\./,
  );
  assert.deepEqual((await target.state())?.landed, ['2']);
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
    /needs help\n\nThe fixer for the failed checks on main failed: the fixer timed out\. The harness reverted the change on main\./,
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
});

test('a user whose checks on main fail and whose read of the failed runs then fails gets the change reverted, the issue handed over and the run halted', async (t) => {
  const target = await harness(t, { baseChecks: ['fail'] });
  target.context.ports.failedCiLogs = async () => {
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
    /needs help\n\nThe read of the failed checks on main failed: gh: API rate limit exceeded\. The harness reverted the change on main\./,
  );
  assert.equal((await target.state())?.landed, undefined);
});

function checkReadFails(target: Awaited<ReturnType<typeof harness>>, when: () => boolean) {
  const ports = target.context.ports;
  const waitForCiChecks = ports.waitForCiChecks;
  ports.waitForCiChecks = async (...args) => {
    if (when()) {
      throw new Error('gh: API rate limit exceeded');
    }
    return waitForCiChecks(...args);
  };
}

test('a user whose checks on main fail and whose read of the checks after the rerun then fails gets the change reverted, the issue handed over and the run halted', async (t) => {
  const target = await harness(t, { baseChecks: ['fail'] });
  checkReadFails(target, () => target.reruns.length > 0);
  const report = await target.run();
  assert.equal(report.outcome, 'needs-human');
  assert.equal(report.reason, 'checks error');
  assert.equal(report.halt, true);
  assert.deepEqual(
    target.reverts.map((entry) => entry.shas),
    [['2']],
  );
  assert.match(
    target.comments.at(-1)!,
    /needs help\n\nThe read of the checks on main failed: gh: API rate limit exceeded\. The harness reverted the change on main\./,
  );
  assert.equal((await target.state())?.landed, undefined);
});

test('a user whose fix for main lands and whose read of the checks of the fix then fails gets every landed commit reverted, the issue handed over and the run halted', async (t) => {
  const target = await harness(t, {
    baseChecks: ['fail'],
    fixerText: 'Done.\ncommit: fix: repair main',
  });
  checkReadFails(target, () => target.landed.length > 1);
  const report = await target.run();
  assert.equal(report.outcome, 'needs-human');
  assert.equal(report.reason, 'checks error');
  assert.equal(report.halt, true);
  assert.deepEqual(
    target.reverts.map((entry) => entry.shas),
    [['2', '4']],
  );
  assert.match(
    target.comments.at(-1)!,
    /needs help\n\nThe read of the checks on main failed: gh: API rate limit exceeded\. The harness reverted the change on main\./,
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
    /needs help\n\nThe checks on main failed and the limit of 0 check fixes was reached\. The revert of the change on main failed: git: fetch failed\./,
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

test('a user whose checks on main are all cancelled before they finish gets the issue handed over, not closed, and the run halted', async (t) => {
  const target = await harness(t, { baseChecks: ['cancelled'] });
  const report = await target.run();
  assert.equal(report.outcome, 'needs-human');
  assert.equal(report.reason, 'main checks cancelled');
  assert.equal(report.halt, true);
  assert.match(
    target.comments.at(-1)!,
    /needs help\n\nThe checks on main were cancelled before they finished./,
  );
});

test('a user whose checks on main do not finish in time and whose hand-over fails gets the run halted with both reasons', async (t) => {
  const target = await harness(t, { baseChecks: ['timeout'] });
  commentFails(target, 'gh: could not resolve host');
  const report = await target.run();
  assert.equal(report.outcome, 'error');
  assert.equal(
    report.reason,
    'main checks timeout; the hand-over failed: gh: could not resolve host',
  );
  assert.equal(report.halt, true);
});

test('a user whose checks on main fail with no check fix left and whose hand-over fails gets the run halted with both reasons', async (t) => {
  const target = await harness(t, { config: { maxCiFixes: 0 }, baseChecks: ['fail'] });
  commentFails(target, 'gh: could not resolve host');
  const report = await target.run();
  assert.equal(report.outcome, 'error');
  assert.equal(report.reason, 'check budget; the hand-over failed: gh: could not resolve host');
  assert.equal(report.halt, true);
  assert.deepEqual(
    target.reverts.map((entry) => entry.shas),
    [['2']],
  );
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
  const waitForCiChecks = ports.waitForCiChecks;
  ports.waitForCiChecks = async (...args) => {
    order.push(`wait ${args[1]}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
    order.push(`end ${args[1]}`);
    return waitForCiChecks(...args);
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
  const waitForCiChecks = ports.waitForCiChecks;
  let first = true;
  ports.waitForCiChecks = async (...args) => {
    if (first) {
      first = false;
      waiting();
      await held;
    }
    return waitForCiChecks(...args);
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

test('a user with concurrency 2 whose issue halts the run gets the other approved issue stopped before it lands, and landed without a new review by the next run', async (t) => {
  const target = await harness(t, {
    verdicts: [APPROVE, APPROVE],
    config: { maxCiFixes: 0, maxReviewRounds: 1 },
    baseChecks: ['fail'],
    revertFails: true,
  });
  const ports = target.context.ports;
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let waiting: () => void = () => {};
  const landingWaits = new Promise<void>((resolve) => {
    waiting = resolve;
  });
  const waitForCiChecks = ports.waitForCiChecks;
  ports.waitForCiChecks = async (...args) => {
    waiting();
    await held;
    return waitForCiChecks(...args);
  };
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
  const halting = processIssue(target.context, ISSUE);
  await landingWaits;
  const other = processIssue(target.context, { ...ISSUE, number: 8 });
  await otherReviewed;
  release();
  const [first, second] = await Promise.all([halting, other]);
  assert.equal(first.halt, true);
  assert.equal(second.outcome, 'stopped');
  assert.equal(second.reason, 'run halted');
  assert.deepEqual(target.landed, ['2']);
  assert.equal(target.baseMerges, 1);
  assert.notEqual(await readState(target.context.repo, 8), undefined);
  assert.equal(
    target.labels.filter((entry) => entry.number === 8).at(-1)!.label,
    'status:in-review',
  );
  assert.ok(
    target.events.some(
      (record) =>
        record['kind'] === 'issue.end' &&
        record['issue'] === 8 &&
        record['reason'] === 'run halted',
    ),
  );
  target.context.halted = false;
  const resumed = await processIssue(target.context, { ...ISSUE, number: 8 });
  assert.equal(resumed.outcome, 'done');
  assert.equal(target.landed.length, 2);
});

test('a user whose change lands sees the local base at the landed commit while its checks are pending', async (t) => {
  const target = await harness(t);
  const basesAtWait: Array<string | undefined> = [];
  const waitForCiChecks = target.context.ports.waitForCiChecks;
  target.context.ports.waitForCiChecks = async (...args) => {
    basesAtWait.push(target.localBase);
    return waitForCiChecks(...args);
  };
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.deepEqual(basesAtWait, ['2']);
  assert.equal(target.localBase, '2');
});

test('a user whose landed change is reverted sees the local base at the revert commit', async (t) => {
  const target = await harness(t, {
    baseChecks: ['fail'],
    fixerText: 'unrelated: the server does not mount the release',
  });
  const report = await target.run();
  assert.equal(report.outcome, 'needs-human');
  assert.equal(target.localBase, '3');
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

async function resumeAfterRevert(
  t: Parameters<typeof harness>[0],
  saved: IssueState | undefined,
  labels: string[],
) {
  const target = await harness(t, {
    saved,
    issue: { ...ISSUE, labels },
  });
  const rolesAtPush: string[][] = [];
  const pushToBase = target.context.ports.pushToBase;
  target.context.ports.pushToBase = async (...args) => {
    rolesAtPush.push(roles(target));
    return pushToBase(...args);
  };
  const report = await target.run();
  return { report, rolesAtPush };
}

test('a user who stops a run now during the hand-over after a revert of main gets the reverted change reviewed by the next run before any new push', async (t) => {
  const first = await harness(t, {
    config: { maxCiFixes: 0 },
    baseChecks: ['fail'],
    stopNowOnLabel: 'status:needs-human',
  });
  assert.equal((await first.run()).outcome, 'stopped');
  assert.deepEqual(
    first.reverts.map((entry) => entry.shas),
    [['2']],
  );
  const { report, rolesAtPush } = await resumeAfterRevert(t, await first.state(), []);
  assert.equal(report.outcome, 'done');
  assert.ok(rolesAtPush.length > 0);
  assert.ok(rolesAtPush[0]!.includes('reviewer'));
});

test('a user whose hand-over fails after a revert of main gets the reverted change reviewed by the next run before any new push', async (t) => {
  const first = await harness(t, {
    config: { maxCiFixes: 0 },
    baseChecks: ['fail'],
  });
  commentFails(first, 'gh: could not resolve host');
  assert.equal((await first.run()).outcome, 'error');
  const { report, rolesAtPush } = await resumeAfterRevert(t, await first.state(), [
    'status:in-review',
  ]);
  assert.equal(report.outcome, 'done');
  assert.ok(rolesAtPush.length > 0);
  assert.ok(rolesAtPush[0]!.includes('reviewer'));
});

test('a user whose hand-over fails after a resumed stopped revert of main gets the reverted change reviewed by the next run before any new push', async (t) => {
  const first = await harness(t, {
    config: { maxCiFixes: 0 },
    baseChecks: ['fail'],
    revertLandsAndStops: true,
  });
  assert.equal((await first.run()).outcome, 'stopped');
  const saved = await first.state();
  const second = await harness(t, {
    saved,
    issue: { ...ISSUE, labels: [] },
    config: { maxCiFixes: 0 },
    baseChecks: ['fail'],
  });
  second.context.ports.isOnBase = async (_worktree, _base, _remote, sha) =>
    sha === saved?.reverting;
  commentFails(second, 'gh: could not resolve host');
  assert.equal((await second.run()).outcome, 'error');
  assert.deepEqual(second.landed, []);
  const { report, rolesAtPush } = await resumeAfterRevert(t, await second.state(), [
    'status:in-review',
  ]);
  assert.equal(report.outcome, 'done');
  assert.ok(rolesAtPush.length > 0);
  assert.ok(rolesAtPush[0]!.includes('reviewer'));
});
