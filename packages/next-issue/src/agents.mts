import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type AgentSession,
  type AgentSessionEvent,
  getAgentDir,
  type ModelRuntime,
  type SettingsManager,
} from '@earendil-works/pi-coding-agent';
import { openSession } from './agent-session.mts';
import { onStop, refuseWhenStopped } from './children.mts';
import { deadline, elapsedMs } from './durations.mts';
import type { Fields, Recorder } from './observe.mts';
import { isRecord } from './records.mts';
import { emptyUsage, type Usage } from './usage.mts';

export type Profile = {
  tools: string[];
};

type Runtime = {
  agentDir?: string;
  modelRuntime?: ModelRuntime;
  settingsManager?: SettingsManager;
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
  tools: ['+grep', '+find', '+ls', '-edit', '-write'],
};

export const CODING: Profile = {
  tools: ['+grep', '+find', '+ls'],
};

const PI_CLI = piCli();

function piCli(): string {
  const root = dirname(
    dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))),
  );
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    bin: { pi: string };
  };
  return join(root, manifest.bin.pi);
}

export async function runAgent(recorder: Recorder, request: AgentRequest): Promise<AgentResult> {
  const log = recorder.scope({ role: request.name });
  const agentDir = request.runtime?.agentDir ?? getAgentDir();
  const started = Date.now();
  process.env.GIT_OPTIONAL_LOCKS = '0';
  process.argv[1] = PI_CLI;
  log.event('agent.start', { model: request.model, timeoutMs: request.timeoutMs });

  // pi drops an abort that comes before its run starts (during bindExtensions or the prompt
  // preflight), so remember it and abort again once the run is active, before its first turn.
  let opened: AgentSession | undefined;
  let ended = false;
  let expire = (): void => undefined;
  const expired = new Promise<undefined>((resolve) => {
    expire = () => resolve(undefined);
  });
  const end = (): void => {
    ended = true;
    void opened?.abort();
  };
  const timer = deadline(request.timeoutMs, () => {
    expire();
    end();
  });
  const session = await openWithin(openSession(recorder, log, request, agentDir), expired).catch(
    (error: unknown) => {
      timer.clear();
      throw error;
    },
  );
  if (session === undefined) {
    throw timeoutError(request);
  }
  opened = session;
  const unsubscribe = session.subscribe((event) => observe(log, event, request.cwd));
  const release = onStop(end);
  try {
    refuseWhenStopped();
    await session.bindExtensions({});
    let result: AgentResult;
    try {
      if (!ended) {
        await session.prompt(request.prompt, {
          expandPromptTemplates: false,
          preflightResult: (disposition) => {
            if (disposition === 'started' && ended) {
              void session.abort();
            }
          },
        });
      }
    } finally {
      // A call that times out, fails or is stopped has spent tokens too.
      result = sessionResult(recorder, request, session, started);
    }
    refuseWhenStopped();
    if (timer.timedOut()) {
      throw timeoutError(request);
    }
    const failure = lastFailure(session);
    if (failure !== undefined) {
      throw new Error(`The ${request.name} agent failed: ${failure}`);
    }
    return result;
  } finally {
    timer.clear();
    release();
    unsubscribe();
    session.dispose();
  }
}

async function openWithin(
  opening: Promise<AgentSession>,
  expired: Promise<undefined>,
): Promise<AgentSession | undefined> {
  const session = await Promise.race([opening, expired]);
  if (session === undefined) {
    opening.then(
      (late) => late.dispose(),
      () => undefined,
    );
  }
  return session;
}

function timeoutError(request: AgentRequest): Error {
  return new Error(`The ${request.name} agent did not finish in ${request.timeoutMs} ms.`);
}

function lastFailure(session: AgentSession): string | undefined {
  const last = session.messages.findLast((message) => message.role === 'assistant');
  if (last === undefined || !('stopReason' in last) || last.stopReason !== 'error') {
    return undefined;
  }
  return last.errorMessage ?? 'no reason given';
}

function sessionResult(
  recorder: Recorder,
  request: AgentRequest,
  session: AgentSession,
  started: number,
): AgentResult {
  const stats = session.getSessionStats();
  const usage: Usage = { ...emptyUsage(), ...stats.tokens };
  const name =
    session.model === undefined ? undefined : `${session.model.provider}/${session.model.id}`;
  const ms = elapsedMs(started);
  recorder.usage(request.name, usage, ms, {
    turns: stats.assistantMessages,
    toolCalls: stats.toolCalls,
    model: name,
    session: stats.sessionId,
  });
  return {
    text: (session.getLastAssistantText() ?? '').trim(),
    usage,
    turns: stats.assistantMessages,
    toolCalls: stats.toolCalls,
    ms,
    model: name,
    sessionId: stats.sessionId,
  };
}

function observe(log: Recorder, event: AgentSessionEvent, cwd: string): void {
  if (event.type === 'tool_execution_start') {
    log.event('tool', toolFields(event.toolName, event.args, cwd));
  } else if (event.type === 'tool_execution_end' && event.isError) {
    log.event('tool.error', { tool: event.toolName }, 'quiet');
  } else if (
    event.type === 'message_update' &&
    event.assistantMessageEvent.type === 'text_delta' &&
    log.level === 'verbose'
  ) {
    process.stderr.write(event.assistantMessageEvent.delta);
  }
}

const PATH_TOOLS = new Set(['read', 'write', 'edit', 'grep', 'find', 'ls']);

export function toolFields(name: string, input: unknown, cwd: string): Fields {
  if (!isRecord(input)) {
    return { tool: name };
  }
  const { command, path } = input;
  if (name === 'bash' && typeof command === 'string') {
    return { tool: name, command };
  }
  if (PATH_TOOLS.has(name) && typeof path === 'string') {
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
