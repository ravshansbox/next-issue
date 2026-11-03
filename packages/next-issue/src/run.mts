import { AsyncLocalStorage } from 'node:async_hooks';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Args } from './args.mts';
import { type Config, loadConfig } from './config.mts';
import { setCommandObserver, setDefaultTimeout } from './exec.mts';
import { detectRepo, type Repo } from './git.mts';
import { defaultBranch } from './github.mts';
import type { Interrupts } from './interrupt.mts';
import { exitCode, type Loop, runIssues, watchIssues } from './loop.mts';
import { type Fields, message, pruneRuns, Recorder } from './observe.mts';
import { type Context, type IssueReport, pendingIssues, PORTS, processIssue } from './pipeline.mts';
import { STATE_DIR } from './state.mts';
import type { RunSummary } from './summary.mts';
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
  setDefaultTimeout(config.commandTimeoutMinutes * 60_000);
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
  const base = await defaultBranch(repo);
  const context: Context = {
    repo,
    config,
    base,
    reset: args.reset,
    merge: args.merge,
    stopAfterRound: interrupts.afterRound,
    recorder,
    ports: PORTS,
  };
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

  const loop: Loop = {
    issues: async () => {
      const issues = await pendingIssues(context);
      recorder.event('issues', { open: issues.length }, 'quiet');
      return issues;
    },
    process: (issue) => processIssue(context, issue),
    stop: interrupts.afterIssue,
  };
  const print = controls.print ?? (async () => undefined);
  let passStart = recorder.summary();
  const { reports, stoppedAt, error } = args.watch
    ? await watchIssues(args, {
        ...loop,
        wait: (minutes) => {
          recorder.event('watch.wait', { minutes }, 'quiet');
          passStart = recorder.summary();
          return interrupts.sleep(minutes * 60_000);
        },
        passEnd: (issues) => print({ ...recorder.summary(passStart), issues }),
      })
    : await runIssues(args, loop);
  if (stoppedAt !== undefined) {
    recorder.event('run.stop', { issue: stoppedAt }, 'quiet');
  }
  if (error !== undefined) {
    recorder.event('issues.fail', { error: message(error) }, 'quiet');
  }

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
  const summaryFile = join(repo.root, STATE_DIR, 'runs', `${recorder.runId}.summary.json`);
  await writeFile(summaryFile, `${JSON.stringify(summary, null, 2)}\n`);
  if (!args.watch) {
    await print(summary);
  }
  return error === undefined ? exitCode(reports) : 1;
}

function count(reports: IssueReport[], outcome: IssueReport['outcome']): number {
  return reports.filter((report) => report.outcome === outcome).length;
}
