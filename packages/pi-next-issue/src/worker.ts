import { randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';
import WebSocket from 'ws';
import { errorText } from './errors.ts';
import {
  type ClientMessage,
  going,
  isNewer,
  type Progress,
  type Question,
  type Upcoming,
  type WorkerMessage,
} from './protocol.ts';

export type WorkerEvent = Exclude<WorkerMessage, { type: 'hello' }> | { type: 'closed' };

export type Request = Extract<
  ClientMessage,
  { type: 'start' | 'stop' | 'hunt' | 'watch' | 'refresh' }
>;

export type WorkerOptions = {
  socketPath: string;
  version: string;
  spawnWorker: (version: string, onExit: (reason: string) => void) => void;
  lockHolder?: () => Promise<number | undefined>;
  startTimeoutMs?: number;
  holderGraceMs?: number;
  answerTimeoutMs?: number;
  reconnectMs?: number;
  upcomingWaitMs?: number;
};

const START_TIMEOUT_MS = 120_000;
const RECONNECT_MS = 5_000;
const POLL_MS = 200;
const HOLDER_GRACE_MS = 2_000;
const ANSWER_TIMEOUT_MS = 5_000;
const UPCOMING_WAIT_MS = 10_000;
const KEPT_REQUESTS = 16;

export const CLOSED = 'the worker closed the connection';
export const NOT_RUNNING = 'No worker is running, so pi cannot list the upcoming issues.';
export const OUTDATED_UPCOMING =
  'The worker did not answer: it is older than pi and needs an upgrade to list the upcoming issues.';

class SilentWorker extends Error {
  constructor() {
    super('the next-issue worker did not answer');
  }
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
  private readonly requests = new Map<string, { root: string; type: Request['type'] }>();
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

  get outdated(): boolean {
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

  request(message: Request): string {
    const id = randomUUID();
    this.requests.set(id, { root: message.root, type: message.type });
    if (this.requests.size > KEPT_REQUESTS) {
      this.requests.delete(this.requests.keys().next().value!);
    }
    this.send({ ...message, id });
    return id;
  }

  // An older worker names no request, so its error answers the last request of that root.
  requestOf(error: { root: string; id?: string }): Request['type'] {
    const named = error.id === undefined ? undefined : this.requests.get(error.id);
    const last = [...this.requests.values()].reverse().find(({ root }) => root === error.root);
    return (named ?? last)?.type ?? 'start';
  }

  // An older worker ignores the request, so it gets a time limit; a current one always answers.
  upcoming(root: string): Promise<Upcoming> {
    if (!this.connected) {
      return Promise.reject(new Error(NOT_RUNNING));
    }
    return new Promise((resolve, reject) => {
      const finish = (error: Error | undefined, upcoming?: Upcoming) => {
        clearTimeout(timer);
        stop();
        if (error === undefined) {
          resolve(upcoming!);
        } else {
          reject(error);
        }
      };
      const timer = this.outdated
        ? setTimeout(
            () => finish(new Error(OUTDATED_UPCOMING)),
            this.options.upcomingWaitMs ?? UPCOMING_WAIT_MS,
          )
        : undefined;
      const stop = this.subscribe((event) => {
        if (event.type === 'upcoming' && event.root === root) {
          finish(undefined, { claimable: event.claimable, blocked: event.blocked });
        } else if (event.type === 'upcoming-error' && event.root === root) {
          finish(new Error(`Could not list the upcoming issues: ${event.message}`));
        } else if (event.type === 'closed') {
          finish(new Error(`Could not list the upcoming issues: ${CLOSED}`));
        }
      });
      this.send({ type: 'upcoming', root });
    });
  }

  async attach(): Promise<void> {
    await this.share(() => this.open()).catch(() => this.scheduleReconnect());
  }

  reach(): Promise<void> {
    return this.share(async () => {
      checkSocketPath(this.options.socketPath);
      if (!(await this.opened())) {
        await this.waitForHolder();
      }
    });
  }

  async ensure(): Promise<void> {
    await this.connect();
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
    return this.share(() =>
      this.start().catch((error: unknown) => {
        this.scheduleReconnect();
        throw error;
      }),
    );
  }

  private async share(task: () => Promise<void>): Promise<void> {
    while (this.connecting !== undefined) {
      await this.connecting.catch(() => {});
    }
    if (this.connected) {
      return;
    }
    const connecting = task().finally(() => {
      this.connecting = undefined;
    });
    this.connecting = connecting;
    return connecting;
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
    } catch (error) {
      if (error instanceof SilentWorker) {
        throw error;
      }
      return false;
    }
  }

  // A live process holds the lock but does not listen: a worker that is about to listen or
  // to close.
  private async waitForHolder(): Promise<boolean> {
    const deadline = Date.now() + (this.options.holderGraceMs ?? HOLDER_GRACE_MS);
    for (;;) {
      if ((await this.holder()) === undefined || Date.now() >= deadline) {
        return false;
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
        if (error instanceof SilentWorker) {
          throw error;
        }
        if (reason !== undefined) {
          throw new Error(`the next-issue worker exited before it listened: ${reason}`);
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
      const timer = setTimeout(() => {
        reject(new SilentWorker());
        socket.terminate();
      }, this.options.answerTimeoutMs ?? ANSWER_TIMEOUT_MS);
      socket.on('error', (error) => {
        if (!hello) {
          clearTimeout(timer);
          reject(error);
        }
      });
      socket.on('message', (data) => {
        const message = parseMessage(String(data));
        if (message === undefined || (hello && this.socket !== socket)) {
          return;
        }
        if (message.type === 'runs' && !hello) {
          hello = true;
          clearTimeout(timer);
          const earlier = this.socket;
          this.socket = socket;
          earlier?.terminate();
          this.receive(message);
          resolve();
          return;
        }
        this.receive(message);
      });
      socket.once('open', () => {
        socket.send(JSON.stringify({ type: 'hello', version: this.options.version }));
      });
      socket.once('close', () => {
        clearTimeout(timer);
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
    const upgraded = this.outdated
      ? Object.entries(this.runs).filter(
          ([, progress]) => progress.upgrade !== undefined && progress.status !== 'failed',
        )
      : [];
    this.socket = undefined;
    this.requests.clear();
    this.runs = {};
    this.questions = {};
    this.emit({ type: 'closed' });
    if (upgraded.length > 0 && this.listeners.size > 0) {
      void this.resume(upgraded);
    } else {
      this.scheduleReconnect();
    }
  }

  private async resume(upgraded: [string, Progress][]): Promise<void> {
    try {
      await this.ensure();
    } catch (error) {
      for (const [root] of upgraded) {
        this.emit({ type: 'error', root, message: errorText(error) });
      }
      return;
    }
    for (const [root, progress] of upgraded) {
      if (!going(this.runs[root])) {
        const args = [
          '--watch',
          progress.watching === true ? 'on' : 'off',
          ...(progress.hunting ? ['--hunt', 'on'] : []),
        ];
        this.send({ type: 'start', root, args, resume: true });
      }
    }
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
    } else if (
      message.type === 'error' ||
      message.type === 'questions-error' ||
      message.type === 'upcoming' ||
      message.type === 'upcoming-error'
    ) {
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
