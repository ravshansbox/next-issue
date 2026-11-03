import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname, join } from 'node:path';
import WebSocket from 'ws';

export type RunStatus = 'running' | 'stopping' | 'finished' | 'stopped' | 'failed';

export type Handled = { issue: number; outcome: 'done' | 'needs-human' | 'error' };

export type IssueProgress = {
  issue: number;
  title?: string;
  stage?: string;
  tools: number;
  lastTool?: string;
  startedAt?: number;
};

export type Progress = {
  status: RunStatus;
  issues: IssueProgress[];
  handled: Handled[];
  open?: number;
  error?: string;
};

export type Question = {
  issue: number;
  title: string;
  reason: string;
  url: string;
  repo: string;
  pr?: number;
  labels: { needsHuman: string; skip: string };
};

export type ClientMessage =
  | { type: 'hello'; version: string }
  | { type: 'start'; root: string; merge: boolean }
  | { type: 'stop'; root: string }
  | { type: 'questions'; root: string; id?: string };

export type WorkerMessage =
  | { type: 'hello'; version: string }
  | { type: 'runs'; runs: Record<string, Progress> }
  | { type: 'questions'; root: string; questions: Question[]; id?: string }
  | { type: 'questions-error'; root: string; message: string; id?: string }
  | { type: 'error'; root: string; message: string };

export type WorkerEvent =
  | { type: 'runs'; runs: Record<string, Progress> }
  | { type: 'questions'; root: string; questions: Question[]; id?: string }
  | { type: 'questions-error'; root: string; message: string; id?: string }
  | { type: 'error'; root: string; message: string }
  | { type: 'closed' };

export type WorkerOptions = {
  socketPath: string;
  version: string;
  spawnWorker: (version: string) => void;
  startTimeoutMs?: number;
  reconnectMs?: number;
};

const START_TIMEOUT_MS = 120_000;
const RECONNECT_MS = 5_000;
const POLL_MS = 200;

export function isNewer(candidate: string, current: string): boolean {
  const [leftCore = '', ...leftRest] = candidate.replace(/\+.*$/, '').split('-');
  const [rightCore = '', ...rightRest] = current.replace(/\+.*$/, '').split('-');
  const left = leftCore.split('.').map(Number);
  const right = rightCore.split('.').map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) {
      return difference > 0;
    }
  }
  const leftPrerelease = leftRest.length > 0 ? leftRest.join('-').split('.') : [];
  const rightPrerelease = rightRest.length > 0 ? rightRest.join('-').split('.') : [];
  if (leftPrerelease.length === 0 || rightPrerelease.length === 0) {
    return leftPrerelease.length === 0 && rightPrerelease.length > 0;
  }
  for (let index = 0; index < Math.max(leftPrerelease.length, rightPrerelease.length); index += 1) {
    const leftPart = leftPrerelease[index];
    const rightPart = rightPrerelease[index];
    if (leftPart === undefined || rightPart === undefined) {
      return rightPart === undefined;
    }
    if (leftPart === rightPart) {
      continue;
    }
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) {
      return Number(leftPart) > Number(rightPart);
    }
    if (leftNumeric || rightNumeric) {
      return rightNumeric;
    }
    return leftPart > rightPart;
  }
  return false;
}

export function workerArgs(version: string): string[] {
  return ['-y', `next-issue@${version === '0.0.0' ? 'latest' : version}`, 'serve'];
}

export function workerPaths(root: string): { socketPath: string; logPath: string } {
  return {
    socketPath: join(root, '.next-issue', 'worker.sock'),
    logPath: join(root, '.next-issue', 'worker.log'),
  };
}

export function checkSocketPath(path: string, platform = process.platform): void {
  const size = platform === 'linux' ? 108 : 104;
  const length = Buffer.byteLength(path);
  if (length >= size) {
    throw new Error(
      `the socket path ${path} is too long for this system: ${length} bytes, at most ${size - 1}`,
    );
  }
}

export function spawnWorker(root: string, version: string): void {
  const { logPath } = workerPaths(root);
  mkdirSync(dirname(logPath), { recursive: true });
  const log = openSync(logPath, 'a');
  try {
    const child = spawn('npx', workerArgs(version), {
      cwd: root,
      detached: true,
      stdio: ['ignore', log, log],
    });
    child.on('error', () => {});
    child.unref();
  } finally {
    closeSync(log);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref?.());
}

export class WorkerClient {
  runs: Record<string, Progress> = {};
  questions: Record<string, Question[]> = {};
  private socket: WebSocket | undefined;
  private workerVersion: string | undefined;
  private connecting: Promise<void> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly listeners = new Set<(event: WorkerEvent) => void>();
  private readonly options: WorkerOptions;

  constructor(options: WorkerOptions) {
    this.options = options;
  }

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  subscribe(listener: (event: WorkerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  send(message: ClientMessage): void {
    this.socket?.send(JSON.stringify(message));
  }

  async attach(): Promise<void> {
    if (this.connected) {
      return;
    }
    await this.open().catch(() => this.scheduleReconnect());
  }

  async ensure(): Promise<void> {
    if (!this.connected) {
      this.connecting ??= this.start().finally(() => {
        this.connecting = undefined;
      });
      await this.connecting;
    }
    if (this.workerVersion !== undefined && isNewer(this.options.version, this.workerVersion)) {
      const busy = Object.values(this.runs).some(
        (run) => run.status === 'running' || run.status === 'stopping',
      );
      if (!busy) {
        await this.waitForClose();
        this.connecting ??= this.start().finally(() => {
          this.connecting = undefined;
        });
        await this.connecting;
      }
    }
  }

  close(): void {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.listeners.clear();
    const socket = this.socket;
    this.socket = undefined;
    socket?.terminate();
  }

  private async start(): Promise<void> {
    checkSocketPath(this.options.socketPath);
    try {
      await this.open();
      return;
    } catch {
      this.options.spawnWorker(this.options.version);
    }
    const deadline = Date.now() + (this.options.startTimeoutMs ?? START_TIMEOUT_MS);
    for (;;) {
      await delay(POLL_MS);
      try {
        await this.open();
        return;
      } catch (error) {
        if (Date.now() >= deadline) {
          throw new Error(
            `the next-issue worker did not start: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
  }

  private open(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws+unix://${this.options.socketPath}:/`);
      let hello = false;
      socket.once('error', (error) => {
        if (!hello) {
          reject(error);
        }
      });
      socket.on('message', (data) => {
        let message: WorkerMessage;
        try {
          message = JSON.parse(String(data)) as WorkerMessage;
        } catch {
          return;
        }
        if (message.type === 'hello') {
          this.workerVersion = message.version;
        } else if (message.type === 'runs') {
          this.runs = message.runs;
          this.emit({ type: 'runs', runs: message.runs });
          if (!hello) {
            hello = true;
            resolve();
          }
        } else if (message.type === 'questions') {
          this.questions[message.root] = message.questions;
          this.emit(message);
        } else if (message.type === 'error' || message.type === 'questions-error') {
          this.emit(message);
        }
      });
      socket.once('open', () => {
        this.socket = socket;
        socket.send(JSON.stringify({ type: 'hello', version: this.options.version }));
      });
      socket.once('close', () => {
        if (this.socket === socket) {
          this.socket = undefined;
          this.emit({ type: 'closed' });
          this.scheduleReconnect();
        }
        if (!hello) {
          reject(new Error('the worker closed the connection'));
        }
      });
    });
  }

  private waitForClose(): Promise<void> {
    const socket = this.socket;
    if (socket === undefined || socket.readyState === WebSocket.CLOSED) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, this.options.startTimeoutMs ?? START_TIMEOUT_MS);
      socket.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private scheduleReconnect(): void {
    if (this.listeners.size === 0 || this.reconnectTimer !== undefined) {
      return;
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (!this.connected && this.connecting === undefined) {
        void this.attach();
      }
    }, this.options.reconnectMs ?? RECONNECT_MS);
    this.reconnectTimer.unref?.();
  }

  private emit(event: WorkerEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}
