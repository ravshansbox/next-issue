import { type AgentRequest, type AgentResult, toolFields } from "./agents.mts";
import { run } from "./exec.mts";
import { emptyUsage, type Recorder } from "./observe.mts";

type PiUsage = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: { total?: number };
};

type PiMessage = {
  role?: string;
  content?: unknown;
  model?: string;
  usage?: PiUsage;
  stopReason?: string;
  errorMessage?: string;
};

type PiEvent = {
  type?: string;
  id?: string;
  message?: PiMessage;
  toolName?: string;
  args?: unknown;
  isError?: boolean;
};

const NO_LIMIT = 2 ** 31 - 1;

const OUTPUT_TAIL = 200_000;

export async function runPi(recorder: Recorder, request: AgentRequest): Promise<AgentResult> {
  const log = recorder.scope({ role: request.name });
  const usage = emptyUsage();
  let text = "";
  let toolCalls = 0;
  let turns = 0;
  let costUsd = 0;
  let model = request.model;
  let sessionId: string | undefined;
  let settled = false;
  let last: PiMessage | undefined;

  const read = (line: string): void => {
    let event: PiEvent;
    try {
      event = JSON.parse(line) as PiEvent;
    } catch {
      return;
    }
    if (event.type === "session") {
      sessionId = event.id;
    } else if (event.type === "message_end" && event.message?.role === "assistant") {
      const message = event.message;
      last = message;
      turns += 1;
      model = message.model ?? model;
      const input = message.usage?.input ?? 0;
      const output = message.usage?.output ?? 0;
      const cacheRead = message.usage?.cacheRead ?? 0;
      const cacheWrite = message.usage?.cacheWrite ?? 0;
      usage.input += input;
      usage.output += output;
      usage.cacheRead += cacheRead;
      usage.cacheWrite += cacheWrite;
      usage.total += input + output + cacheRead + cacheWrite;
      costUsd += message.usage?.cost?.total ?? 0;
      const said = textOf(message.content);
      if (said.length > 0) {
        text = said;
        if (log.level === "verbose") {
          process.stderr.write(said);
        }
      }
    } else if (event.type === "tool_execution_start") {
      toolCalls += 1;
      log.event("tool", toolFields(event.toolName ?? "unknown", event.args));
    } else if (event.type === "tool_execution_end" && event.isError === true) {
      log.event("tool.error", { tool: event.toolName }, "quiet");
    } else if (event.type === "agent_settled") {
      settled = true;
    }
  };

  const started = Date.now();
  log.event("agent.start", { model: request.model, timeoutMs: request.timeoutMs, agent: "pi" }, "normal");
  let rest = "";
  const result = await run("pi", piArgs(request), {
    cwd: request.cwd,
    input: piPrompt(request),
    timeoutMs: request.timeoutMs ?? NO_LIMIT,
    tailChars: OUTPUT_TAIL,
    onStdout: (chunk) => {
      rest += chunk;
      let end = rest.indexOf("\n");
      while (end !== -1) {
        read(rest.slice(0, end).replace(/\r$/, ""));
        rest = rest.slice(end + 1);
        end = rest.indexOf("\n");
      }
    },
  });
  if (rest.length > 0) {
    read(rest);
  }

  const failed = (reason: string): Error => new Error(`The ${request.name} agent failed: ${reason}`);
  if (result.timedOut) {
    throw new Error(`The ${request.name} agent did not finish in ${request.timeoutMs} ms.`);
  }
  if (last?.stopReason === "error" || last?.stopReason === "aborted") {
    throw failed(last.errorMessage ?? last.stopReason);
  }
  if (result.code !== 0) {
    throw failed(`pi exited with code ${result.code}: ${result.stderr.trim()}`);
  }
  if (!settled) {
    throw failed("pi stopped before the run settled");
  }
  if (last?.stopReason === "length") {
    log.event("agent.incomplete", { subtype: "length" }, "quiet");
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
    structured: request.outputSchema === undefined ? undefined : jsonOf(text),
  };
}

function piArgs(request: AgentRequest): string[] {
  return [
    "--mode",
    "json",
    ...(request.model === undefined ? [] : ["--model", request.model]),
    ...(request.profile.piTools === undefined ? [] : ["--tools", request.profile.piTools]),
  ];
}

function piPrompt(request: AgentRequest): string {
  if (request.outputSchema === undefined) {
    return request.prompt;
  }
  return [
    request.prompt,
    "",
    "End your reply with only a JSON object in a json code block. The object must match this JSON schema:",
    JSON.stringify(request.outputSchema),
  ].join("\n");
}

function textOf(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .filter((block): block is { type: "text"; text: string } => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

function jsonOf(text: string): unknown {
  const fenced = [...text.matchAll(/```(?:json)?[ \t]*\n([\s\S]*?)```/g)].at(-1)?.[1];
  const candidate = fenced ?? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  try {
    return JSON.parse(candidate);
  } catch {
    return undefined;
  }
}
