import type { Args } from './args.mts';
import { recordCommands } from './command-records.mts';
import { type Config, loadConfig } from './config.mts';
import { minutesToMs } from './durations.mts';
import { message } from './errors.mts';
import { withDefaultTimeout } from './exec.mts';
import { writeJson } from './files.mts';
import { slug } from './gh.mts';
import { detectRepo, type Repo } from './git.mts';
import { checkGitVersion } from './git-version.mts';
import { defaultBranch } from './github.mts';
import { hunter } from './hunt.mts';
import type { Interrupts } from './interrupt.mts';
import { type Switch, onOff } from './switch.mts';
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
  output?: (text: string) => void;
  ended?: (summary: RunSummary) => void;
  // The worker passes a switch that its clients turn on and off; without one, the run keeps --hunt.
  hunting?: Switch;
  // The worker passes a switch that its clients turn on and off; without one, the run keeps --watch.
  watching?: Switch;
  // The worker passes the signal of its clients' refresh requests, which end a watch wait early.
  refreshed?: () => AbortSignal;
};

export async function runRepo(root: string, args: Args, controls: RunControls): Promise<number> {
  const config = await loadConfig(root, { sortFile: true });
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
  await checkGitVersion();
  const repo = await detectRepo(root, config.remote);
  const recorder = await Recorder.create(repo.root, controls.onEvent, undefined, controls.output);
  try {
    const pruned = await pruneRuns(repo.root, config.keepRunDays);
    if (pruned > 0) {
      recorder.record('runs.pruned', { files: pruned, keepDays: config.keepRunDays });
    }
    return await recordCommands(recorder, () => handle(args, config, repo, recorder, controls));
  } catch (error) {
    recorder.record('run.fail', { error: message(error) });
    throw error;
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
    process: (issue, claimed, slot) => processIssue(context, issue, claimed, slot),
    stop: interrupts.afterIssue,
    concurrency: config.concurrency,
  };
  const print = controls.print ?? (async () => undefined);
  const { reports, stoppedAt, error, crash } =
    args.watch || controls.watching !== undefined
      ? await watchRun(args, loop, context, controls, print)
      : await runIssues(loop);
  recordLoopEnd(recorder, stoppedAt, interrupts.afterIssue(), error);

  const summary = await endRun(recorder, reports);
  if (crash !== undefined) {
    throw crash.failure;
  }
  controls.ended?.(summary);
  if (!args.watch) {
    await print(summary);
  }
  return error === undefined ? exitCode(reports) : 1;
}

export function watchRun(
  args: Args,
  loop: Loop,
  context: Context,
  controls: RunControls,
  print: (summary: RunSummary) => Promise<void>,
): Promise<LoopResult> {
  const { recorder } = context;
  const { interrupts } = controls;
  let passStart = recorder.summary();
  const hunt = hunter(context);
  return watchIssues({
    ...loop,
    wait: (minutes, refreshed) => {
      recorder.event('watch.wait', { minutes });
      passStart = recorder.summary();
      return interrupts.sleep(minutesToMs(minutes), () => hunt.busy(), refreshed);
    },
    passEnd: (issues) => print({ ...recorder.summary(passStart), issues }),
    hunter: hunt,
    hunting: controls.hunting ?? onOff(args.hunt),
    watching: controls.watching,
    refreshed: controls.refreshed,
  });
}

function recordLoopEnd(
  recorder: Recorder,
  stoppedAt: number | undefined,
  stopped: boolean,
  error: unknown,
): void {
  if (stoppedAt !== undefined) {
    recorder.event('run.stop', { issue: stoppedAt });
  } else if (stopped) {
    recorder.event('run.stop', {});
  }
  if (error !== undefined) {
    recorder.event('issues.fail', { error: message(error) });
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
  recorder.event('run.start', {
    version: await packageVersion(),
    repo: slug(repo),
    base,
    log: recorder.logFile,
  });
  if (config.labels.ready.length === 0) {
    recorder.event('labels.ready.empty', {
      note: 'labels.ready is empty, so every open issue can be claimed',
    });
  }
  return {
    repo,
    config,
    base,
    stopAfterRound: interrupts.afterRound,
    halted: false,
    recorder,
    ports: PORTS,
  };
}

async function endRun(recorder: Recorder, reports: IssueReport[]): Promise<RunSummary> {
  recorder.event('run.end', {
    done: count(reports, 'done'),
    needsHuman: count(reports, 'needs-human'),
    failed: count(reports, 'error'),
    skipped: count(reports, 'skipped'),
    tokens: recorder.summary().total.total,
  });
  const summary: RunSummary = { ...recorder.summary(), issues: reports };
  await writeJson(recorder.summaryFile, summary);
  return summary;
}
