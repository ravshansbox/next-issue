#!/usr/bin/env node
import { type Args, parseArgs, USAGE } from './args.mts';
import { moveOldConfig, rejectOldConfig, writeDefaultConfig } from './config.mts';
import { OLD_CONFIG_FILE } from './config-fields.mts';
import { message } from './errors.mts';
import { prettyJson } from './files.mts';
import { repoRoot } from './git.mts';
import { ensureExcluded, excludeFile, removeIgnored } from './ignore.mts';
import { listenForInterrupts } from './interrupt.mts';
import { stopWorker } from './lock.mts';
import { followLog, newestRunLog } from './logs.mts';
import { runRepo } from './run.mts';
import { serve } from './serve.mts';
import { STATE_DIR } from './state.mts';
import { formatSummary } from './summary.mts';
import { workerPaths } from './worker-paths.mts';
import { WORKTREE_DIR } from './worktree.mts';

function write(stream: NodeJS.WriteStream, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(text, (error) => (error ? reject(error) : resolve()));
  });
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    await write(process.stdout, USAGE);
    return 0;
  }
  const root = await repoRoot(process.cwd());
  if (args.command === 'init') {
    return init(root, args.force);
  }
  await rejectOldConfig(root);
  if (args.command === 'serve') {
    return serve(root);
  }
  if (args.command === 'stop') {
    return stop(root);
  }
  if (args.command === 'logs') {
    return logs(root, args.json);
  }
  return run(root, args);
}

function run(root: string, args: Args): Promise<number> {
  const interrupts = listenForInterrupts((text) => void write(process.stderr, `${text}\n`));
  return runRepo(root, args, {
    interrupts,
    print: (summary) =>
      write(process.stdout, args.json ? prettyJson(summary) : formatSummary(summary)),
  });
}

async function stop(root: string): Promise<number> {
  const pid = await stopWorker(workerPaths(root).lockPath);
  await write(
    process.stdout,
    pid === undefined
      ? 'next-issue: no worker is running\n'
      : `next-issue: stopped the worker with process id ${pid}\n`,
  );
  return 0;
}

async function logs(root: string, json: boolean): Promise<number> {
  const file = await newestRunLog(root);
  if (file === undefined) {
    await write(process.stderr, `next-issue: no run log in ${STATE_DIR}/runs\n`);
    return 1;
  }
  const tail = process.stdout.isTTY ? Math.max(1, (process.stdout.rows || 24) - 1) : undefined;
  return followLog(root, file, { json, tail }, (text) => write(process.stdout, text));
}

async function init(root: string, force: boolean): Promise<number> {
  const exclude = await excludeFile(root);
  const moved = await moveOldConfig(root, force);
  if (moved === undefined) {
    await write(process.stdout, `wrote ${await writeDefaultConfig(root, force)}\n`);
  } else {
    await write(process.stdout, `moved ${OLD_CONFIG_FILE} to ${moved}\n`);
  }
  const entries = [STATE_DIR, WORKTREE_DIR].map((directory) => `${directory}/`);
  for (const entry of entries) {
    if (await ensureExcluded(exclude, entry)) {
      await write(process.stdout, `added ${entry} to ${exclude}\n`);
    }
  }
  for (const entry of await removeIgnored(root, entries)) {
    await write(process.stdout, `removed ${entry} from .gitignore\n`);
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  async (error: unknown) => {
    await write(process.stderr, `next-issue failed: ${message(error)}\n`);
    process.exit(1);
  },
);
