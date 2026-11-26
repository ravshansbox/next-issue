import { appendFileSync } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { createServer, STATUS_CODES } from 'node:http';
import { constants } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { WebSocketServer } from 'ws';
import { type Args, givenStartFlags, parseStartArgs } from '../shared/args.mts';
import { killChildren, stopChildren, withRunChildren } from '../shared/children.mts';
import { message } from '../shared/errors.mts';
import { lock } from '../shared/lock.mts';
import { startProgress } from './progress.mts';
import { type ClientMessage, isNewer, type Launch, type Progress } from '../shared/protocol.mts';
import { render } from '../shared/render.mts';
import { runRepo, type RunControls } from './run.mts';
import type { RunSummary } from '../shared/summary.mts';
import { packageVersion } from '../shared/version.mts';
import { resumeOnSuccessor } from '../shared/worker-client.mts';
import { latestVersion, NPM_LATEST, npxLaunch } from './latest-version.mts';
import { keepLogTrimmed, LOG_CHECK_MS, whileStartingSuccessor } from './worker-log.mts';
import { checkSocketPath, workerPaths } from '../shared/worker-paths.mts';
import {
  active,
  dropUpgrade,
  endStatus,
  joinRun,
  newRun,
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
  type Peer,
  removeOwned,
  send,
  sendAll,
  sendAllSent,
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
  lockWaitMs?: number;
  idleMs?: number;
  endSendMs?: number;
  maxBufferedBytes?: number;
  registry?: string;
  successorLaunch?: (version: string) => Launch;
  log?: (text: string) => void;
};

const LOCK_WAIT_MS = 5_000;
const IDLE_MS = 30_000;
const END_SEND_MS = 5_000;
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;

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
  let closing = false;
  let sendingEnd = false;
  let signalled = false;

  const server = createServer();
  const sockets = new WebSocketServer({ server });
  const maxBufferedBytes = options.maxBufferedBytes ?? MAX_BUFFERED_BYTES;
  const endSendMs = options.endSendMs ?? END_SEND_MS;
  const busy = (): boolean => [...runs.values()].some(active);
  const log = options.log ?? (() => undefined);
  const exit = (fields: Record<string, unknown>, below = ''): void => {
    const time = new Date().toISOString();
    log(`${render({ ts: time, kind: 'worker.exit', ...fields })}${below}`);
    for (const run of runs.values()) {
      if (active(run) && run.log !== undefined) {
        const record = { ts: time, runId: run.log.runId, kind: 'worker.exit', ...fields };
        try {
          appendFileSync(run.log.file, `${JSON.stringify(record)}\n`);
        } catch {}
      }
    }
  };

  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const idleMs = options.idleMs ?? IDLE_MS;
  const handOver = (how: Launch, run: Run): Promise<string | undefined> =>
    whileStartingSuccessor(async () => {
      const listening = stopListening(server);
      removeOwned(owned);
      let failure: string | undefined;
      try {
        await resumeOnSuccessor(options.root, how, resumeArgs(run));
      } catch (error) {
        const reason = `the worker could not start next-issue ${restart}: ${message(error)}`;
        process.stderr.write(`${reason}\n`);
        run.progress = { ...run.progress, status: 'failed', error: reason };
        broadcast(sockets, runs, maxBufferedBytes);
        failure = reason;
      }
      await shutdown(server, sockets, owned, listening);
      return failure;
    });

  const { closed, close } = closer(async () => {
    closing = true;
    clearTimeout(idleTimer);
    const run = runs.get(options.root);
    if (successor !== undefined && run !== undefined && upgradedRun(run)) {
      const failure = await handOver(successor, run);
      if (failure !== undefined) {
        exit({ reason: 'hand-over-failed', code: 1, error: failure });
        return 1;
      }
      exit({ reason: 'hand-over', code: 0 });
    } else {
      await shutdown(server, sockets, owned);
      exit(
        restart === undefined
          ? { reason: 'idle', code: 0 }
          : { reason: 'upgrade', code: 0, to: restart },
      );
    }
    return 0;
  });
  const closeWhenIdle = (): void => {
    if ((restart !== undefined || sockets.clients.size === 0) && !busy() && !sendingEnd) {
      void close();
    }
  };

  const upgradeBetweenIssues = (run: Run, everyRun = false): void => {
    if (restart === undefined) {
      return;
    }
    const upgrade = {
      from: options.version,
      to: restart,
      ...(successor === undefined ? {} : { resumes: true }),
    };
    if (requestUpgrade(run, upgrade, everyRun)) {
      broadcast(sockets, runs, maxBufferedBytes);
    }
  };

  const upgradeToLatest = async (run: Run): Promise<void> => {
    const latest = await latestVersion(options.registry ?? NPM_LATEST);
    if (latest === undefined || !isNewer(latest, options.version)) {
      return;
    }
    if (restart === undefined) {
      restart = latest;
      successor = (options.successorLaunch ?? npxLaunch)(latest);
    }
    upgradeBetweenIssues(run, true);
  };

  const joinGoing = (socket: Peer, refuse: Refuse, run: Run, argv: string[], id?: string): void => {
    let refusal: string | undefined;
    try {
      refusal = joinRun(run, givenStartFlags(argv));
    } catch (error) {
      refusal = message(error);
    }
    if (refusal !== undefined) {
      refuse(refusal);
      return;
    }
    broadcast(sockets, runs, maxBufferedBytes);
    upgradeBetweenIssues(run);
    send(socket, runsMessage(runs, id));
  };

  const start = (
    socket: Peer,
    refuse: Refuse,
    root: string,
    argv: string[],
    resume: boolean,
    id?: string,
  ): void => {
    const going = runs.get(root);
    if (active(going) && !resume) {
      joinGoing(socket, refuse, going!, argv, id);
      return;
    }
    const refusal = startRefusal(going, restart !== undefined, closing);
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
      broadcast(sockets, runs, maxBufferedBytes);
    };
    broadcast(sockets, runs, maxBufferedBytes);
    let summary: RunSummary | undefined;
    withRunChildren(run.children, () =>
      options.runRepo(root, args, {
        ...runControls(run, update),
        beforeClaim: () => upgradeToLatest(run),
        print: args.watch
          ? async (pass) =>
              sendAll(sockets, { type: 'pass', root, summary: pass }, maxBufferedBytes)
          : undefined,
        output: (text) => {
          process.stderr.write(text);
          sendAll(sockets, { type: 'output', root, text }, maxBufferedBytes);
        },
        ended: (ended) => {
          summary = ended;
        },
      }),
    )
      .finally(() => {
        closing = true;
        sendingEnd = true;
      })
      .then(
        (code) => {
          update({ ...run.progress, status: endStatus(run) });
          return sendAllSent(
            sockets,
            {
              type: 'end',
              root,
              code,
              ...(summary === undefined ? {} : { summary }),
            },
            endSendMs,
          );
        },
        (error: unknown) => {
          process.stderr.write(`${message(error)}\n`);
          update({ ...run.progress, status: 'failed', error: message(error) });
          return sendAllSent(
            sockets,
            { type: 'end', root, code: 1, error: message(error) },
            endSendMs,
          );
        },
      )
      .finally(() => void close());
  };

  const stop = (socket: Peer, refuse: Refuse, root: string, after: unknown, id?: string) => {
    const point = stopPoint(after);
    if (point === undefined) {
      refuse(`\`stop\` does not take \`--after ${String(after)}\``);
      return;
    }
    const run = runs.get(root);
    if (run !== undefined && active(run)) {
      run.stoppedByPerson = true;
      send(socket, stoppingMessage(root, run, id));
    }
    const dropped = dropUpgrade(run);
    if (requestStop(run, point) || dropped) {
      broadcast(sockets, runs, maxBufferedBytes);
    }
  };

  const toggle = (
    socket: Peer,
    refuse: Refuse,
    root: string,
    on: boolean,
    set: (run: Run, on: boolean) => void,
    id?: string,
  ): void => {
    const run = runs.get(root);
    const refusal = switchRefusal(run, on);
    if (refusal !== undefined) {
      refuse(refusal);
      return;
    }
    set(run!, on);
    broadcast(sockets, runs, maxBufferedBytes);
    upgradeBetweenIssues(run!);
    send(socket, runsMessage(runs, id));
  };

  const receive = (socket: Peer, value: ClientMessage, refuse: Refuse): void => {
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
        runs.forEach((run) => upgradeBetweenIssues(run));
        closeWhenIdle();
      }
    } else if (value.root !== options.root) {
      refuse(`the worker serves ${options.root} only`);
    } else if (signalled && (value.type === 'start' || value.type === 'stop')) {
      refuse('the worker is stopping');
    } else if (value.type === 'start') {
      start(socket, refuse, value.root, value.args ?? [], value.resume === true, value.id);
    } else if (value.type === 'stop') {
      stop(socket, refuse, value.root, value.after, value.id);
    } else if (value.type === 'hunt') {
      toggle(socket, refuse, value.root, value.on, setHunting, value.id);
    } else if (value.type === 'watch') {
      toggle(socket, refuse, value.root, value.on, setWatching, value.id);
    }
  };

  sockets.on('connection', (socket) => {
    send(socket, { type: 'hello', version: options.version });
    send(socket, runsMessage(runs));
    socket.on('close', closeWhenIdle);
    socket.on('error', () => socket.terminate());
    socket.on('message', (data) => {
      const value = parseMessage(String(data));
      if (value === undefined) {
        return;
      }
      const refuse = refuser(socket, value, options.root);
      try {
        receive(socket, value, refuse);
      } catch (error) {
        refuse(message(error));
      }
    });
  });

  server.on('request', (_request, response) => {
    response.writeHead(426, { connection: 'close' });
    response.end(STATUS_CODES[426]);
  });

  const draft = join(dirname(options.socketPath), `~${basename(options.socketPath).slice(1)}`);
  await rm(draft, { force: true });
  await listen(server, draft);
  sockets.on('error', (error) => {
    log(render({ ts: new Date().toISOString(), kind: 'worker.error', error: message(error) }));
  });
  await rename(draft, options.socketPath);
  owned.socket = fileId(options.socketPath);
  idleTimer = setTimeout(closeWhenIdle, idleMs);
  return {
    closed,
    close,
    release: () => removeOwned(owned),
    exit,
    signalled: () => {
      signalled = true;
    },
  };
}

type Refuse = (text: string) => void;

function upgradedRun(run: Run): boolean {
  return run.progress.upgrade !== undefined && run.progress.status === 'stopped';
}

function resumeArgs(run: Run): string[] {
  return [
    '--watch',
    run.progress.watching === true ? 'on' : 'off',
    '--hunt',
    run.progress.hunting ? 'on' : 'off',
  ];
}

function refuser(socket: Peer, value: ClientMessage, served: string): Refuse {
  const root = value.type === 'hello' ? served : value.root;
  const id = 'id' in value ? value.id : undefined;
  return (text) =>
    send(socket, { type: 'error', root, message: text, ...(id === undefined ? {} : { id }) });
}

export async function serve(root: string, logCheckMs = LOG_CHECK_MS): Promise<number> {
  const { logPath, ...paths } = workerPaths(root);
  const version = await packageVersion();
  const worker = await startWorker({
    root,
    ...paths,
    version,
    runRepo,
    log: (text) => process.stderr.write(text),
  });
  if (worker === undefined) {
    process.stderr.write('another worker is running\n');
    return 1;
  }
  const stopTrimming = keepLogTrimmed(logPath, logCheckMs);
  const end = (signal: NodeJS.Signals): void => {
    process.off('SIGTERM', onTerminate);
    process.off('SIGINT', onInterrupt);
    process.off('SIGHUP', onHangUp);
    worker.signalled();
    stopChildren(signal, () => {
      worker.exit({ reason: signal, code: 128 + constants.signals[signal] });
      worker.release();
    });
  };
  const onTerminate = (): void => end('SIGTERM');
  const onInterrupt = (): void => end('SIGINT');
  const onHangUp = (): void => end('SIGHUP');
  process.on('SIGTERM', onTerminate);
  process.on('SIGINT', onInterrupt);
  process.on('SIGHUP', onHangUp);
  const crash = (error: unknown): void => {
    const stack = error instanceof Error && error.stack !== undefined ? `${error.stack}\n` : '';
    worker.exit({ reason: 'crash', code: 1, error: message(error) }, stack);
    killChildren();
    try {
      worker.release();
    } catch {}
    process.exit(1);
  };
  process.on('uncaughtException', crash);
  process.on('unhandledRejection', crash);
  process.stderr.write(
    render({
      ts: new Date().toISOString(),
      kind: 'worker.start',
      version,
      pid: process.pid,
      socket: paths.socketPath,
    }),
  );
  const code = await worker.closed;
  stopTrimming();
  return code;
}
