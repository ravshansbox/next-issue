import { AsyncLocalStorage } from 'node:async_hooks';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Args } from './args.mts';
import { type Config, loadConfig } from './config.mts';
import { minutesToMs } from './durations.mts';
import { setCommandObserver, withDefaultTimeout } from './exec.mts';
import { detectRepo, type Repo } from './git.mts';
import { defaultBranch } from './github.mts';
import type { Interrupts } from './interrupt.mts';
import { exitCode, type Loop, type LoopResult, runIssues, watchIssues } from './loop.mts';
import { message } from './errors.mts';
import { type Fields, Recorder, runsDir } from './observe.mts';
import { pruneRuns } from './prune-runs.mts';
import type { Context, IssueReport } from './job.mts';
import { pendingIssues } from './pending.mts';
import { processIssue } from './pipeline.mts';
import { PORTS } from './ports.mts';
import { count, type RunSummary } from './summary.mts';
import { packageVersion } from './version.mts';

export type RunControls = {
  interrupts: Interrupts;
  print?: (summary: RunSummary) => Promise<void>;
  onEvent?: (record: Fields) => void;
};

const commandRecorder = new AsyncLocalStorage<Recorder>();

setCommandObserver((record) => {
  commandRecorder.getStore()?.event(
    record.code === 0 ? 'command' : 'command.fail',
    {
      cmd: `${record.command} ${record.args.join(' ')}`,
      code: record.code,
      ms: record.ms,
      stderr: record.stderr.length > 0 ? record.stderr : undefined,
      timedOut: record.timedOut ? true : undefined,
    },
    record.code === 0 ? 'verbose' : 'quiet',
  );
});

export function recordCommands<T>(recorder: Recorder, work: () => Promise<T>): Promise<T> {
  return commandRecorder.run(recorder, work);
}

export async function runRepo(root: string, args: Args, controls: RunControls): Promise<number> {
  const config = await loadConfig(root);
  return withDefaultTimeout(minutesToMs(config.commandTimeoutMinutes), () =>
    runWithConfig(root, args, controls, config),
  );
}

async function runWithConfig(
  root: string,
  args: Args,
  controls: RunControls,
  config: Config,
): Promise<number> {
  const repo = await detectRepo(root, config.remote);
  const recorder = await Recorder.create(repo.root, args.level, controls.onEvent);
  const pruned = await pruneRuns(repo.root, config.keepRunDays);
  if (pruned > 0) {
    recorder.event('runs.pruned', { files: pruned, keepDays: config.keepRunDays }, 'verbose');
  }
  try {
    return await recordCommands(recorder, () => handle(args, config, repo, recorder, controls));
  } finally {
    await recorder.close();
  }
}

async function handle(
  args: Args,
  config: Config,
  repo: Repo,
  recorder: Recorder,
  controls: RunControls,
): Promise<number> {
  const { interrupts } = controls;
  const context = await startRun(args, config, repo, recorder, interrupts);

  const loop: Loop = {
    issues: () => pendingIssues(context),
    process: (issue) => processIssue(context, issue),
    stop: interrupts.afterIssue,
    concurrency: config.concurrency,
  };
  const print = controls.print ?? (async () => undefined);
  const { reports, stoppedAt, error } = args.watch
    ? await watchRun(args, loop, recorder, interrupts, print)
    : await runIssues(args, loop);
  recordLoopEnd(recorder, stoppedAt, error);

  const summary = await endRun(repo, recorder, reports);
  if (!args.watch) {
    await print(summary);
  }
  return error === undefined ? exitCode(reports) : 1;
}

function watchRun(
  args: Args,
  loop: Loop,
  recorder: Recorder,
  interrupts: Interrupts,
  print: (summary: RunSummary) => Promise<void>,
): Promise<LoopResult> {
  let passStart = recorder.summary();
  return watchIssues(args, {
    ...loop,
    wait: (minutes) => {
      recorder.event('watch.wait', { minutes }, 'quiet');
      passStart = recorder.summary();
      return interrupts.sleep(minutesToMs(minutes));
    },
    passEnd: (issues) => print({ ...recorder.summary(passStart), issues }),
  });
}

function recordLoopEnd(recorder: Recorder, stoppedAt: number | undefined, error: unknown): void {
  if (stoppedAt !== undefined) {
    recorder.event('run.stop', { issue: stoppedAt }, 'quiet');
  }
  if (error !== undefined) {
    recorder.event('issues.fail', { error: message(error) }, 'quiet');
  }
}

async function startRun(
  args: Args,
  config: Config,
  repo: Repo,
  recorder: Recorder,
  interrupts: Interrupts,
): Promise<Context> {
  const base = await defaultBranch(repo);
  recorder.event(
    'run.start',
    {
      version: await packageVersion(),
      repo: `${repo.owner}/${repo.name}`,
      base,
      log: recorder.logFile,
    },
    'quiet',
  );
  return {
    repo,
    config,
    base,
    reset: args.reset,
    merge: args.merge,
    stopAfterRound: interrupts.afterRound,
    recorder,
    ports: PORTS,
  };
}

async function endRun(repo: Repo, recorder: Recorder, reports: IssueReport[]): Promise<RunSummary> {
  recorder.event(
    'run.end',
    {
      done: count(reports, 'done'),
      needsHuman: count(reports, 'needs-human'),
      failed: count(reports, 'error'),
      skipped: count(reports, 'skipped'),
      tokens: recorder.summary().total.total,
    },
    'quiet',
  );
  const summary: RunSummary = { ...recorder.summary(), issues: reports };
  const summaryFile = join(runsDir(repo.root), `${recorder.runId}.summary.json`);
  await writeFile(summaryFile, `${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}
