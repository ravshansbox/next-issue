import { createConnection } from 'node:net';
import WebSocket from 'ws';
import { errorText } from './errors.ts';
import {
  type ClientMessage,
  going,
  isNewer,
  type Progress,
  type Question,
  type WorkerMessage,
} from './protocol.ts';

export type WorkerEvent = Exclude<WorkerMessage, { type: 'hello' }> | { type: 'closed' };

export type WorkerOptions = {
  socketPath: string;
  version: string;
  spawnWorker: (version: string, onExit: (reason: string) => void) => void;
  lockHolder?: () => Promise<number | undefined>;
  startTimeoutMs?: number;
  holderGraceMs?: number;
  reconnectMs?: number;
};

const START_TIMEOUT_MS = 120_000;
const RECONNECT_MS = 5_000;
const POLL_MS = 200;
const HOLDER_GRACE_MS = 2_000;

export const CLOSED = 'the worker closed the connection';

function checkSocketPath(path: string, platform = process.platform): void {
  const size = platform === 'linux' ? 108 : 104;
  const length = Buffer.byteLength(path);
  if (length >= size) {
    throw new Error(
      `the socket path ${path} is too long for this system: ${length} bytes, at most ${size - 1}`,
    );
  }
}

// A `ws+unix://` URL percent-encodes the path and cuts it at `#`, `?` and `:`, so the socket
// is dialled by its real path and the URL only names the request.
function dial(socketPath: string): WebSocket {
  return new WebSocket('ws://localhost/', { createConnection: () => createConnection(socketPath) });
}

function parseMessage(text: string): WorkerMessage | undefined {
  try {
    return JSON.parse(text) as WorkerMessage;
  } catch {
    return undefined;
  }
}

function runGoing(pid: number): Error {
  return new Error(
    `a command-line next-issue run (process ${pid}) is going in this repository. Wait until it ends, or stop it, then try again`,
  );
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

  private get reconnectMs(): number {
    return this.options.reconnectMs ?? RECONNECT_MS;
  }

  private get busy(): boolean {
    return Object.values(this.runs).some(going);
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

  async reach(): Promise<void> {
    if (this.connected) {
      return;
    }
    checkSocketPath(this.options.socketPath);
    if (!(await this.opened())) {
      await this.waitForHolder();
    }
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
    this.connecting ??= this.start()
      .catch((error: unknown) => {
        this.scheduleReconnect();
        throw error;
      })
      .finally(() => {
        this.connecting = undefined;
      });
    return this.connecting;
  }

  private holder(): Promise<number | undefined> {
    return this.options.lockHolder?.() ?? Promise.resolve(undefined);
  }

  private async start(): Promise<void> {
    checkSocketPath(this.options.socketPath);
    if (await this.opened()) {
      return;
    }
    if (await this.waitForHolder()) {
      return;
    }
    let exited: string | undefined;
    this.options.spawnWorker(this.options.version, (reason) => {
      exited ??= reason;
    });
    await this.waitForStart(() => exited);
  }

  private async opened(): Promise<boolean> {
    try {
      await this.open();
      return true;
    } catch {
      return false;
    }
  }

  // A live process holds the lock but does not listen: a worker that is about to listen or
  // to close, or a command-line run, which holds the lock for its whole run.
  private async waitForHolder(): Promise<boolean> {
    const deadline = Date.now() + (this.options.holderGraceMs ?? HOLDER_GRACE_MS);
    for (;;) {
      const pid = await this.holder();
      if (pid === undefined) {
        return false;
      }
      if (Date.now() >= deadline) {
        throw runGoing(pid);
      }
      await delay(POLL_MS);
      if (await this.opened()) {
        return true;
      }
    }
  }

  private async waitForStart(exited: () => string | undefined): Promise<void> {
    const deadline = Date.now() + this.startTimeoutMs;
    for (;;) {
      await delay(POLL_MS);
      const reason = exited();
      try {
        await this.open();
        return;
      } catch (error) {
        if (reason !== undefined) {
          const pid = await this.holder();
          throw pid === undefined
            ? new Error(`the next-issue worker exited before it listened: ${reason}`)
            : runGoing(pid);
        }
        if (Date.now() >= deadline) {
          throw new Error(`the next-issue worker did not start: ${errorText(error)}`);
        }
      }
    }
  }

  private open(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = dial(this.options.socketPath);
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
        this.send({ type: 'hello', version: this.options.version });
      });
      socket.once('close', () => {
        this.release(socket);
        if (!hello) {
          reject(new Error(CLOSED));
        }
      });
    });
  }

  private release(socket: WebSocket): void {
    if (this.socket !== socket) {
      return;
    }
    this.socket = undefined;
    this.runs = {};
    this.questions = {};
    this.emit({ type: 'closed' });
    this.scheduleReconnect();
  }

  private receive(message: WorkerMessage): void {
    if (message.type === 'hello') {
      this.workerVersion = message.version;
    } else if (message.type === 'runs') {
      this.runs = message.runs;
      this.emit(message);
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
    }, this.reconnectMs);
    this.reconnectTimer.unref?.();
  }

  private emit(event: WorkerEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}
