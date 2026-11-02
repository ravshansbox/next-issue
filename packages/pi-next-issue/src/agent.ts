import { dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  getAgentDir,
  SessionManager,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import type { AgentTask, Verdict } from './runner.ts';

const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

export function isOwnExtension(path: string): boolean {
  return path === PACKAGE_DIR || path.startsWith(PACKAGE_DIR + sep);
}

export function toolLabel(name: string, args: unknown): string {
  const fields = (typeof args === 'object' && args !== null ? args : {}) as Record<string, unknown>;
  const detail = [fields['command'], fields['path'], fields['file_path'], fields['pattern']].find(
    (value) => typeof value === 'string',
  ) as string | undefined;
  const line = detail === undefined ? name : `${name} ${detail.split('\n')[0]}`;
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

async function runSession(task: AgentTask, customTools: ToolDefinition[]): Promise<string> {
  const agentDir = getAgentDir();
  const resourceLoader = new DefaultResourceLoader({
    cwd: task.cwd,
    agentDir,
    extensionsOverride: (base) => ({
      ...base,
      extensions: base.extensions.filter((extension) => !isOwnExtension(extension.resolvedPath)),
    }),
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd: task.cwd,
    agentDir,
    resourceLoader,
    sessionManager: SessionManager.inMemory(task.cwd),
    customTools,
  });
  const abort = () => void session.abort();
  task.signal.addEventListener('abort', abort);
  const unsubscribe = session.subscribe((event) => {
    if (event.type === 'tool_execution_start') {
      task.onTool(toolLabel(event.toolName, event.args));
    }
  });
  try {
    await session.bindExtensions({});
    task.signal.throwIfAborted();
    await session.prompt(task.prompt, { expandPromptTemplates: false });
    task.signal.throwIfAborted();
    const last = session.messages.findLast((message) => message.role === 'assistant');
    if (last !== undefined && 'stopReason' in last && last.stopReason === 'error') {
      throw new Error(`the agent failed: ${last.errorMessage ?? 'no reason given'}`);
    }
    return session.getLastAssistantText() ?? '';
  } finally {
    unsubscribe();
    task.signal.removeEventListener('abort', abort);
    session.dispose();
  }
}

export function work(task: AgentTask): Promise<string> {
  return runSession(task, []);
}

export async function review(task: AgentTask): Promise<Verdict | undefined> {
  let verdict: Verdict | undefined;
  const submit = defineTool({
    name: 'submit_verdict',
    label: 'Submit verdict',
    description: 'Give the result of the review. Call it once, as your last action.',
    parameters: Type.Object({
      summary: Type.String({ description: 'Short summary of the review' }),
      findings: Type.Array(
        Type.Object({
          severity: Type.Union([Type.Literal('blocking'), Type.Literal('minor')], {
            description:
              'blocking for a wrong result, a missing part of the issue, a regression or a broken convention; minor for taste and style',
          }),
          detail: Type.String({ description: 'What is wrong and where' }),
        }),
        { description: 'One entry per problem. Empty when nothing is wrong.' },
      ),
    }),
    async execute(_toolCallId, params) {
      verdict = { summary: params.summary, findings: params.findings };
      return {
        content: [{ type: 'text', text: 'Verdict saved.' }],
        details: verdict,
        terminate: true,
      };
    },
  });
  await runSession(task, [submit as unknown as ToolDefinition]);
  return verdict;
}
