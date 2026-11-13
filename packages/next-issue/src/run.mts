import type { Args } from './args.mts';
import { recordCommands } from './command-records.mts';
import { type Config, loadConfig } from './config.mts';
import { minutesToMs } from './durations.mts';
import { message } from './errors.mts';
import { withDefaultTimeout } from './exec.mts';
import { writeJson } from './files.mts';
import { slug } from './gh.mts';
import { detectRepo, type Repo } from './git.mts';
import { defaultBranch } from './github.mts';
import { hunter } from './hunt.mts';
import type { Interrupts } from './interrupt.mts';
import type { Context, IssueReport } from './job.mts';
import { exitCode, type Loop, type LoopResult, runIssues } from './loop.mts';
import { type Fields, Recorder } from './observe.mts';
import { pendingIssues } from './pending.mts';
import { processIssue } from './pipeline.mts';
import { PORTS } from './ports.mts';
import { pruneRuns } from './prune-runs.mts';
import { count, type RunSummary } from './summary.mts';
import { packageVersion } from './version.mts';
import { watchIssues } from './watch.mts';

export type RunControls = {
  interrupts: Interrupts;
  print?: (summary: RunSummary) => Promise<void>;
  onEvent?: (record: Fields) => void;
};

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
    ? await watchRun(args, loop, context, interrupts, print)
    : await runIssues(args, loop);
  recordLoopEnd(recorder, stoppedAt, error);

  const summary = await endRun(recorder, reports);
  if (!args.watch) {
    await print(summary);
  }
  return error === undefined ? exitCode(reports) : 1;
}

function watchRun(
  args: Args,
  loop: Loop,
  context: Context,
  interrupts: Interrupts,
  print: (summary: RunSummary) => Promise<void>,
): Promise<LoopResult> {
  const { recorder } = context;
  let passStart = recorder.summary();
  const hunting = args.hunt ? hunter(context) : undefined;
  return watchIssues(args, {
    ...loop,
    wait: (minutes) => {
      recorder.event('watch.wait', { minutes }, 'quiet');
      passStart = recorder.summary();
      return interrupts.sleep(minutesToMs(minutes), () => hunting?.busy() === true);
    },
    passEnd: (issues) => print({ ...recorder.summary(passStart), issues }),
    ...(hunting === undefined ? {} : { hunter: hunting }),
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
      repo: slug(repo),
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
    stopAfterRound: interrupts.afterRound,
    recorder,
    ports: PORTS,
  };
}

async function endRun(recorder: Recorder, reports: IssueReport[]): Promise<RunSummary> {
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
  await writeJson(recorder.summaryFile, summary);
  return summary;
}
