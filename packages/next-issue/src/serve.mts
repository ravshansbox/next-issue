import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdir, rename, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { basename, dirname, join } from 'node:path';
import { WebSocketServer } from 'ws';
import { type Args, parseStartArgs } from './args.mts';
import { stopChildren, withRunChildren } from './children.mts';
import { message } from './errors.mts';
import { lock } from './lock.mts';
import { startProgress } from './progress.mts';
import {
  type ClientMessage,
  isNewer,
  type Launch,
  type Progress,
  type WorkerMessage,
} from './protocol.mts';
import {
  type ListQuestions,
  listQuestions,
  type Peer,
  questionSender,
  send,
} from './questions.mts';
import { runRepo, type RunControls } from './run.mts';
import type { RunSummary } from './summary.mts';
import { type ListUpcoming, listUpcoming, sendUpcoming } from './upcoming.mts';
import { packageVersion } from './version.mts';
import { resumeOnSuccessor } from './worker-client.mts';
import { keepLogTrimmed, LOG_CHECK_MS } from './worker-log.mts';
import { checkSocketPath, workerPaths } from './worker-paths.mts';
import {
  active,
  dropUpgrade,
  endStatus,
  newRun,
  requestRefresh,
  requestStop,
  requestUpgrade,
  type Run,
  runControls,
  runsMessage,
  setHunting,
  setWatching,
  startRefusal,
  stoppingMessage,
  stopPoint,
  switchRefusal,
} from './worker-run.mts';
import {
  broadcast,
  closer,
  fileId,
  isLaunch,
  listen,
  type Owned,
  parseMessage,
  readBody,
  removeOwned,
  reply,
  sendAll,
  shutdown,
  stopListening,
  type Worker,
} from './worker-server.mts';

export type RunRepo = (root: string, args: Args, controls: RunControls) => Promise<number>;

type WorkerOptions = {
  root: string;
  socketPath: string;
  lockPath: string;
  version: string;
  runRepo: RunRepo;
  questions: ListQuestions;
  upcoming?: ListUpcoming;
  lockWaitMs?: number;
  idleMs?: number;
};

const LOCK_WAIT_MS = 5_000;
const IDLE_MS = 30_000;

export async function startWorker(options: WorkerOptions): Promise<Worker | undefined> {
  checkSocketPath(options.socketPath);
  await mkdir(dirname(options.lockPath), { recursive: true });
  const held = await lock(options.lockPath, options.lockWaitMs ?? LOCK_WAIT_MS);
  if (held === undefined) {
    return undefined;
  }
  const owned: Owned = {
    socketPath: options.socketPath,
    lockPath: options.lockPath,
    lock: held,
    socket: '',
  };
  const runs = new Map<string, Run>();
  let restart: string | undefined;
  let successor: Launch | undefined;

  const server = createServer();
  const sockets = new WebSocketServer({ server });
  const sendQuestions = questionSender(options.questions);
  // Taken outside any run, so a question read that an issue end starts does not take on
  // the run's stop, command log, children or default timeout.
  const outsideRuns = AsyncLocalStorage.snapshot();
  const busy = (): boolean => [...runs.values()].some(active);

  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const idleMs = options.idleMs ?? IDLE_MS;
  let polledAt = Number.NEGATIVE_INFINITY;
  const polled = (): boolean => Date.now() - polledAt < idleMs;
  const handOver = async (how: Launch, run: Run): Promise<void> => {
    const listening = stopListening(server);
    removeOwned(owned);
    try {
      await resumeOnSuccessor(options.root, how, resumeArgs(run));
    } catch (error) {
      const reason = `the worker could not start next-issue ${restart}: ${message(error)}`;
      process.stderr.write(`next-issue: ${reason}\n`);
      run.progress = { ...run.progress, status: 'failed', error: reason };
      broadcast(sockets, runs);
    }
    await shutdown(server, sockets, owned, listening);
  };

  const { closed, close } = closer(async () => {
    clearTimeout(idleTimer);
    const run = runs.get(options.root);
    if (successor !== undefined && run !== undefined && upgradedRun(run)) {
      await handOver(successor, run);
    } else {
      await shutdown(server, sockets, owned);
    }
  });
  const closeWhenIdle = (): void => {
    if ((restart !== undefined || (sockets.clients.size === 0 && !polled())) && !busy()) {
      void close();
    }
  };

  const upgradeBetweenIssues = (run: Run): void => {
    if (restart === undefined) {
      return;
    }
    const upgrade = {
      from: options.version,
      to: restart,
      ...(successor === undefined ? {} : { resumes: true }),
    };
    if (requestUpgrade(run, upgrade)) {
      broadcast(sockets, runs);
    }
  };

  const start = (refuse: Refuse, root: string, argv: string[], resume: boolean): void => {
    const refusal = startRefusal(runs.get(root), restart !== undefined);
    if (refusal !== undefined) {
      if (!resume) {
        refuse(refusal);
      }
      return;
    }
    let args: Args;
    try {
      args = parseStartArgs(argv);
    } catch (error) {
      refuse(message(error));
      return;
    }
    const run = newRun({ ...startProgress(args.hunt), watching: args.watch });
    runs.set(root, run);
    const update = (next: Progress): void => {
      run.progress = next;
      broadcast(sockets, runs);
    };
    broadcast(sockets, runs);
    let summary: RunSummary | undefined;
    withRunChildren(run.children, () =>
      options.runRepo(root, args, {
        ...runControls(run, update, () =>
          outsideRuns(() => void sendQuestions(root, () => sockets.clients)),
        ),
        print: args.watch
          ? async (pass) => sendAll(sockets, { type: 'pass', root, summary: pass })
          : undefined,
        output: (text) => {
          process.stderr.write(text);
          sendAll(sockets, { type: 'output', root, text });
        },
        ended: (ended) => {
          summary = ended;
        },
      }),
    )
      .then(
        (code) => {
          update({ ...run.progress, status: endStatus(run) });
          sendAll(sockets, {
            type: 'end',
            root,
            code,
            ...(summary === undefined ? {} : { summary }),
          });
        },
        (error: unknown) => {
          update({ ...run.progress, status: 'failed', error: message(error) });
          sendAll(sockets, { type: 'end', root, code: 1, error: message(error) });
        },
      )
      .finally(closeWhenIdle);
  };

  const stop = (socket: Peer, refuse: Refuse, root: string, after: unknown, id?: string) => {
    const point = stopPoint(after);
    if (point === undefined) {
      refuse(`stop does not take --after ${String(after)}`);
      return;
    }
    const run = runs.get(root);
    if (run !== undefined && active(run)) {
      run.stoppedByPerson = true;
      send(socket, stoppingMessage(root, run, id));
    }
    const dropped = dropUpgrade(run);
    if (requestStop(run, point) || dropped) {
      broadcast(sockets, runs);
    }
  };

  const toggle = (
    refuse: Refuse,
    root: string,
    on: boolean,
    set: (run: Run, on: boolean) => void,
  ): void => {
    const run = runs.get(root);
    const refusal = switchRefusal(run, on);
    if (refusal !== undefined) {
      refuse(refusal);
      return;
    }
    set(run!, on);
    broadcast(sockets, runs);
    upgradeBetweenIssues(run!);
  };

  const receive = (
    socket: Peer,
    value: ClientMessage,
    refuse: Refuse,
  ): Promise<void> | undefined => {
    if (value.type === 'hello') {
      if (typeof value.version !== 'string') {
        throw new Error('a hello message needs its version as a string');
      }
      if (value.launch !== undefined && !isLaunch(value.launch)) {
        throw new Error('a hello message needs its launch as a command and a list of args');
      }
      if (isNewer(value.version, options.version)) {
        if (restart === undefined) {
          restart = value.version;
          successor = value.launch;
        }
        runs.forEach(upgradeBetweenIssues);
        closeWhenIdle();
      }
    } else if (value.root !== options.root) {
      refuse(`the worker serves ${options.root} only`);
    } else if (value.type === 'start') {
      start(refuse, value.root, value.args ?? [], value.resume === true);
    } else if (value.type === 'stop') {
      stop(socket, refuse, value.root, value.after, value.id);
    } else if (value.type === 'hunt') {
      toggle(refuse, value.root, value.on, setHunting);
    } else if (value.type === 'watch') {
      toggle(refuse, value.root, value.on, setWatching);
    } else if (value.type === 'refresh') {
      requestRefresh(runs.get(value.root));
    } else if (value.type === 'questions') {
      return sendQuestions(value.root, () => [socket], value.id);
    } else if (value.type === 'upcoming') {
      return sendUpcoming(options.upcoming ?? listUpcoming, socket, value.root);
    }
    return undefined;
  };

  sockets.on('connection', (socket) => {
    send(socket, { type: 'hello', version: options.version });
    send(socket, runsMessage(runs));
    void sendQuestions(options.root, () => [socket]);
    socket.on('close', closeWhenIdle);
    socket.on('error', () => socket.terminate());
    socket.on('message', (data) => {
      const value = parseMessage(String(data));
      if (value === undefined) {
        return;
      }
      const refuse = refuser(socket, value, options.root);
      try {
        void receive(socket, value, refuse);
      } catch (error) {
        refuse(message(error));
      }
    });
  });

  const answer = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    polledAt = Date.now();
    clearTimeout(idleTimer);
    idleTimer = setTimeout(closeWhenIdle, idleMs);
    const refusal = (text: string): WorkerMessage[] => [
      { type: 'error', root: options.root, message: text },
    ];
    if (request.url !== '/') {
      reply(response, 404, refusal('the worker answers on / only'));
    } else if (request.method === 'GET') {
      reply(response, 200, [{ type: 'hello', version: options.version }, runsMessage(runs)]);
    } else if (request.method !== 'POST') {
      reply(response, 405, refusal('the worker answers GET and POST only'));
    } else {
      const value = parseMessage(await readBody(request));
      if (value === undefined) {
        reply(response, 400, refusal('the request is not a next-issue message'));
        return;
      }
      const replies: WorkerMessage[] = [];
      const peer: Peer = { send: (data) => replies.push(JSON.parse(data) as WorkerMessage) };
      const refuse = refuser(peer, value, options.root);
      try {
        await receive(peer, value, refuse);
      } catch (error) {
        refuse(message(error));
      }
      reply(response, 200, [...replies, runsMessage(runs)]);
    }
  };
  server.on('request', (request, response) => void answer(request, response));

  const draft = join(dirname(options.socketPath), `~${basename(options.socketPath).slice(1)}`);
  await rm(draft, { force: true });
  await listen(server, draft);
  await rename(draft, options.socketPath);
  owned.socket = fileId(options.socketPath);
  idleTimer = setTimeout(closeWhenIdle, idleMs);
  return { closed, close, release: () => removeOwned(owned) };
}

type Refuse = (text: string) => void;

function upgradedRun(run: Run): boolean {
  return run.progress.upgrade !== undefined && run.progress.status === 'stopped';
}

function resumeArgs(run: Run): string[] {
  return ['--watch', 'on', '--hunt', run.progress.hunting ? 'on' : 'off'];
}

function refuser(socket: Peer, value: ClientMessage, served: string): Refuse {
  const root = value.type === 'hello' ? served : value.root;
  const id = 'id' in value ? value.id : undefined;
  return (text) =>
    send(socket, { type: 'error', root, message: text, ...(id === undefined ? {} : { id }) });
}

export async function serve(root: string, logCheckMs = LOG_CHECK_MS): Promise<number> {
  const { logPath, ...paths } = workerPaths(root);
  const stopTrimming = keepLogTrimmed(logPath, logCheckMs);
  const worker = await startWorker({
    root,
    ...paths,
    version: await packageVersion(),
    runRepo,
    questions: listQuestions,
  });
  if (worker === undefined) {
    stopTrimming();
    process.stderr.write('next-issue: another worker is running\n');
    return 1;
  }
  const end = (signal: NodeJS.Signals): void => {
    process.off('SIGTERM', onTerminate);
    process.off('SIGINT', onInterrupt);
    process.off('SIGHUP', onHangUp);
    worker.release();
    stopChildren(signal);
  };
  const onTerminate = (): void => end('SIGTERM');
  const onInterrupt = (): void => end('SIGINT');
  const onHangUp = (): void => end('SIGHUP');
  process.on('SIGTERM', onTerminate);
  process.on('SIGINT', onInterrupt);
  process.on('SIGHUP', onHangUp);
  process.stderr.write(`next-issue: worker listening on ${paths.socketPath}\n`);
  await worker.closed;
  stopTrimming();
  return 0;
}
