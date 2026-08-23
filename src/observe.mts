import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

export type Level = "quiet" | "normal" | "verbose";

export type Fields = Record<string, unknown>;

export type Usage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  costUsd: number;
};

export type RoleTotals = Usage & {
  calls: number;
  ms: number;
};

const VISIBILITY: Record<Level, number> = { quiet: 0, normal: 1, verbose: 2 };

export function emptyUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, costUsd: 0 };
}

export function addUsage(target: Usage, source: Usage): void {
  target.input += source.input;
  target.output += source.output;
  target.cacheRead += source.cacheRead;
  target.cacheWrite += source.cacheWrite;
  target.total += source.total;
  target.costUsd += source.costUsd;
}

class Sink {
  readonly totals = new Map<string, RoleTotals>();
  readonly counts = new Map<string, number>();
  private readonly stream: WriteStream;
  readonly level: Level;
  readonly file: string;

  constructor(stream: WriteStream, level: Level, file: string) {
    this.stream = stream;
    this.level = level;
    this.file = file;
  }

  write(record: Fields): void {
    this.stream.write(`${JSON.stringify(record)}\n`);
  }

  count(kind: string): void {
    this.counts.set(kind, (this.counts.get(kind) ?? 0) + 1);
  }

  add(role: string, usage: Usage, ms: number): void {
    const current = this.totals.get(role) ?? { ...emptyUsage(), calls: 0, ms: 0 };
    addUsage(current, usage);
    current.calls += 1;
    current.ms += ms;
    this.totals.set(role, current);
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.stream.end(resolve));
  }
}

export class Recorder {
  private readonly sink: Sink;
  private readonly base: Fields;
  readonly runId: string;

  private constructor(sink: Sink, base: Fields, runId: string) {
    this.sink = sink;
    this.base = base;
    this.runId = runId;
  }

  static async create(root: string, level: Level): Promise<Recorder> {
    const runId = new Date().toISOString().replace(/[:.]/g, "-");
    const dir = join(root, ".next-issue", "runs");
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${runId}.jsonl`);
    const sink = new Sink(createWriteStream(file, { flags: "a" }), level, file);
    return new Recorder(sink, {}, runId);
  }

  get logFile(): string {
    return this.sink.file;
  }

  get level(): Level {
    return this.sink.level;
  }

  scope(fields: Fields): Recorder {
    return new Recorder(this.sink, { ...this.base, ...fields }, this.runId);
  }

  event(kind: string, fields: Fields = {}, visibility: Level = "normal"): void {
    this.sink.count(kind);
    const record = {
      ts: new Date().toISOString(),
      runId: this.runId,
      kind,
      ...this.base,
      ...fields,
    };
    this.sink.write(record);
    if (VISIBILITY[this.sink.level] >= VISIBILITY[visibility]) {
      process.stderr.write(render(record));
    }
  }

  usage(role: string, usage: Usage, ms: number, fields: Fields = {}): void {
    this.sink.add(role, usage, ms);
    this.event("usage", { role, ms, ...usage, ...fields }, "normal");
  }

  async step<T>(kind: string, fields: Fields, run: () => Promise<T>): Promise<T> {
    const started = Date.now();
    this.event(`${kind}.start`, fields, "verbose");
    try {
      const result = await run();
      this.event(`${kind}.end`, { ...fields, ms: Date.now() - started });
      return result;
    } catch (error) {
      this.event(
        `${kind}.error`,
        { ...fields, ms: Date.now() - started, error: message(error) },
        "quiet",
      );
      throw error;
    }
  }

  summary(): { runId: string; logFile: string; roles: Record<string, RoleTotals>; counts: Record<string, number>; total: Usage } {
    const total = emptyUsage();
    const roles: Record<string, RoleTotals> = {};
    for (const [role, value] of this.sink.totals) {
      roles[role] = value;
      addUsage(total, value);
    }
    return {
      runId: this.runId,
      logFile: this.sink.file,
      roles,
      counts: Object.fromEntries(this.sink.counts),
      total,
    };
  }

  async close(): Promise<void> {
    await this.sink.close();
  }
}

export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function render(record: Fields): string {
  const time = String(record.ts).slice(11, 19);
  const issue = record.issue === undefined ? "" : ` #${record.issue}`;
  const extras = Object.entries(record)
    .filter(([key]) => !["ts", "runId", "kind", "issue"].includes(key))
    .map(([key, value]) => `${key}=${short(value)}`)
    .join(" ");
  return `${time}${issue} ${String(record.kind)}${extras.length > 0 ? ` ${extras}` : ""}\n`;
}

function short(value: unknown): string {
  if (value === undefined || value === null) {
    return "-";
  }
  if (typeof value === "number") {
    return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(6)));
  }
  const text = String(value).replace(/\s+/g, " ");
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}
