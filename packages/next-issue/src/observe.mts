import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { elapsedMs } from './durations.mts';
import { message } from './errors.mts';
import { render } from './render.mts';
import { runsDir } from './state.mts';
import {
  addUsage,
  countsSince,
  emptyRoleTotals,
  rolesSince,
  type RoleTotals,
  type Totals,
  type Usage,
} from './usage.mts';

export type Level = 'quiet' | 'normal' | 'verbose';

export type Fields = Record<string, unknown>;

const VISIBILITY: Record<Level, number> = { quiet: 0, normal: 1, verbose: 2 };

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

  private get runStem(): string {
    return this.sink.file.replace(/\.jsonl$/, '');
  }

  get sessionDir(): string {
    return join(this.runStem, 'sessions');
  }

  get summaryFile(): string {
    return `${this.runStem}.summary.json`;
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
      this.event(`${kind}.end`, { ...fields, ms: elapsedMs(started) });
      return result;
    } catch (error) {
      this.event(
        `${kind}.error`,
        { ...fields, ms: elapsedMs(started), error: message(error) },
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
