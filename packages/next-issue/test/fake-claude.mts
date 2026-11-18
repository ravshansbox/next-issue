import { mkdir, writeFile } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { CODING } from '../src/shared/agents.mts';
import { Recorder } from '../src/shared/observe.mts';
import { tempDir } from './temp-dir.mts';

export type Block =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };

export type Reply = { content: Block[]; delayMs?: number } | { error: string };

export type Step = Reply | ((body: string) => Reply);

export function text(value: string, delayMs?: number): Reply {
  return {
    content: [{ type: 'text', text: value }],
    ...(delayMs === undefined ? {} : { delayMs }),
  };
}

let calls = 0;

export function toolUse(name: string, input: Record<string, unknown>): Reply {
  calls += 1;
  return { content: [{ type: 'tool_use', id: `toolu_${calls}`, name, input }] };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function stream(response: ServerResponse, model: string, content: Block[], delayMs: number) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const send = (event: string, data: Record<string, unknown>): void => {
    response.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
  };
  send('message_start', {
    message: {
      id: `msg_${Math.random()}`,
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 7, output_tokens: 1 },
    },
  });
  for (const [index, block] of content.entries()) {
    if (block.type === 'text') {
      send('content_block_start', { index, content_block: { type: 'text', text: '' } });
      for (const word of block.text.split(/(?<= )/)) {
        if (response.destroyed) {
          return;
        }
        send('content_block_delta', { index, delta: { type: 'text_delta', text: word } });
        await sleep(delayMs);
      }
    } else {
      send('content_block_start', { index, content_block: { ...block, input: {} } });
      send('content_block_delta', {
        index,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) },
      });
    }
    send('content_block_stop', { index });
  }
  const toolCall = content.some((block) => block.type === 'tool_use');
  send('message_delta', {
    delta: { stop_reason: toolCall ? 'tool_use' : 'end_turn', stop_sequence: null },
    usage: { output_tokens: 5 },
  });
  send('message_stop', {});
  response.end();
}

export async function fakeClaude(steps: Step[]) {
  const root = await tempDir();
  const config = join(root, '.claude-config');
  await mkdir(config, { recursive: true });
  const bodies: string[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    request.on('end', () => {
      const parsed = JSON.parse(body || '{}') as { model?: string; tools?: unknown[] };
      if (!request.url?.startsWith('/v1/messages') || request.url.includes('count_tokens')) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ input_tokens: 1 }));
        return;
      }
      const main = Array.isArray(parsed.tools) && parsed.tools.length > 0;
      const next = main ? steps.shift() : text('side');
      const reply = typeof next === 'function' ? next(body) : (next ?? text('extra'));
      if (main) {
        bodies.push(body);
      }
      if ('error' in reply) {
        steps.unshift(reply);
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            type: 'error',
            error: { type: 'invalid_request_error', message: reply.error },
          }),
        );
        return;
      }
      void stream(response, parsed.model ?? 'claude-test', reply.content, reply.delayMs ?? 0);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    root,
    config,
    bodies,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    recorder: await Recorder.create(root),
    request: {
      name: 'coder',
      cwd: root,
      prompt: 'hi',
      profile: CODING,
      model: 'claude-opus-5-5',
      runtime: {
        env: {
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
          ANTHROPIC_API_KEY: 'test',
          CLAUDE_CONFIG_DIR: config,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        },
      },
    },
  };
}

export async function addPluginSkills(
  config: string,
  plugins: Record<string, string>,
): Promise<void> {
  const market = join(config, 'market');
  await mkdir(join(market, '.claude-plugin'), { recursive: true });
  await writeFile(
    join(market, '.claude-plugin', 'marketplace.json'),
    JSON.stringify({
      name: 'next-issue',
      owner: { name: 'test' },
      plugins: Object.keys(plugins).map((name) => ({ name, source: `./plugins/${name}` })),
    }),
  );
  for (const [plugin, skill] of Object.entries(plugins)) {
    const folder = join(market, 'plugins', plugin);
    await mkdir(join(folder, '.claude-plugin'), { recursive: true });
    await writeFile(
      join(folder, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: plugin, version: '0.1.0', description: plugin }),
    );
    await addSkill(join(folder, 'skills'), skill);
  }
  await writeFile(
    join(config, 'settings.json'),
    JSON.stringify({
      extraKnownMarketplaces: { 'next-issue': { source: { source: 'directory', path: market } } },
      enabledPlugins: Object.fromEntries(
        Object.keys(plugins).map((name) => [`${name}@next-issue`, true]),
      ),
    }),
  );
}

export async function addSkill(folder: string, name: string): Promise<void> {
  await mkdir(join(folder, name), { recursive: true });
  await writeFile(
    join(folder, name, 'SKILL.md'),
    `---\nname: ${name}\ndescription: The ${name} skill.\n---\n\n# ${name}\n`,
  );
}
