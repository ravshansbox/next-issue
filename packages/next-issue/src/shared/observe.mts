import { createWriteStream } from 'node:fs';
import type { Writable } from 'node:stream';
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

export type Fields = Record<string, unknown>;

class Sink {
  readonly totals = new Map<string, RoleTotals>();
  readonly counts = new Map<string, number>();
  private readonly stream: Writable;
  readonly file: string;
  private readonly listener: ((record: Fields) => void) | undefined;
  readonly output: (text: string) => void;
  private failed = false;

  constructor(
    stream: Writable,
    file: string,
    listener: ((record: Fields) => void) | undefined,
    output: (text: string) => void,
  ) {
    this.stream = stream;
    this.output = output;
    this.file = file;
    this.listener = listener;
    stream.on('error', (error) => this.fail(error));
  }

  private fail(error: unknown): void {
    if (this.failed) {
      return;
    }
    this.failed = true;
    this.output(
      `the run log ${this.file} cannot be written (${message(error)}); the run goes on without it\n`,
    );
  }

  write(record: Fields): void {
    if (!this.failed) {
      this.stream.write(`${JSON.stringify(record)}\n`);
    }
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
    return new Promise((resolve) => {
      if (this.stream.closed) {
        resolve();
        return;
      }
      this.stream.once('close', () => resolve());
      this.stream.end();
    });
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
    listener?: (record: Fields) => void,
    open: (file: string) => Writable = (file) => createWriteStream(file, { flags: 'a' }),
    output: (text: string) => void = (text) => process.stderr.write(text),
  ): Promise<Recorder> {
    const runId = new Date().toISOString().replace(/[:.]/g, '-');
    const dir = runsDir(root);
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${runId}.jsonl`);
    const sink = new Sink(open(file), file, listener, output);
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

  scope(fields: Fields): Recorder {
    return new Recorder(this.sink, { ...this.base, ...fields }, this.runId);
  }

  event(kind: string, fields: Fields = {}): void {
    this.sink.output(render(this.record(kind, fields)));
  }

  record(kind: string, fields: Fields = {}): Fields {
    this.sink.count(kind);
    const record = {
      ts: new Date().toISOString(),
      runId: this.runId,
      kind,
      ...this.base,
      ...fields,
    };
    this.sink.write(record);
    return record;
  }

  print(text: string): void {
    this.sink.output(text);
  }

  usage(role: string, usage: Usage, ms: number, fields: Fields = {}): void {
    this.sink.add(role, usage, ms);
    this.event('usage', { role, ms, ...usage, ...fields });
  }

  async step<T>(kind: string, fields: Fields, run: () => Promise<T>): Promise<T> {
    const started = Date.now();
    this.record(`${kind}.start`, fields);
    try {
      const result = await run();
      this.event(`${kind}.end`, { ...fields, ms: elapsedMs(started) });
      return result;
    } catch (error) {
      this.event(`${kind}.error`, { ...fields, ms: elapsedMs(started), error: message(error) });
      throw error;
    }
  }

  summary(since?: Totals): Totals & { runId: string; logFile: string } {
    return {
      runId: this.runId,
      logFile: this.logFile,
      ...rolesSince(this.sink.totals, since),
      counts: countsSince(this.sink.counts, since),
    };
  }

  async close(): Promise<void> {
    await this.sink.close();
  }
}
