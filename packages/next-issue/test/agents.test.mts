import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
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
import { CODING, isOwnExtension, REVIEWING, runAgent, toolFields } from '../src/agents.mts';
import { Recorder } from '../src/observe.mts';
import { VERDICT_SCHEMA } from '../src/verdict.mts';

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
  assert.equal(isOwnExtension('/home/me/node_modules/@ravshansbox/pi-next-issue/index.ts'), true);
  assert.equal(isOwnExtension('/home/me/next-issue/packages/pi-next-issue/index.ts'), true);
  assert.equal(isOwnExtension('/home/me/node_modules/@ravshansbox/pi-statusline/index.ts'), false);
});

test('the reviewer gets no tool that writes files', () => {
  assert.equal(REVIEWING.tools.includes('edit'), false);
  assert.equal(REVIEWING.tools.includes('write'), false);
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

test('the harness gets the verdict that the reviewer submits with the result tool', async () => {
  const verdict = { summary: 'fine', findings: [{ severity: 'minor', detail: 'a typo' }] };
  const { recorder, request } = await fakePi([
    fauxAssistantMessage([fauxToolCall('submit_result', verdict)], { stopReason: 'toolUse' }),
  ]);
  const result = await runAgent(recorder, {
    ...request,
    profile: REVIEWING,
    outputSchema: VERDICT_SCHEMA,
  });
  assert.deepEqual(result.structured, verdict);
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
