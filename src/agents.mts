import {
  createAgentSession,
  ModelRuntime,
  resolveCliModel,
  SessionManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

export type AgentRequest = {
  name: string;
  cwd: string;
  prompt: string;
  modelSpec?: string;
  tools: string[];
  customTools?: ToolDefinition<any, any>[];
};

const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];
const CODING_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];

export { CODING_TOOLS, READ_ONLY_TOOLS };

export async function createModelRuntime(): Promise<ModelRuntime> {
  return ModelRuntime.create();
}

export async function runAgent(modelRuntime: ModelRuntime, request: AgentRequest): Promise<string> {
  const resolved = request.modelSpec
    ? resolveCliModel({ cliModel: request.modelSpec, modelRuntime })
    : undefined;
  if (resolved?.error) {
    throw new Error(resolved.error);
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

  let text = "";
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "tool_execution_start") {
      process.stderr.write(`  [${request.name}] ${event.toolName}\n`);
    }
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      text += event.assistantMessageEvent.delta;
    }
  });

  try {
    await session.prompt(request.prompt);
  } finally {
    unsubscribe();
    session.dispose();
  }

  return lastAssistantText(session.messages) ?? text;
}

function lastAssistantText(messages: readonly unknown[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as { role?: string; content?: unknown };
    if (message.role !== "assistant" || !Array.isArray(message.content)) {
      continue;
    }
    const parts = message.content
      .filter((part: { type?: string }) => part.type === "text")
      .map((part: { text?: string }) => part.text ?? "");
    if (parts.length > 0) {
      return parts.join("\n").trim();
    }
  }
  return undefined;
}
