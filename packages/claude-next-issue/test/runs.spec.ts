import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { tempDir } from '../../next-issue/test/temp-dir.mts';
import { issueDetail } from '../src/detail.ts';
import { issueNote, pastRuns, runLine, summaryLines } from '../src/past.ts';
import { nodeHost } from './node-host.ts';

const RUN = '2026-11-18T09-00-00-000Z';

async function repositoryWithRun(): Promise<string> {
  const root = await tempDir();
  const runs = join(root, '.next-issue', 'runs');
  await mkdir(join(runs, RUN, 'sessions'), { recursive: true });
  const events = [
    { ts: '2026-11-18T09:00:01.000Z', kind: 'issue.start', issue: 7 },
    {
      ts: '2026-11-18T09:00:02.000Z',
      kind: 'usage',
      issue: 7,
      role: 'implementer',
      session: 'abc',
    },
    { ts: '2026-11-18T09:00:03.000Z', kind: 'issue.end', issue: 7, outcome: 'done' },
    { ts: '2026-11-18T09:00:04.000Z', kind: 'issue.error', issue: 8, error: 'gh failed' },
    { ts: '2026-11-18T09:00:05.000Z', kind: 'run.end' },
  ];
  await writeFile(
    join(runs, `${RUN}.jsonl`),
    events.map((event) => JSON.stringify(event)).join('\n'),
  );
  await writeFile(
    join(runs, `${RUN}.summary.json`),
    JSON.stringify({ total: { total: 1500 }, roles: { implementer: { total: 1500, ms: 65_000 } } }),
  );
  const session = [
    { type: 'system', subtype: 'init', session_id: 'abc' },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Reading the code' }] } },
    {
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }],
      },
    },
    {
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'README.md' }] },
    },
    { type: 'result', subtype: 'success', result: 'commit: fix: the thing' },
  ];
  await writeFile(
    join(runs, RUN, 'sessions', 'abc.jsonl'),
    session.map((line) => JSON.stringify(line)).join('\n'),
  );
  await writeFile(
    join(root, '.next-issue', 'worker.log'),
    '10:00:01 #7 implement\n10:00:02 #8 setup\n',
  );
  return root;
}

test('a person who opens the past runs sees each run with its end, its issues and its tokens', async () => {
  const root = await repositoryWithRun();
  const [run] = await pastRuns(nodeHost, root);
  assert.ok(run);
  assert.equal(runLine(run), '2026-11-18 09:00:00 UTC · finished');
  assert.deepEqual(run.issues.map(issueNote), ['#7 done', '#8 failed: gh failed']);
  assert.deepEqual(summaryLines(run), ['Tokens: 1,500', '  implementer: 1,500 tokens · 1m05s']);
});

test('a person who opens the past runs of a repository with none sees no runs', async () => {
  assert.deepEqual(await pastRuns(nodeHost, await tempDir()), []);
});

test('a person who opens an issue sees its run events, its worker log lines and what its agents said and ran', async () => {
  const root = await repositoryWithRun();
  const lines = await issueDetail(nodeHost, root, 7, undefined);
  assert.equal(lines[0], 'Issue #7 · run 2026-11-18 09:00:00 UTC');
  assert.ok(lines.includes('  09:00:01 issue.start'));
  assert.ok(lines.includes('  10:00:01 #7 implement'));
  assert.ok(!lines.includes('  10:00:02 #8 setup'));
  const session = lines.slice(lines.indexOf('Session: implementer'));
  assert.deepEqual(session, [
    'Session: implementer',
    '  assistant: Reading the code',
    '  tool call Bash: {"command":"ls"}',
    '  tool result Bash: README.md',
  ]);
});
