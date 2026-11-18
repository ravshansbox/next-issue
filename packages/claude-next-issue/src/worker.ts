import type { Host } from './host.ts';
import { isAlive, lockHolder } from './lock.ts';
import { workerPaths } from './paths.ts';
import {
  type ClientMessage,
  going,
  isNewer,
  type Launch,
  type Progress,
  type Question,
  type Upcoming,
  type WorkerMessage,
} from './protocol.ts';

export type WorkerOptions = {
  root: string;
  version: string;
  launch: Launch;
  host: Host;
  startTimeoutMs?: number;
  holderGraceMs?: number;
  pollMs?: number;
};

export const NOT_RUNNING = 'no worker is running';

const START_TIMEOUT_MS = 120_000;
const HOLDER_GRACE_MS = 2_000;
const POLL_MS = 200;

const LAUNCHER = [
  "const { spawn } = require('node:child_process');",
  "const { mkdirSync, openSync } = require('node:fs');",
  "const { dirname } = require('node:path');",
  'const [cwd, log, command, ...args] = process.argv.slice(1);',
  'mkdirSync(dirname(log), { recursive: true });',
  "const out = openSync(log, 'a');",
  "const child = spawn(command, args, { cwd, detached: true, stdio: ['ignore', out, out] });",
  "child.on('error', (error) => { process.stderr.write(error.message); process.exit(1); });",
  "child.on('spawn', () => { process.stdout.write(String(child.pid)); process.exit(0); });",
].join('\n');

function isMessages(value: unknown): value is WorkerMessage[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'object' && item !== null);
}

export function refusal(messages: WorkerMessage[]): string | undefined {
  const error = messages.find((message) => message.type === 'error');
  return error?.type === 'error' ? error.message : undefined;
}

export class WorkerClient {
  runs: Record<string, Progress> = {};
  questions: Question[] | undefined;
  connected = false;
  workerVersion: string | undefined;
  private readonly options: WorkerOptions;

  constructor(options: WorkerOptions) {
    this.options = options;
  }

  get root(): string {
    return this.options.root;
  }

  get progress(): Progress | undefined {
    return this.runs[this.options.root];
  }

  get outdated(): boolean {
    return this.workerVersion !== undefined && isNewer(this.options.version, this.workerVersion);
  }

  async poll(): Promise<boolean> {
    const fresh = !this.connected;
    try {
      await this.call('GET');
    } catch {
      return false;
    }
    if (fresh) {
      const { version, launch } = this.options;
      await this.send({ type: 'hello', version, launch }).catch(() => []);
    }
    return true;
  }

  send(message: ClientMessage): Promise<WorkerMessage[]> {
    return this.call('POST', JSON.stringify(message));
  }

  async askQuestions(): Promise<Question[] | undefined> {
    if (this.connected) {
      await this.send({ type: 'questions', root: this.root }).catch(() => []);
    }
    return this.questions;
  }

  async upcoming(): Promise<Upcoming> {
    if (!(await this.poll())) {
      throw new Error('No worker is running, so the upcoming issues cannot be listed.');
    }
    const messages = await this.send({ type: 'upcoming', root: this.root });
    for (const message of messages) {
      if (message.type === 'upcoming') {
        return { claimable: message.claimable, blocked: message.blocked };
      }
      if (message.type === 'upcoming-error') {
        throw new Error(`Could not list the upcoming issues: ${message.message}`);
      }
    }
    throw new Error(
      'The worker did not answer: it is older than this plugin and needs an upgrade to list the upcoming issues.',
    );
  }

  async reach(): Promise<void> {
    if (!(await this.poll())) {
      await this.waitForHolder();
    }
  }

  async ensure(): Promise<void> {
    await this.connect();
    if (this.outdated && !going(this.progress)) {
      await this.waitForClose();
      await this.connect();
    }
  }

  private async call(method: 'GET' | 'POST', body?: string): Promise<WorkerMessage[]> {
    const { socketPath } = workerPaths(this.options.root);
    let text: string;
    try {
      text = (await this.options.host.request(socketPath, method, body)).text;
    } catch {
      this.disconnect();
      throw new Error(NOT_RUNNING);
    }
    let messages: unknown;
    try {
      messages = JSON.parse(text);
    } catch {
      messages = undefined;
    }
    if (!isMessages(messages)) {
      throw new Error(
        `the worker answered with something other than messages: ${text.slice(0, 200)}`,
      );
    }
    this.connected = true;
    for (const message of messages) {
      this.receive(message);
    }
    return messages;
  }

  private receive(message: WorkerMessage): void {
    if (message.type === 'hello') {
      this.workerVersion = message.version;
    } else if (message.type === 'runs') {
      this.runs = message.runs;
    } else if (message.type === 'questions' && message.root === this.root) {
      this.questions = message.questions;
    }
  }

  private disconnect(): void {
    this.connected = false;
    this.runs = {};
    this.questions = undefined;
    this.workerVersion = undefined;
  }

  private async connect(): Promise<void> {
    if ((await this.poll()) || (await this.waitForHolder())) {
      return;
    }
    await this.waitForStart(await this.spawn());
  }

  private async waitForHolder(): Promise<boolean> {
    const { host, holderGraceMs = HOLDER_GRACE_MS, pollMs = POLL_MS } = this.options;
    const { lockPath } = workerPaths(this.options.root);
    const deadline = Date.now() + holderGraceMs;
    for (;;) {
      if ((await lockHolder(host, lockPath)) === undefined || Date.now() >= deadline) {
        return false;
      }
      await host.pause(pollMs);
      if (await this.poll()) {
        return true;
      }
    }
  }

  private async spawn(): Promise<number | undefined> {
    const { host, root, launch } = this.options;
    const { logPath } = workerPaths(root);
    const result = await host.run(
      ['node', '-e', LAUNCHER, root, logPath, launch.command, ...launch.args],
      { cwd: root },
    );
    if (result.exitCode !== 0) {
      throw new Error(`the next-issue worker could not start: ${result.stderr.trim()}`);
    }
    const pid = Number(result.stdout.trim());
    return pid > 0 ? pid : undefined;
  }

  private async waitForStart(pid: number | undefined): Promise<void> {
    const { host, startTimeoutMs = START_TIMEOUT_MS, pollMs = POLL_MS } = this.options;
    const deadline = Date.now() + startTimeoutMs;
    for (;;) {
      await host.pause(pollMs);
      if (await this.poll()) {
        return;
      }
      if (pid !== undefined && !(await isAlive(host, pid))) {
        throw new Error(
          'the next-issue worker exited before it listened (see .next-issue/worker.log)',
        );
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `the next-issue worker did not start in ${Math.round(startTimeoutMs / 1000)} s (see .next-issue/worker.log)`,
        );
      }
    }
  }

  private async waitForClose(): Promise<void> {
    const { host, startTimeoutMs = START_TIMEOUT_MS, pollMs = POLL_MS } = this.options;
    const deadline = Date.now() + startTimeoutMs;
    while (this.connected && Date.now() < deadline) {
      await host.pause(pollMs);
      await this.poll();
    }
  }
}
