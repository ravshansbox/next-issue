import {
  type AgentSession,
  type AgentSessionEvent,
  getAgentDir,
  type ModelRuntime,
  type SettingsManager,
} from '@earendil-works/pi-coding-agent';
import { openSession } from './agent-session.mts';
import { onStop } from './children.mts';
import { deadline, elapsedMs } from './durations.mts';
import type { Fields, Recorder } from './observe.mts';
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
  costUsd: number;
  model?: string;
  sessionId?: string;
};

export const REVIEWING: Profile = {
  tools: ['+grep', '+find', '+ls', '-edit', '-write'],
};

export const CODING: Profile = {
  tools: ['+grep', '+find', '+ls'],
};

export async function runAgent(recorder: Recorder, request: AgentRequest): Promise<AgentResult> {
  const log = recorder.scope({ role: request.name });
  const agentDir = request.runtime?.agentDir ?? getAgentDir();
  const started = Date.now();
  process.env.GIT_OPTIONAL_LOCKS = '0';
  log.event('agent.start', { model: request.model, timeoutMs: request.timeoutMs }, 'normal');
  const session = await openSession(recorder, log, request, agentDir);

  const timer = deadline(request.timeoutMs, () => void session.abort());
  const unsubscribe = session.subscribe((event) => observe(log, event));
  const release = onStop(() => void session.abort());
  try {
    await session.bindExtensions({});
    await session.prompt(request.prompt, { expandPromptTemplates: false });
    if (timer.timedOut()) {
      throw new Error(`The ${request.name} agent did not finish in ${request.timeoutMs} ms.`);
    }
    const failure = lastFailure(session);
    if (failure !== undefined) {
      throw new Error(`The ${request.name} agent failed: ${failure}`);
    }
    return sessionResult(recorder, request, session, started);
  } finally {
    timer.clear();
    release();
    unsubscribe();
    session.dispose();
  }
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
    costUsd: stats.cost,
  });
  return {
    text: (session.getLastAssistantText() ?? '').trim(),
    usage,
    turns: stats.assistantMessages,
    toolCalls: stats.toolCalls,
    ms,
    costUsd: stats.cost,
    model: name,
    sessionId: stats.sessionId,
  };
}

function observe(log: Recorder, event: AgentSessionEvent): void {
  if (event.type === 'tool_execution_start') {
    log.event('tool', toolFields(event.toolName, event.args));
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

export function toolFields(name: string, input: unknown): Fields {
  if (name !== 'bash' || typeof input !== 'object' || input === null) {
    return { tool: name };
  }
  const { command } = input as { command?: unknown };
  return typeof command === 'string' ? { tool: name, command } : { tool: name };
}
