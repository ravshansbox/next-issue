import { join, sep } from 'node:path';
import {
  type AgentSession,
  type AgentSessionEvent,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  type SettingsManager,
} from '@earendil-works/pi-coding-agent';
import { onStop } from './exec.mts';
import type { Fields, Recorder } from './observe.mts';
import { emptyUsage, type Usage } from './usage.mts';

export type Profile = {
  tools: string[];
};

export type Runtime = {
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

export function isOwnResource(path: string): boolean {
  return path.split(sep).includes('pi-next-issue');
}

export async function runAgent(recorder: Recorder, request: AgentRequest): Promise<AgentResult> {
  const log = recorder.scope({ role: request.name });
  const agentDir = request.runtime?.agentDir ?? getAgentDir();
  const started = Date.now();
  process.env.GIT_OPTIONAL_LOCKS = '0';
  log.event('agent.start', { model: request.model, timeoutMs: request.timeoutMs }, 'normal');
  const session = await openSession(recorder, log, request, agentDir);

  const deadline = abortAfter(session, request.timeoutMs);
  const unsubscribe = session.subscribe((event) => observe(log, event));
  const release = onStop(() => void session.abort());
  try {
    await session.bindExtensions({});
    await session.prompt(request.prompt, { expandPromptTemplates: false });
    if (deadline.timedOut()) {
      throw new Error(`The ${request.name} agent did not finish in ${request.timeoutMs} ms.`);
    }
    const failure = lastFailure(session);
    if (failure !== undefined) {
      throw new Error(`The ${request.name} agent failed: ${failure}`);
    }
    return sessionResult(recorder, request, session, started);
  } finally {
    deadline.clear();
    release();
    unsubscribe();
    session.dispose();
  }
}

function abortAfter(
  session: AgentSession,
  timeoutMs: number | undefined,
): { timedOut: () => boolean; clear: () => void } {
  let timedOut = false;
  const timer =
    timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          void session.abort();
        }, timeoutMs);
  return { timedOut: () => timedOut, clear: () => clearTimeout(timer) };
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
  const ms = Date.now() - started;
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

async function openSession(
  recorder: Recorder,
  log: Recorder,
  request: AgentRequest,
  agentDir: string,
) {
  const runtime = request.runtime ?? {};
  const resourceLoader = await loadResources(request.cwd, agentDir);
  const modelRuntime =
    runtime.modelRuntime ??
    (await ModelRuntime.create({
      authPath: join(agentDir, 'auth.json'),
      modelsPath: join(agentDir, 'models.json'),
    }));
  const model =
    request.model === undefined ? undefined : await findModel(modelRuntime, request.model);
  const { session, modelFallbackMessage } = await createAgentSession({
    cwd: request.cwd,
    agentDir,
    resourceLoader,
    sessionManager: SessionManager.create(request.cwd, recorder.sessionDir),
    tools: request.profile.tools,
    modelRuntime,
    ...(runtime.settingsManager === undefined ? {} : { settingsManager: runtime.settingsManager }),
    ...(model === undefined ? {} : { model }),
  });
  if (modelFallbackMessage !== undefined) {
    log.event('agent.model', { note: modelFallbackMessage }, 'quiet');
  }
  return session;
}

async function loadResources(cwd: string, agentDir: string): Promise<DefaultResourceLoader> {
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    extensionsOverride: (base) => ({
      ...base,
      extensions: base.extensions.filter((extension) => !isOwnResource(extension.resolvedPath)),
    }),
    skillsOverride: (base) => ({
      ...base,
      skills: base.skills.filter((skill) => !isOwnResource(skill.filePath)),
    }),
  });
  await resourceLoader.reload();
  return resourceLoader;
}

async function findModel(modelRuntime: ModelRuntime, name: string) {
  const slash = name.indexOf('/');
  if (slash <= 0) {
    throw new Error(`The model ${name} is not in the form provider/model.`);
  }
  const found = modelRuntime.getModel(name.slice(0, slash), name.slice(slash + 1));
  if (found === undefined) {
    throw new Error(`The model ${name} is not known to pi.`);
  }
  return found;
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
