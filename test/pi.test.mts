import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test, type TestContext } from "node:test";
import { type AgentRequest, CODING, REVIEWING, runAgent } from "../src/agents.mts";
import { type Fields, Recorder } from "../src/observe.mts";

const FAKE = `#!/usr/bin/env node
const { readFileSync, writeFileSync } = require("node:fs");
const stdin = readFileSync(0, "utf8");
writeFileSync(process.env.FAKE_LOG, JSON.stringify({ args: process.argv.slice(2), stdin, cwd: process.cwd() }));
process.stdout.write(readFileSync(process.env.FAKE_EVENTS, "utf8"));
const code = Number(process.env.FAKE_CODE ?? "0");
const sleep = Number(process.env.FAKE_SLEEP ?? "0");
setTimeout(() => process.exit(code), sleep);
`;

type Call = { args: string[]; stdin: string; cwd: string };

type Fake = {
  dir: string;
  recorder: Recorder;
  call: () => Promise<Call>;
  records: () => Promise<Fields[]>;
};

async function fake(t: TestContext, events: unknown[], env: Record<string, string> = {}): Promise<Fake> {
  t.mock.method(process.stderr, "write", () => true);
  const dir = await mkdtemp(join(tmpdir(), "next-issue-pi-"));
  await writeFile(join(dir, "pi"), FAKE);
  await chmod(join(dir, "pi"), 0o755);
  await writeFile(join(dir, "events.jsonl"), events.map((event) => `${JSON.stringify(event)}\n`).join(""));
  const saved = { ...process.env };
  process.env.PATH = `${dir}${delimiter}${process.env.PATH}`;
  process.env.FAKE_LOG = join(dir, "call.json");
  process.env.FAKE_EVENTS = join(dir, "events.jsonl");
  Object.assign(process.env, env);
  t.after(() => {
    process.env = saved;
  });
  const recorder = await Recorder.create(dir, "quiet");
  return {
    dir,
    recorder,
    call: async () => JSON.parse(await readFile(join(dir, "call.json"), "utf8")) as Call,
    records: async () => {
      await recorder.close();
      return (await readFile(recorder.logFile, "utf8"))
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Fields);
    },
  };
}

function usage(input: number, output: number, cost: number): Record<string, unknown> {
  return {
    input,
    output,
    cacheRead: 1,
    cacheWrite: 2,
    totalTokens: input + output + 3,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
  };
}

function reply(content: unknown[], stopReason: string, extra: Record<string, unknown> = {}): unknown {
  return {
    type: "message_end",
    message: { role: "assistant", content, model: "m-1", usage: usage(10, 5, 0.25), stopReason, ...extra },
  };
}

const SESSION = { type: "session", version: 3, id: "s-1", cwd: "/x" };

const SETTLED = { type: "agent_settled", aborted: false };

const RUN = [
  SESSION,
  { type: "message_end", message: { role: "user", content: [{ type: "text", text: "do it" }] } },
  reply([{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "npm test" } }], "toolUse"),
  { type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "npm test" } },
  { type: "tool_execution_end", toolCallId: "c1", toolName: "bash", result: {}, isError: true },
  reply([{ type: "text", text: "commit: feat: add it" }], "stop"),
  { type: "agent_end", messages: [], willRetry: false },
  SETTLED,
];

function request(dir: string, extra: Partial<AgentRequest> = {}): AgentRequest {
  return { name: "implementer", cwd: dir, prompt: "do it", profile: CODING, agent: "pi", ...extra };
}

test("the pi agent gets the prompt on stdin and returns its final reply with the usage", async (t) => {
  const target = await fake(t, RUN);
  const result = await runAgent(target.recorder, request(target.dir));
  const call = await target.call();
  assert.equal(call.stdin, "do it");
  assert.deepEqual(call.args.slice(0, 2), ["--mode", "json"]);
  assert.equal(result.text, "commit: feat: add it");
  assert.equal(result.turns, 2);
  assert.equal(result.toolCalls, 1);
  assert.equal(result.costUsd, 0.5);
  assert.deepEqual(result.usage, { input: 20, output: 10, cacheRead: 2, cacheWrite: 4, total: 36 });
  assert.equal(result.model, "m-1");
  assert.equal(result.sessionId, "s-1");
});

test("the pi agent logs each tool call and each failed tool", async (t) => {
  const target = await fake(t, RUN);
  await runAgent(target.recorder, request(target.dir));
  const records = await target.records();
  const tool = records.find((record) => record.kind === "tool")!;
  assert.equal(tool.tool, "bash");
  assert.equal(tool.command, "npm test");
  assert.equal(records.find((record) => record.kind === "tool.error")!.tool, "bash");
  assert.equal(records.find((record) => record.kind === "usage")!.session, "s-1");
});

test("the pi implementer keeps the user's default tools and gets the configured model", async (t) => {
  const target = await fake(t, RUN);
  await runAgent(target.recorder, request(target.dir, { model: "sonnet" }));
  const { args } = await target.call();
  assert.equal(args.includes("--tools"), false);
  assert.deepEqual(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2), ["--model", "sonnet"]);
});

test("the pi reviewer runs without the edit and write tools", async (t) => {
  const target = await fake(t, RUN);
  await runAgent(target.recorder, request(target.dir, { name: "reviewer", profile: REVIEWING }));
  const { args } = await target.call();
  assert.deepEqual(args.slice(args.indexOf("--tools"), args.indexOf("--tools") + 2), ["--tools", "-edit,-write"]);
  assert.equal(args.includes("--model"), false);
});

test("the pi reviewer is asked for JSON and its reply becomes the structured result", async (t) => {
  const verdict = { summary: "ok", findings: [] };
  const target = await fake(t, [
    SESSION,
    reply([{ type: "text", text: `Here it is:\n\`\`\`json\n${JSON.stringify(verdict)}\n\`\`\`` }], "stop"),
    SETTLED,
  ]);
  const schema = { type: "object", required: ["summary"] };
  const result = await runAgent(target.recorder, request(target.dir, { outputSchema: schema }));
  assert.deepEqual(result.structured, verdict);
  const { stdin } = await target.call();
  assert.match(stdin, /^do it\n/);
  assert.match(stdin, /JSON/);
  assert.equal(stdin.includes(JSON.stringify(schema)), true);
});

test("a pi reviewer whose reply holds no JSON gives no structured result", async (t) => {
  const target = await fake(t, [SESSION, reply([{ type: "text", text: "looks fine" }], "stop"), SETTLED]);
  const result = await runAgent(target.recorder, request(target.dir, { outputSchema: { type: "object" } }));
  assert.equal(result.structured, undefined);
});

test("a pi reply that ends with an error fails the agent with its message", async (t) => {
  const target = await fake(t, [SESSION, reply([], "error", { errorMessage: "overloaded" }), SETTLED]);
  await assert.rejects(runAgent(target.recorder, request(target.dir)), /implementer agent failed: overloaded/);
});

test("a pi run that stops before it settles fails the agent", async (t) => {
  const target = await fake(t, [SESSION, reply([{ type: "text", text: "half" }], "stop")]);
  await assert.rejects(runAgent(target.recorder, request(target.dir)), /implementer agent failed/);
});

test("a pi process that exits with an error fails the agent", async (t) => {
  const target = await fake(t, RUN, { FAKE_CODE: "3" });
  await assert.rejects(runAgent(target.recorder, request(target.dir)), /implementer agent failed/);
});

test("a pi run that takes too long fails the agent with a timeout", async (t) => {
  const target = await fake(t, [SESSION], { FAKE_SLEEP: "5000" });
  await assert.rejects(
    runAgent(target.recorder, request(target.dir, { timeoutMs: 300 })),
    /did not finish in 300 ms/,
  );
});
