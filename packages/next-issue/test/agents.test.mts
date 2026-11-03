import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type FauxResponseStep,
} from '@earendil-works/pi-ai';
import { ModelRuntime, SettingsManager } from '@earendil-works/pi-coding-agent';
import { CODING, isOwnResource, REVIEWING, runAgent, toolFields } from '../src/agents.mts';
import { Recorder } from '../src/observe.mts';

async function fakePi(responses: FauxResponseStep[], tokensPerSecond?: number) {
  const root = await mkdtemp(join(tmpdir(), 'next-issue-'));
  const faux = fauxProvider(tokensPerSecond === undefined ? {} : { tokensPerSecond });
  const modelRuntime = await ModelRuntime.create({
    authPath: join(root, 'auth.json'),
    modelsPath: null,
    allowModelNetwork: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  faux.setResponses(responses);
  const model = faux.getModel();
  return {
    recorder: await Recorder.create(root, 'quiet'),
    request: {
      name: 'coder',
      cwd: root,
      prompt: 'hi',
      profile: CODING,
      model: `${model.provider}/${model.id}`,
      runtime: { agentDir: root, modelRuntime, settingsManager: SettingsManager.inMemory() },
    },
  };
}

test('a bash call records the command', () => {
  assert.deepEqual(toolFields('bash', { command: 'npm test' }), {
    tool: 'bash',
    command: 'npm test',
  });
});

test('a tool that is not bash records only its name', () => {
  assert.deepEqual(toolFields('read', { path: '/tmp/a.mts' }), { tool: 'read' });
});

test('a bash call without command text records only its name', () => {
  assert.deepEqual(toolFields('bash', {}), { tool: 'bash' });
  assert.deepEqual(toolFields('bash', { command: 12 }), { tool: 'bash' });
  assert.deepEqual(toolFields('bash', null), { tool: 'bash' });
  assert.deepEqual(toolFields('bash', 'npm test'), { tool: 'bash' });
});

test('an agent session leaves out the pi-next-issue extension and keeps the others', () => {
  assert.equal(isOwnResource('/home/me/node_modules/@ravshansbox/pi-next-issue/index.ts'), true);
  assert.equal(isOwnResource('/home/me/next-issue/packages/pi-next-issue/index.ts'), true);
  assert.equal(isOwnResource('/home/me/node_modules/@ravshansbox/pi-statusline/index.ts'), false);
});

async function addSkill(folder: string, name: string): Promise<void> {
  await mkdir(join(folder, name), { recursive: true });
  await writeFile(
    join(folder, name, 'SKILL.md'),
    `---\nname: ${name}\ndescription: The ${name} skill.\n---\n\n# ${name}\n`,
  );
}

test('an agent session leaves out the skills of pi-next-issue and keeps the others', async () => {
  let transcript = '';
  const { recorder, request } = await fakePi([
    (context) => {
      transcript = JSON.stringify(context.messages);
      return fauxAssistantMessage('done');
    },
  ]);
  await addSkill(join(request.cwd, 'skills', 'pi-next-issue'), 'create-issue');
  await addSkill(join(request.cwd, 'skills'), 'other-skill');
  await runAgent(recorder, request);
  assert.match(transcript, /other-skill/);
  assert.doesNotMatch(transcript, /create-issue/);
});

async function markExtension(root: string, value = "'yes'"): Promise<string> {
  const mark = join(root, 'marked');
  await mkdir(join(root, 'extensions'), { recursive: true });
  await writeFile(
    join(root, 'extensions', 'mark.ts'),
    `import { writeFileSync } from 'node:fs';
export default function (pi) {
  pi.registerTool({
    name: 'mark',
    label: 'Mark',
    description: 'Leave a mark',
    parameters: { type: 'object', properties: {} },
    async execute() {
      writeFileSync(${JSON.stringify(mark)}, ${value});
      return { content: [{ type: 'text', text: 'marked' }], details: {} };
    },
  });
}
`,
  );
  return mark;
}

test('an implementer can call a tool that a pi extension adds', async () => {
  const { recorder, request } = await fakePi([
    fauxAssistantMessage([fauxToolCall('mark', {})], { stopReason: 'toolUse' }),
    fauxAssistantMessage('done'),
  ]);
  const mark = await markExtension(request.cwd);
  await runAgent(recorder, request);
  assert.equal(await readFile(mark, 'utf8'), 'yes');
});

test('a pi extension in an agent session runs git without optional locks', async () => {
  delete process.env.GIT_OPTIONAL_LOCKS;
  const { recorder, request } = await fakePi([
    fauxAssistantMessage([fauxToolCall('mark', {})], { stopReason: 'toolUse' }),
    fauxAssistantMessage('done'),
  ]);
  const mark = await markExtension(request.cwd, 'String(process.env.GIT_OPTIONAL_LOCKS)');
  await runAgent(recorder, request);
  assert.equal(await readFile(mark, 'utf8'), '0');
});

test('a reviewer that calls the write tool leaves no file', async () => {
  const { recorder, request } = await fakePi([
    fauxAssistantMessage([fauxToolCall('write', { path: 'note.txt', content: 'hi' })], {
      stopReason: 'toolUse',
    }),
    fauxAssistantMessage('done'),
  ]);
  await runAgent(recorder, { ...request, profile: REVIEWING });
  await assert.rejects(access(join(request.cwd, 'note.txt')));
});

test('an implementer that calls the write tool writes the file', async () => {
  const { recorder, request } = await fakePi([
    fauxAssistantMessage([fauxToolCall('write', { path: 'note.txt', content: 'hi' })], {
      stopReason: 'toolUse',
    }),
    fauxAssistantMessage('done'),
  ]);
  await runAgent(recorder, request);
  assert.equal(await readFile(join(request.cwd, 'note.txt'), 'utf8'), 'hi');
});

test('the harness gets the last text, the tool calls and the model of a pi agent', async () => {
  const { recorder, request } = await fakePi([
    fauxAssistantMessage([fauxToolCall('ls', { path: '.' })], { stopReason: 'toolUse' }),
    fauxAssistantMessage('  commit: fix: the thing  '),
  ]);
  const result = await runAgent(recorder, request);
  assert.equal(result.text, 'commit: fix: the thing');
  assert.equal(result.toolCalls, 1);
  assert.equal(result.turns, 2);
  assert.equal(result.model, request.model);
  assert.ok(result.usage.total > 0);
});

test('the harness saves the session of a pi agent next to the run log', async () => {
  const { recorder, request } = await fakePi([
    fauxAssistantMessage([fauxToolCall('ls', { path: '.' })], { stopReason: 'toolUse' }),
    fauxAssistantMessage('done'),
  ]);
  const result = await runAgent(recorder, request);
  const dir = join(recorder.logFile.replace(/\.jsonl$/, ''), 'sessions');
  const files = await readdir(dir);
  assert.equal(files.length, 1);
  const saved = await readFile(join(dir, files[0]!), 'utf8');
  assert.ok(saved.includes(result.sessionId!));
  assert.ok(saved.includes('"ls"'));
});

test('the harness reports the error when the model of a pi agent fails', async () => {
  const { recorder, request } = await fakePi([
    fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'no credit' }),
  ]);
  request.runtime.settingsManager = SettingsManager.inMemory({ retry: { enabled: false } });
  await assert.rejects(runAgent(recorder, request), {
    message: 'The coder agent failed: no credit',
  });
});

test('the harness reports a timeout when a pi agent runs too long', async () => {
  const { recorder, request } = await fakePi([fauxAssistantMessage('word '.repeat(500))], 5);
  await assert.rejects(runAgent(recorder, { ...request, timeoutMs: 200 }), {
    message: 'The coder agent did not finish in 200 ms.',
  });
});

test('the harness refuses a model name without a provider', async () => {
  const { recorder, request } = await fakePi([]);
  await assert.rejects(runAgent(recorder, { ...request, model: 'opus' }), {
    message: 'The model opus is not in the form provider/model.',
  });
});

test('the harness refuses a model that pi does not know', async () => {
  const { recorder, request } = await fakePi([]);
  await assert.rejects(runAgent(recorder, { ...request, model: 'faux/none' }), {
    message: 'The model faux/none is not known to pi.',
  });
});
