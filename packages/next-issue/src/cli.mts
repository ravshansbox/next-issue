#!/usr/bin/env node
import { type Args, parseArgs, USAGE } from './args.mts';
import { moveOldConfig, rejectOldConfig, writeDefaultConfig } from './config.mts';
import { OLD_CONFIG_FILE } from './config-fields.mts';
import { message } from './errors.mts';
import { repoRoot } from './git.mts';
import { ensureExcluded, excludeFile, removeIgnored } from './ignore.mts';
import { stopWorker } from './lock.mts';
import { followLog, newestRunLog } from './logs.mts';
import { serve } from './serve.mts';
import { startInWorker } from './start.mts';
import { STATE_DIR } from './state.mts';
import { workerPaths } from './worker-paths.mts';
import { WORKTREE_DIR } from './worktree.mts';

function write(stream: NodeJS.WriteStream, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(text, (error) => (error ? reject(error) : resolve()));
  });
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  if (args.help) {
    await write(process.stdout, USAGE);
    return 0;
  }
  if (args.command === undefined) {
    await write(process.stderr, USAGE);
    return 1;
  }
  const root = await repoRoot(process.cwd());
  if (args.command === 'init') {
    return init(root, args.force);
  }
  await rejectOldConfig(root);
  if (args.command === 'stop') {
    return stop(root);
  }
  if (args.command === 'logs') {
    return logs(root, args.json);
  }
  await excludeStateDirectories(root, process.stderr);
  if (args.command === 'serve') {
    return serve(root);
  }
  return run(root, args, argv);
}

function run(root: string, args: Args, argv: string[]): Promise<number> {
  process.stderr.on('error', () => {});
  return startInWorker(
    root,
    args,
    argv.slice(1).filter((arg) => arg !== '--json' && arg !== '--force'),
  );
}

const STOPPED = {
  none: () => 'next-issue: no worker is running\n',
  worker: (pid?: number) => `next-issue: stopped the worker with process id ${pid}\n`,
};

async function stop(root: string): Promise<number> {
  const { stopped, pid } = await stopWorker(workerPaths(root));
  await write(process.stdout, STOPPED[stopped](pid));
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
  const moved = await moveOldConfig(root, force);
  if (moved === undefined) {
    await write(process.stdout, `wrote ${await writeDefaultConfig(root, force)}\n`);
  } else {
    await write(process.stdout, `moved ${OLD_CONFIG_FILE} to ${moved}\n`);
  }
  await excludeStateDirectories(root, process.stdout);
  return 0;
}

async function excludeStateDirectories(root: string, stream: NodeJS.WriteStream): Promise<void> {
  const exclude = await excludeFile(root);
  const entries = [STATE_DIR, WORKTREE_DIR].map((directory) => `${directory}/`);
  for (const entry of entries) {
    if (await ensureExcluded(exclude, entry)) {
      await write(stream, `added ${entry} to ${exclude}\n`);
    }
  }
  for (const entry of await removeIgnored(root, entries)) {
    await write(stream, `removed ${entry} from .gitignore\n`);
  }
}

main().then(
  (code) => process.exit(code),
  async (error: unknown) => {
    await write(process.stderr, `next-issue failed: ${message(error)}\n`);
    process.exit(1);
  },
);
