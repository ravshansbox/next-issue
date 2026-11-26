import { type ChildProcess, spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import type { Readable, Writable } from 'node:stream';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { query, type SDKMessage, type Settings } from '@anthropic-ai/claude-agent-sdk';
import { killTree, onStop, refuseWhenStopped, watch } from './children.mts';
import { deadline, elapsedMs } from './durations.mts';
import type { Fields, Recorder } from './observe.mts';
import { isRecord } from './records.mts';
import { addUsage, emptyUsage, type Usage } from './usage.mts';

export type Profile = {
  disallowedTools: string[];
};

type Runtime = {
  env?: Record<string, string>;
};

export type AgentRequest = {
  name: string;
  cwd: string;
  prompt: string;
  profile: Profile;
  model?: string;
  timeoutMs?: number;
  runtime?: Runtime;
};

export type AgentResult = {
  text: string;
  usage: Usage;
  turns: number;
  toolCalls: number;
  ms: number;
  model?: string;
  sessionId?: string;
};

export const REVIEWING: Profile = {
  disallowedTools: ['Write', 'Edit', 'NotebookEdit'],
};

export const CODING: Profile = {
  disallowedTools: [],
};

export const OWN_SKILLS = ['create-issue', 'answer-hand-over'];

const OWN_SETTINGS: Settings = {
  skillOverrides: Object.fromEntries(OWN_SKILLS.map((name) => [name, 'off'])),
};

type Session = {
  messages: SDKMessage[];
  usages: Map<string, Usage>;
  tools: Map<string, string>;
  toolCalls: number;
  text: string;
  model?: string;
  sessionId?: string;
  failure?: string;
  final?: Usage;
};

export async function runAgent(recorder: Recorder, request: AgentRequest): Promise<AgentResult> {
  checkModel(request.model);
  const log = recorder.scope({ role: request.name });
  const started = Date.now();
  log.event('agent.start', { model: request.model, timeoutMs: request.timeoutMs });
  let ended = false;
  let child: ChildProcess | undefined;
  const end = (): void => {
    ended = true;
    if (child !== undefined) {
      killTree(child);
    }
  };
  const timer = deadline(request.timeoutMs, end);
  const release = onStop(end);
  const session: Session = {
    messages: [],
    usages: new Map(),
    tools: new Map(),
    toolCalls: 0,
    text: '',
  };
  try {
    refuseWhenStopped();
    let result: AgentResult;
    try {
      const agent = query({
        prompt: request.prompt,
        options: {
          cwd: request.cwd,
          disallowedTools: request.profile.disallowedTools,
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
          persistSession: false,
          settings: OWN_SETTINGS,
          env: { ...process.env, ...request.runtime?.env, GIT_OPTIONAL_LOCKS: '0' },
          ...(request.model === undefined ? {} : { model: request.model }),
          spawnClaudeCodeProcess: ({ command, args, cwd, env }) => {
            child = spawn(command, args, {
              cwd,
              env,
              detached: true,
              stdio: ['pipe', 'pipe', 'ignore'],
            });
            const unwatch = watch(child.pid);
            child.once('exit', unwatch);
            if (ended) {
              killTree(child);
            }
            return child as ChildProcess & { stdin: Writable; stdout: Readable };
          },
        },
      });
      for await (const message of agent) {
        observe(log, session, message, request.cwd);
      }
    } catch (error) {
      if (!ended && session.failure === undefined) {
        throw error;
      }
    } finally {
      result = await sessionResult(recorder, request, session, started);
    }
    refuseWhenStopped();
    if (timer.timedOut()) {
      throw new Error(`The ${request.name} agent did not finish in ${request.timeoutMs} ms.`);
    }
    if (session.failure !== undefined) {
      throw new Error(`The ${request.name} agent failed: ${session.failure}`);
    }
    return result;
  } finally {
    timer.clear();
    release();
  }
}

function checkModel(model: string | undefined): void {
  if (model?.includes('/') === true) {
    throw new Error(
      `The model ${model} is not a Claude model ID. Use an ID such as claude-opus-5-5.`,
    );
  }
}

function observe(log: Recorder, session: Session, message: SDKMessage, cwd: string): void {
  session.messages.push(message);
  if (message.type === 'system' && message.subtype === 'init') {
    session.model = message.model;
    session.sessionId = message.session_id;
  } else if (
    message.type === 'assistant' &&
    message.parent_tool_use_id === null &&
    message.error === undefined
  ) {
    const { id, usage, content } = message.message;
    session.usages.set(id, {
      ...emptyUsage(),
      input: usage.input_tokens,
      output: usage.output_tokens,
      cacheRead: usage.cache_read_input_tokens ?? 0,
      cacheWrite: usage.cache_creation_input_tokens ?? 0,
    });
    for (const block of content) {
      if (block.type === 'tool_use') {
        session.toolCalls += 1;
        session.tools.set(block.id, block.name);
        log.event('tool', toolFields(block.name, block.input, cwd));
      } else if (block.type === 'text') {
        session.text = block.text;
      }
    }
  } else if (message.type === 'user' && Array.isArray(message.message.content)) {
    for (const block of message.message.content) {
      if (block.type === 'tool_result' && block.is_error === true) {
        log.event('tool.error', { tool: session.tools.get(block.tool_use_id) });
      }
    }
  } else if (message.type === 'result') {
    session.final = emptyUsage();
    for (const usage of Object.values(message.modelUsage)) {
      session.final.input += usage.inputTokens;
      session.final.output += usage.outputTokens;
      session.final.cacheRead += usage.cacheReadInputTokens;
      session.final.cacheWrite += usage.cacheCreationInputTokens;
    }
    if (message.subtype === 'success' && !message.is_error) {
      session.text = message.result;
    } else {
      session.failure =
        message.subtype === 'success'
          ? message.result
          : message.errors.join('; ') || message.subtype;
    }
  }
}

function totalOf(usage: Usage): Usage {
  return { ...usage, total: usage.input + usage.output + usage.cacheRead + usage.cacheWrite };
}

async function sessionResult(
  recorder: Recorder,
  request: AgentRequest,
  session: Session,
  started: number,
): Promise<AgentResult> {
  let usage = session.final;
  if (usage === undefined) {
    usage = emptyUsage();
    for (const each of session.usages.values()) {
      addUsage(usage, each);
    }
  }
  usage = totalOf(usage);
  const model = request.model ?? session.model;
  const turns = session.usages.size;
  const ms = elapsedMs(started);
  await saveSession(recorder, session);
  recorder.usage(request.name, usage, ms, {
    turns,
    toolCalls: session.toolCalls,
    model,
    session: session.sessionId,
  });
  return {
    text: session.text.trim(),
    usage,
    turns,
    toolCalls: session.toolCalls,
    ms,
    model,
    sessionId: session.sessionId,
  };
}

async function saveSession(recorder: Recorder, session: Session): Promise<void> {
  if (session.sessionId === undefined) {
    return;
  }
  await mkdir(recorder.sessionDir, { recursive: true });
  await writeFile(
    join(recorder.sessionDir, `${session.sessionId}.jsonl`),
    session.messages.map((message) => `${JSON.stringify(message)}\n`).join(''),
  );
}

const PATH_FIELDS: Record<string, string> = {
  Read: 'file_path',
  Write: 'file_path',
  Edit: 'file_path',
  Grep: 'path',
  Glob: 'path',
  NotebookEdit: 'notebook_path',
};

export function toolFields(name: string, input: unknown, cwd: string): Fields {
  if (!isRecord(input)) {
    return { tool: name };
  }
  const { command } = input;
  if (name === 'Bash' && typeof command === 'string') {
    return { tool: name, command };
  }
  const field = PATH_FIELDS[name];
  const path = field === undefined ? undefined : input[field];
  if (typeof path === 'string') {
    return { tool: name, path: shortPath(path, cwd) };
  }
  return { tool: name };
}

function shortPath(path: string, cwd: string): string {
  const inside = relative(cwd, resolve(cwd, path));
  if (inside === '') {
    return '.';
  }
  return inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside) ? path : inside;
}
