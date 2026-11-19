import assert from 'node:assert/strict';
import { access, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { REVIEWING, runAgent, toolFields } from '../src/shared/agents.mts';
import { runChildren, stopRunChildren, withRunChildren } from '../src/shared/children.mts';
import { Recorder } from '../src/shared/observe.mts';
import { addSkill, fakeClaude, type Step, text, toolUse } from './fake-claude.mts';
import { logRecords } from './log-records.mts';

async function claude(t: TestContext, steps: Step[] = []) {
  const fake = await fakeClaude(steps);
  t.after(fake.close);
  return { ...fake, steps };
}

const slow = (): Step => text('word '.repeat(3000), 20);

const slowAfter =
  (asked: () => void): Step =>
  () => {
    asked();
    return text('word '.repeat(3000), 20);
  };

test('an agent that reads a file inside its folder has the path logged relative to that folder', async (t) => {
  const { recorder, request, steps } = await claude(t);
  steps.push(toolUse('Read', { file_path: join(request.cwd, 'note.txt') }), text('done'));
  await runAgent(recorder, request);
  const tool = (await logRecords(recorder)).find((record) => record.kind === 'tool')!;
  assert.equal(tool.tool, 'Read');
  assert.equal(tool.path, 'note.txt');
});

test('an agent that calls Read, Write, Edit, Grep, Glob or NotebookEdit has the path logged relative to its folder', () => {
  for (const name of ['Read', 'Write', 'Edit']) {
    assert.deepEqual(toolFields(name, { file_path: '/work/src/a.mts' }, '/work'), {
      tool: name,
      path: 'src/a.mts',
    });
  }
  for (const name of ['Grep', 'Glob']) {
    assert.deepEqual(toolFields(name, { pattern: 'x', path: '/work/src' }, '/work'), {
      tool: name,
      path: 'src',
    });
  }
  assert.deepEqual(toolFields('NotebookEdit', { notebook_path: '/work/a.ipynb' }, '/work'), {
    tool: 'NotebookEdit',
    path: 'a.ipynb',
  });
  assert.deepEqual(toolFields('Glob', { path: '/work' }, '/work'), { tool: 'Glob', path: '.' });
});

test('an agent that reads a file outside its folder has the path logged as it passed it', () => {
  assert.deepEqual(toolFields('Read', { file_path: '/tmp/a.mts' }, '/work'), {
    tool: 'Read',
    path: '/tmp/a.mts',
  });
  assert.deepEqual(toolFields('Read', { file_path: '../other/a.mts' }, '/work'), {
    tool: 'Read',
    path: '../other/a.mts',
  });
});

test('an agent tool call without a path text logs only the tool name', () => {
  assert.deepEqual(toolFields('Read', {}, '/work'), { tool: 'Read' });
  assert.deepEqual(toolFields('Read', { file_path: 12 }, '/work'), { tool: 'Read' });
  assert.deepEqual(toolFields('mark', { file_path: '/work/a' }, '/work'), { tool: 'mark' });
  assert.deepEqual(toolFields('Bash', { command: 'ls', file_path: '/work/a' }, '/work'), {
    tool: 'Bash',
    command: 'ls',
  });
});

test('a Bash call without command text records only its name', () => {
  assert.deepEqual(toolFields('Bash', {}, '/work'), { tool: 'Bash' });
  assert.deepEqual(toolFields('Bash', { command: 12 }, '/work'), { tool: 'Bash' });
  assert.deepEqual(toolFields('Bash', null, '/work'), { tool: 'Bash' });
  assert.deepEqual(toolFields('Bash', 'npm test', '/work'), { tool: 'Bash' });
});

test('an implementer gets the skills of its repository', async (t) => {
  const { recorder, request, bodies } = await claude(t, [text('done')]);
  await addSkill(join(request.cwd, '.claude', 'skills'), 'project-skill');
  await runAgent(recorder, request);
  assert.match(bodies[0]!, /project-skill/);
});

test('an agent in an issue worktree leaves out the create-issue and answer-hand-over skills that next-issue init installed in the project', async (t) => {
  const { recorder, request, bodies } = await claude(t, [text('done')]);
  const worktree = join(request.cwd, '.claude', 'worktrees', '7');
  for (const folder of [request.cwd, worktree]) {
    for (const name of ['create-issue', 'answer-hand-over']) {
      await addSkill(join(folder, '.claude', 'skills'), name);
    }
  }
  await addSkill(join(worktree, '.claude', 'skills'), 'project-skill');
  await runAgent(recorder, { ...request, cwd: worktree });
  assert.match(bodies[0]!, /project-skill/);
  assert.doesNotMatch(bodies[0]!, /create-issue|answer-hand-over/);
});

test('an agent runs git without optional locks', async (t) => {
  const { recorder, request, steps } = await claude(t);
  const mark = join(request.cwd, 'mark');
  steps.push(
    toolUse('Bash', { command: `printf %s "$GIT_OPTIONAL_LOCKS" > ${mark}` }),
    text('done'),
  );
  await runAgent(recorder, request);
  assert.equal(await readFile(mark, 'utf8'), '0');
});

test('a reviewer that calls the Write tool leaves no file', async (t) => {
  const { recorder, request, steps } = await claude(t);
  steps.push(
    toolUse('Write', { file_path: join(request.cwd, 'note.txt'), content: 'hi' }),
    text('done'),
  );
  await runAgent(recorder, { ...request, profile: REVIEWING });
  await assert.rejects(access(join(request.cwd, 'note.txt')));
});

test('an implementer that calls the Write tool writes the file', async (t) => {
  const { recorder, request, steps } = await claude(t);
  steps.push(
    toolUse('Write', { file_path: join(request.cwd, 'note.txt'), content: 'hi' }),
    text('done'),
  );
  await runAgent(recorder, request);
  assert.equal(await readFile(join(request.cwd, 'note.txt'), 'utf8'), 'hi');
});

test('the worker gets the last text, the tool calls and the model of an agent', async (t) => {
  const { recorder, request } = await claude(t, [
    toolUse('Bash', { command: 'ls' }),
    text('  commit: fix: the thing  '),
  ]);
  const result = await runAgent(recorder, request);
  assert.equal(result.text, 'commit: fix: the thing');
  assert.equal(result.toolCalls, 1);
  assert.equal(result.turns, 2);
  assert.equal(result.model, request.model);
  assert.ok(result.usage.total > 0);
});

test('a user who runs an agent sees its events but not its text in the output of the recorder', async (t) => {
  const { request } = await claude(t, [text('agent says hello')]);
  let output = '';
  const recorder = await Recorder.create(request.cwd, undefined, undefined, (value) => {
    output += value;
  });
  await runAgent(recorder, request);
  assert.match(output, /\.usage /);
  assert.doesNotMatch(output, /agent says hello/);
});

test('the worker records a usage event without a cost for an agent', async (t) => {
  const { recorder, request } = await claude(t, [text('done')]);
  const result = await runAgent(recorder, request);
  const usage = (await logRecords(recorder)).find((record) => record.kind === 'usage')!;
  assert.equal(usage.role, request.name);
  assert.equal(usage.turns, 1);
  assert.equal(usage.toolCalls, 0);
  assert.equal(usage.model, request.model);
  assert.equal(usage.session, result.sessionId);
  assert.ok(Number(usage.total) > 0);
  assert.equal('costUsd' in usage, false);
});

test('the worker saves the session of an agent next to the run log', async (t) => {
  const { recorder, request } = await claude(t, [toolUse('Bash', { command: 'ls' }), text('done')]);
  const result = await runAgent(recorder, request);
  const dir = join(recorder.logFile.replace(/\.jsonl$/, ''), 'sessions');
  const files = await readdir(dir);
  assert.equal(files.length, 1);
  const saved = await readFile(join(dir, files[0]!), 'utf8');
  assert.ok(saved.includes(result.sessionId!));
  assert.ok(saved.includes('"Bash"'));
});

test('the worker reports the error when the model of an agent fails', async (t) => {
  const { recorder, request } = await claude(t, [{ error: 'no credit' }]);
  await assert.rejects(runAgent(recorder, request), /^Error: The coder agent failed: .*no credit/);
});

test('a user who stops a run now while an agent starts gets no agent turn, only a stopped run', async (t) => {
  const { recorder, request, bodies } = await claude(t, [text('done')]);
  const children = runChildren();
  const running = withRunChildren(children, () => runAgent(recorder, request));
  setTimeout(() => stopRunChildren(children), 10);
  await assert.rejects(running, { message: 'The run stopped.' });
  assert.equal(bodies.length, 0);
});

async function assertFailedUsage(
  recorder: Recorder,
  request: { name: string; model: string },
): Promise<void> {
  const usages = (await logRecords(recorder)).filter((record) => record.kind === 'usage');
  assert.equal(usages.length, 1);
  const usage = usages[0]!;
  assert.equal(usage.role, request.name);
  assert.equal(usage.turns, 1);
  assert.equal(usage.toolCalls, 1);
  assert.equal(usage.model, request.model);
  assert.equal(typeof usage.session, 'string');
  assert.ok(Number(usage.total) > 0);
  const summary = recorder.summary();
  assert.equal(summary.roles[request.name]?.calls, 1);
  assert.equal(summary.total.total, usage.total);
}

test('a user whose agent times out sees a usage event and summary totals with the tokens it spent', async (t) => {
  const { recorder, request } = await claude(t, [toolUse('Bash', { command: 'ls' }), slow()]);
  await assert.rejects(runAgent(recorder, { ...request, timeoutMs: 10_000 }), {
    message: 'The coder agent did not finish in 10000 ms.',
  });
  await assertFailedUsage(recorder, request);
});

test('a user whose agent model fails sees a usage event and summary totals with the tokens it spent', async (t) => {
  const { recorder, request } = await claude(t, [
    toolUse('Bash', { command: 'ls' }),
    { error: 'no credit' },
  ]);
  await assert.rejects(runAgent(recorder, request), /The coder agent failed/);
  await assertFailedUsage(recorder, request);
});

test('a user who stops a run now while an agent runs sees a usage event and summary totals with the tokens it spent', async (t) => {
  const children = runChildren();
  const { recorder, request } = await claude(t, [
    toolUse('Bash', { command: 'ls' }),
    slowAfter(() => stopRunChildren(children)),
  ]);
  const running = withRunChildren(children, () => runAgent(recorder, request));
  await assert.rejects(running, { message: 'The run stopped.' });
  await assertFailedUsage(recorder, request);
});

test('a user whose agent succeeds sees exactly one usage event', async (t) => {
  const { recorder, request } = await claude(t, [text('done')]);
  await runAgent(recorder, request);
  const usages = (await logRecords(recorder)).filter((record) => record.kind === 'usage');
  assert.equal(usages.length, 1);
  assert.equal(recorder.summary().roles[request.name]?.calls, 1);
});

test('a user who sets a model in the old provider/model form gets an error that asks for a Claude model ID', async (t) => {
  const { recorder, request, bodies } = await claude(t, [text('done')]);
  await assert.rejects(runAgent(recorder, { ...request, model: 'anthropic/claude-opus-5-5' }), {
    message:
      'The model anthropic/claude-opus-5-5 is not a Claude model ID. Use an ID such as claude-opus-5-5.',
  });
  assert.equal(bodies.length, 0);
});
