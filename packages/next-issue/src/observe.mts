import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { stateDir } from './state.mts';

export type Level = 'quiet' | 'normal' | 'verbose';

export type Fields = Record<string, unknown>;

export type Usage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
};

export type RoleTotals = Usage & {
  calls: number;
  ms: number;
};

export type Totals = {
  roles: Record<string, RoleTotals>;
  counts: Record<string, number>;
  total: Usage;
};

const VISIBILITY: Record<Level, number> = { quiet: 0, normal: 1, verbose: 2 };

export function runsDir(root: string): string {
  return join(stateDir(root), 'runs');
}

export function emptyUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
}

export function addUsage(target: Usage, source: Usage): void {
  target.input += source.input;
  target.output += source.output;
  target.cacheRead += source.cacheRead;
  target.cacheWrite += source.cacheWrite;
  target.total += source.total;
}

function emptyRoleTotals(): RoleTotals {
  return { ...emptyUsage(), calls: 0, ms: 0 };
}

function negate(usage: Usage): Usage {
  return {
    input: -usage.input,
    output: -usage.output,
    cacheRead: -usage.cacheRead,
    cacheWrite: -usage.cacheWrite,
    total: -usage.total,
  };
}

class Sink {
  readonly totals = new Map<string, RoleTotals>();
  readonly counts = new Map<string, number>();
  private readonly stream: WriteStream;
  readonly level: Level;
  readonly file: string;
  private readonly listener: ((record: Fields) => void) | undefined;

  constructor(
    stream: WriteStream,
    level: Level,
    file: string,
    listener?: (record: Fields) => void,
  ) {
    this.stream = stream;
    this.level = level;
    this.file = file;
    this.listener = listener;
  }

  write(record: Fields): void {
    this.stream.write(`${JSON.stringify(record)}\n`);
    this.listener?.(record);
  }

  count(kind: string): void {
    this.counts.set(kind, (this.counts.get(kind) ?? 0) + 1);
  }

  add(role: string, usage: Usage, ms: number): void {
    const current = this.totals.get(role) ?? emptyRoleTotals();
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

  static async create(
    root: string,
    level: Level,
    listener?: (record: Fields) => void,
  ): Promise<Recorder> {
    const runId = new Date().toISOString().replace(/[:.]/g, '-');
    const dir = runsDir(root);
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${runId}.jsonl`);
    const sink = new Sink(createWriteStream(file, { flags: 'a' }), level, file, listener);
    return new Recorder(sink, {}, runId);
  }

  get logFile(): string {
    return this.sink.file;
  }

  get sessionDir(): string {
    return join(this.sink.file.replace(/\.jsonl$/, ''), 'sessions');
  }

  get level(): Level {
    return this.sink.level;
  }

  scope(fields: Fields): Recorder {
    return new Recorder(this.sink, { ...this.base, ...fields }, this.runId);
  }

  event(kind: string, fields: Fields = {}, visibility: Level = 'normal'): void {
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
    this.event('usage', { role, ms, ...usage, ...fields }, 'normal');
  }

  async step<T>(kind: string, fields: Fields, run: () => Promise<T>): Promise<T> {
    const started = Date.now();
    this.event(`${kind}.start`, fields, 'verbose');
    try {
      const result = await run();
      this.event(`${kind}.end`, { ...fields, ms: Date.now() - started });
      return result;
    } catch (error) {
      this.event(
        `${kind}.error`,
        { ...fields, ms: Date.now() - started, error: message(error) },
        'quiet',
      );
      throw error;
    }
  }

  summary(since?: Totals): Totals & { runId: string; logFile: string } {
    return {
      runId: this.runId,
      logFile: this.sink.file,
      ...rolesSince(this.sink.totals, since),
      counts: countsSince(this.sink.counts, since),
    };
  }

  async close(): Promise<void> {
    await this.sink.close();
  }
}

function rolesSince(
  totals: Map<string, RoleTotals>,
  since?: Totals,
): { roles: Record<string, RoleTotals>; total: Usage } {
  const total = emptyUsage();
  const roles: Record<string, RoleTotals> = {};
  for (const [role, value] of totals) {
    const earlier = since?.roles[role] ?? emptyRoleTotals();
    if (value.calls === earlier.calls) {
      continue;
    }
    const usage = { ...value, calls: value.calls - earlier.calls, ms: value.ms - earlier.ms };
    addUsage(usage, negate(earlier));
    roles[role] = usage;
    addUsage(total, usage);
  }
  return { roles, total };
}

function countsSince(counts: Map<string, number>, since?: Totals): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [kind, value] of counts) {
    const count = value - (since?.counts[kind] ?? 0);
    if (count > 0) {
      result[kind] = count;
    }
  }
  return result;
}

export async function pruneRuns(root: string, keepDays: number): Promise<number> {
  if (keepDays <= 0) {
    return 0;
  }
  const dir = runsDir(root);
  const names = await readdir(dir).catch(() => []);
  const cutoff = Date.now() - keepDays * 24 * 60 * 60_000;
  let dropped = 0;
  for (const name of names) {
    if (await dropIfOlder(join(dir, name), cutoff)) {
      dropped += 1;
    }
  }
  return dropped;
}

async function dropIfOlder(path: string, cutoff: number): Promise<boolean> {
  try {
    const info = await stat(path);
    if (info.mtimeMs >= cutoff) {
      return false;
    }
    await rm(path, { force: true, recursive: true });
    return true;
  } catch {
    return false;
  }
}

export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function hasCode(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException).code === code;
}

export function render(record: Fields): string {
  const time = new Date(String(record.ts)).toTimeString().slice(0, 8);
  const issue = record.issue === undefined ? '' : ` #${record.issue}`;
  const extras = Object.entries(record)
    .filter(([key]) => !['ts', 'runId', 'kind', 'issue'].includes(key))
    .map(([key, value]) => `${key}=${short(value)}`)
    .join(' ');
  return `${time}${issue} ${String(record.kind)}${extras.length > 0 ? ` ${extras}` : ''}\n`;
}

function short(value: unknown): string {
  if (value === undefined || value === null) {
    return '-';
  }
  if (typeof value === 'number') {
    return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(6)));
  }
  const text = String(value).replace(/\s+/g, ' ');
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}
