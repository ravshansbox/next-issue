#!/usr/bin/env node
import { parseArgs, USAGE } from './args.mts';
import { writeDefaultConfig } from './config.mts';
import { ensureIgnored, repoRoot, WORKTREE_DIR } from './git.mts';
import { listenForInterrupts } from './interrupt.mts';
import { followLog, newestRunLog } from './logs.mts';
import { message } from './observe.mts';
import { runRepo } from './run.mts';
import { serve, stopWorker, workerPaths } from './serve.mts';
import { STATE_DIR } from './state.mts';
import { formatSummary } from './summary.mts';

function write(stream: NodeJS.WriteStream, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(text, (error) =>
      error === null || error === undefined ? resolve() : reject(error),
    );
  });
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    await write(process.stdout, USAGE);
    return 0;
  }
  const root = await repoRoot(process.cwd());
  if (args.command === 'serve') {
    return serve(root);
  }
  if (args.command === 'stop') {
    const pid = await stopWorker(workerPaths(root).lockPath);
    await write(
      process.stdout,
      pid === undefined
        ? 'next-issue: no worker is running\n'
        : `next-issue: stopped the worker with process id ${pid}\n`,
    );
    return 0;
  }
  if (args.command === 'init') {
    return init(root, args.force);
  }
  if (args.command === 'logs') {
    return logs(root, args.json);
  }
  const interrupts = listenForInterrupts((text) => void write(process.stderr, `${text}\n`));
  return runRepo(root, args, {
    interrupts,
    print: (summary) =>
      write(
        process.stdout,
        args.json ? `${JSON.stringify(summary, null, 2)}\n` : formatSummary(summary),
      ),
  });
}

async function logs(root: string, json: boolean): Promise<number> {
  const file = await newestRunLog(root);
  if (file === undefined) {
    await write(process.stderr, `next-issue: no run log in ${STATE_DIR}/runs\n`);
    return 1;
  }
  const tail = process.stdout.isTTY ? Math.max(1, (process.stdout.rows || 24) - 1) : undefined;
  return followLog(file, { json, tail }, (text) => write(process.stdout, text));
}

async function init(root: string, force: boolean): Promise<number> {
  const path = await writeDefaultConfig(root, force);
  await write(process.stdout, `wrote ${path}\n`);
  if (await ensureIgnored(root, `${STATE_DIR}/`)) {
    await write(process.stdout, `added ${STATE_DIR}/ to .gitignore\n`);
  }
  if (await ensureIgnored(root, `${WORKTREE_DIR}/`)) {
    await write(process.stdout, `added ${WORKTREE_DIR}/ to .gitignore\n`);
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
