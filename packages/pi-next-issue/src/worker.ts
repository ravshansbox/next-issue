import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname, join } from 'node:path';
import WebSocket from 'ws';
import { errorText } from './exec.ts';
import {
  type ClientMessage,
  isNewer,
  type Progress,
  type Question,
  type WorkerMessage,
} from './protocol.ts';

export type WorkerEvent = Exclude<WorkerMessage, { type: 'hello' }> | { type: 'closed' };

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

export function workerArgs(version: string): string[] {
  return ['-y', `next-issue@${version === '0.0.0' ? 'latest' : version}`, 'serve'];
}

export function workerPaths(root: string): { socketPath: string; logPath: string } {
  return {
    socketPath: join(root, '.next-issue', 'worker.sock'),
    logPath: join(root, '.next-issue', 'worker.log'),
  };
}

function checkSocketPath(path: string, platform = process.platform): void {
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

function parseMessage(text: string): WorkerMessage | undefined {
  try {
    return JSON.parse(text) as WorkerMessage;
  } catch {
    return undefined;
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

  private get startTimeoutMs(): number {
    return this.options.startTimeoutMs ?? START_TIMEOUT_MS;
  }

  private get busy(): boolean {
    return Object.values(this.runs).some(
      (run) => run.status === 'running' || run.status === 'stopping',
    );
  }

  private get outdated(): boolean {
    return this.workerVersion !== undefined && isNewer(this.options.version, this.workerVersion);
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
      await this.connect();
    }
    if (this.outdated && !this.busy) {
      await this.waitForClose();
      await this.connect();
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

  private connect(): Promise<void> {
    this.connecting ??= this.start().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  private async start(): Promise<void> {
    checkSocketPath(this.options.socketPath);
    try {
      await this.open();
      return;
    } catch {
      this.options.spawnWorker(this.options.version);
    }
    await this.waitForStart();
  }

  private async waitForStart(): Promise<void> {
    const deadline = Date.now() + this.startTimeoutMs;
    for (;;) {
      await delay(POLL_MS);
      try {
        await this.open();
        return;
      } catch (error) {
        if (Date.now() >= deadline) {
          throw new Error(`the next-issue worker did not start: ${errorText(error)}`);
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
        const message = parseMessage(String(data));
        if (message === undefined) {
          return;
        }
        this.receive(message);
        if (message.type === 'runs' && !hello) {
          hello = true;
          resolve();
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

  private receive(message: WorkerMessage): void {
    if (message.type === 'hello') {
      this.workerVersion = message.version;
    } else if (message.type === 'runs') {
      this.runs = message.runs;
      this.emit({ type: 'runs', runs: message.runs });
    } else if (message.type === 'questions') {
      this.questions[message.root] = message.questions;
      this.emit(message);
    } else if (message.type === 'error' || message.type === 'questions-error') {
      this.emit(message);
    }
  }

  private waitForClose(): Promise<void> {
    const socket = this.socket;
    if (socket === undefined || socket.readyState === WebSocket.CLOSED) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, this.startTimeoutMs);
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
