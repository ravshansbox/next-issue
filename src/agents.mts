import { type PermissionMode, query } from "@anthropic-ai/claude-agent-sdk";
import { emptyUsage, type Recorder, type Usage } from "./observe.mts";

export type Profile = {
  tools: string[];
  permissionMode: PermissionMode;
  allowDangerouslySkipPermissions?: boolean;
};

export type AgentRequest = {
  name: string;
  cwd: string;
  prompt: string;
  profile: Profile;
  model?: string;
  outputSchema?: Record<string, unknown>;
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
  structured?: unknown;
};

const READ_ONLY: Profile = {
  tools: ["Read", "Grep", "Glob"],
  permissionMode: "dontAsk",
};

const CODING: Profile = {
  tools: ["Read", "Write", "Edit", "Bash", "Grep", "Glob"],
  permissionMode: "bypassPermissions",
  allowDangerouslySkipPermissions: true,
};

export { CODING, READ_ONLY };

export async function runAgent(recorder: Recorder, request: AgentRequest): Promise<AgentResult> {
  const log = recorder.scope({ role: request.name });
  const usage = emptyUsage();
  const toolNames = new Map<string, string>();
  let text = "";
  let toolCalls = 0;
  let turns = 0;
  let costUsd = 0;
  let model = request.model;
  let sessionId: string | undefined;
  let structured: unknown;

  const started = Date.now();
  log.event("agent.start", { model: request.model }, "normal");
  const stream = query({
    prompt: request.prompt,
    options: {
      cwd: request.cwd,
      model: request.model,
      tools: request.profile.tools,
      allowedTools: request.profile.tools,
      permissionMode: request.profile.permissionMode,
      allowDangerouslySkipPermissions: request.profile.allowDangerouslySkipPermissions,
      systemPrompt: { type: "preset", preset: "claude_code" },
      outputFormat:
        request.outputSchema === undefined
          ? undefined
          : { type: "json_schema", schema: request.outputSchema },
    },
  });

  for await (const message of stream) {
    if (message.type === "assistant") {
      for (const block of message.message.content) {
        if (block.type === "tool_use") {
          toolCalls += 1;
          toolNames.set(block.id, block.name);
          log.event("tool", { tool: block.name });
        }
        if (block.type === "text") {
          text += block.text;
          if (log.level === "verbose") {
            process.stderr.write(block.text);
          }
        }
      }
    }
    if (message.type === "user" && Array.isArray(message.message.content)) {
      for (const block of message.message.content) {
        if (block.type === "tool_result" && block.is_error === true) {
          log.event("tool.error", { tool: toolNames.get(block.tool_use_id) }, "quiet");
        }
      }
    }
    if (message.type === "result") {
      sessionId = message.session_id;
      turns = message.num_turns;
      costUsd = message.total_cost_usd;
      model = main(message.modelUsage) ?? model;
      for (const entry of Object.values(message.modelUsage)) {
        usage.input += entry.inputTokens;
        usage.output += entry.outputTokens;
        usage.cacheRead += entry.cacheReadInputTokens;
        usage.cacheWrite += entry.cacheCreationInputTokens;
        usage.total +=
          entry.inputTokens +
          entry.outputTokens +
          entry.cacheReadInputTokens +
          entry.cacheCreationInputTokens;
      }
      if (message.subtype === "error_during_execution") {
        throw new Error(`The ${request.name} agent failed: ${message.errors.join("; ")}`);
      }
      if (message.subtype === "success") {
        text = message.result.length > 0 ? message.result : text;
        structured = message.structured_output;
      } else {
        log.event("agent.incomplete", { subtype: message.subtype }, "quiet");
      }
    }
  }

  const ms = Date.now() - started;
  recorder.usage(request.name, usage, ms, {
    turns,
    toolCalls,
    model,
    session: sessionId,
    costUsd,
  });
  return {
    text: text.trim(),
    usage,
    turns,
    toolCalls,
    ms,
    costUsd,
    model,
    sessionId,
    structured,
  };
}

function main(models: Record<string, { outputTokens: number }>): string | undefined {
  let name: string | undefined;
  let output = -1;
  for (const [id, entry] of Object.entries(models)) {
    if (entry.outputTokens > output) {
      output = entry.outputTokens;
      name = id;
    }
  }
  return name;
}
