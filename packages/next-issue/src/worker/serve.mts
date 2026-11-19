import { mkdir, rename, rm } from 'node:fs/promises';
import { createServer, STATUS_CODES } from 'node:http';
import { basename, dirname, join } from 'node:path';
import { WebSocketServer } from 'ws';
import { type Args, givenStartFlags, parseStartArgs } from '../shared/args.mts';
import { stopChildren, withRunChildren } from '../shared/children.mts';
import { message } from '../shared/errors.mts';
import { lock } from '../shared/lock.mts';
import { startProgress } from './progress.mts';
import { type ClientMessage, isNewer, type Launch, type Progress } from '../shared/protocol.mts';
import { runRepo, type RunControls } from './run.mts';
import type { RunSummary } from '../shared/summary.mts';
import { packageVersion } from '../shared/version.mts';
import { resumeOnSuccessor } from '../shared/worker-client.mts';
import { latestVersion, NPM_LATEST, npxLaunch } from './latest-version.mts';
import { keepLogTrimmed, LOG_CHECK_MS } from './worker-log.mts';
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
  registry?: string;
  successorLaunch?: (version: string) => Launch;
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
  const busy = (): boolean => [...runs.values()].some(active);

  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const idleMs = options.idleMs ?? IDLE_MS;
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
    if ((restart !== undefined || sockets.clients.size === 0) && !busy()) {
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
      broadcast(sockets, runs);
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
    broadcast(sockets, runs);
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
    const refusal = startRefusal(going, restart !== undefined);
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
        ...runControls(run, update),
        beforeClaim: () => upgradeToLatest(run),
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
          return sendAllSent(sockets, {
            type: 'end',
            root,
            code,
            ...(summary === undefined ? {} : { summary }),
          });
        },
        (error: unknown) => {
          process.stderr.write(`next-issue failed: ${message(error)}\n`);
          update({ ...run.progress, status: 'failed', error: message(error) });
          return sendAllSent(sockets, { type: 'end', root, code: 1, error: message(error) });
        },
      )
      .finally(() => void close());
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
    } else if (value.type === 'start') {
      start(socket, refuse, value.root, value.args ?? [], value.resume === true, value.id);
    } else if (value.type === 'stop') {
      stop(socket, refuse, value.root, value.after, value.id);
    } else if (value.type === 'hunt') {
      toggle(refuse, value.root, value.on, setHunting);
    } else if (value.type === 'watch') {
      toggle(refuse, value.root, value.on, setWatching);
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
  const stopTrimming = keepLogTrimmed(logPath, logCheckMs);
  const worker = await startWorker({
    root,
    ...paths,
    version: await packageVersion(),
    runRepo,
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
