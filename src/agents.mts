import {
  createAgentSession,
  ModelRuntime,
  resolveCliModel,
  SessionManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { emptyUsage, type Recorder, type Usage } from "./observe.mts";

export type AgentRequest = {
  name: string;
  cwd: string;
  prompt: string;
  modelSpec?: string;
  tools: string[];
  customTools?: ToolDefinition<any, any>[];
};

export type AgentResult = {
  text: string;
  usage: Usage;
  turns: number;
  toolCalls: number;
  ms: number;
  model?: string;
  sessionFile?: string;
};

const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];
const CODING_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];

export { CODING_TOOLS, READ_ONLY_TOOLS };

export async function createModelRuntime(): Promise<ModelRuntime> {
  return ModelRuntime.create();
}

export async function runAgent(
  modelRuntime: ModelRuntime,
  recorder: Recorder,
  request: AgentRequest,
): Promise<AgentResult> {
  const resolved = request.modelSpec
    ? resolveCliModel({ cliModel: request.modelSpec, modelRuntime })
    : undefined;
  if (resolved?.error) {
    throw new Error(resolved.error);
  }
  if (resolved?.warning) {
    recorder.event("model.warning", { role: request.name, warning: resolved.warning }, "quiet");
  }

  const { session } = await createAgentSession({
    cwd: request.cwd,
    model: resolved?.model,
    thinkingLevel: resolved?.thinkingLevel,
    modelRuntime,
    tools: [...request.tools, ...(request.customTools ?? []).map((tool) => tool.name)],
    customTools: request.customTools,
    sessionManager: SessionManager.create(request.cwd),
  });

  const log = recorder.scope({ role: request.name });
  let text = "";
  let toolCalls = 0;
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "tool_execution_start") {
      toolCalls += 1;
      log.event("tool", { tool: event.toolName });
    }
    if (event.type === "tool_execution_end" && event.isError) {
      log.event("tool.error", { tool: event.toolName }, "quiet");
    }
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      text += event.assistantMessageEvent.delta;
      if (log.level === "verbose") {
        process.stderr.write(event.assistantMessageEvent.delta);
      }
    }
  });

  const started = Date.now();
  const sessionFile = session.sessionFile;
  log.event("agent.start", { model: resolved?.model?.id, session: sessionFile }, "normal");
  try {
    await session.prompt(request.prompt);
  } finally {
    unsubscribe();
  }
  const ms = Date.now() - started;
  const stats = collect(session.messages);
  session.dispose();

  const result: AgentResult = {
    text: stats.text ?? text,
    usage: stats.usage,
    turns: stats.turns,
    toolCalls,
    ms,
    model: stats.model ?? resolved?.model?.id,
    sessionFile,
  };
  recorder.usage(request.name, result.usage, ms, {
    turns: result.turns,
    toolCalls: result.toolCalls,
    model: result.model,
    session: sessionFile,
  });
  return result;
}

type Stats = {
  usage: Usage;
  turns: number;
  text?: string;
  model?: string;
};

function collect(messages: readonly unknown[]): Stats {
  const usage = emptyUsage();
  let turns = 0;
  let text: string | undefined;
  let model: string | undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as {
      role?: string;
      model?: string;
      content?: unknown;
      usage?: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
        totalTokens: number;
        cost?: { total: number };
      };
    };
    if (message.role !== "assistant") {
      continue;
    }
    turns += 1;
    model ??= message.model;
    if (message.usage) {
      usage.input += message.usage.input;
      usage.output += message.usage.output;
      usage.cacheRead += message.usage.cacheRead;
      usage.cacheWrite += message.usage.cacheWrite;
      usage.total += message.usage.totalTokens;
      usage.costUsd += message.usage.cost?.total ?? 0;
    }
    if (text === undefined && Array.isArray(message.content)) {
      const parts = message.content
        .filter((part: { type?: string }) => part.type === "text")
        .map((part: { text?: string }) => part.text ?? "");
      if (parts.length > 0) {
        text = parts.join("\n").trim();
      }
    }
  }
  return { usage, turns, text, model };
}
