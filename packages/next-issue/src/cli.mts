#!/usr/bin/env node
import { type Args, parseArgs, USAGE } from './shared/args.mts';
import { moveOldConfig, rejectOldConfig, writeDefaultConfig } from './shared/config.mts';
import { OLD_CONFIG_FILE } from './shared/config-fields.mts';
import { message } from './shared/errors.mts';
import { repoRoot } from './shared/git.mts';
import { ensureExcluded, excludeFile, removeIgnored } from './cli/ignore.mts';
import { followLog, newestRunLog } from './cli/logs.mts';
import { serve } from './worker/serve.mts';
import { startInWorker } from './cli/start.mts';
import { STATE_DIR } from './shared/state.mts';
import { refreshInWorker, stopInWorker, switchInWorker } from './cli/switch-run.mts';
import { chooseScope, installSkills } from './cli/update.mts';
import { WORKTREE_DIR } from './shared/worktree.mts';

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
  if (args.command === 'update') {
    return update(args);
  }
  const root = await repoRoot(process.cwd());
  if (args.command === 'init') {
    return init(root, args.force);
  }
  await rejectOldConfig(root);
  if (args.command === 'stop') {
    await write(process.stdout, await stopInWorker(root));
    return 0;
  }
  if (args.command === 'watch' || args.command === 'hunt') {
    await write(process.stdout, await switchInWorker(root, args.command, args.on!));
    return 0;
  }
  if (args.command === 'refresh') {
    await write(process.stdout, await refreshInWorker(root));
    return 0;
  }
  if (args.command === 'logs') {
    return logs(root);
  }
  await excludeStateDirectories(root, process.stderr);
  if (args.command === 'serve') {
    return serve(root);
  }
  return run(root, args, argv);
}

function run(root: string, args: Args, argv: string[]): Promise<number> {
  process.stderr.on('error', () => {});
  return startInWorker(root, args, argv.slice(1));
}

async function logs(root: string): Promise<number> {
  const file = await newestRunLog(root);
  if (file === undefined) {
    await write(process.stderr, `next-issue: no run log in ${STATE_DIR}/runs\n`);
    return 1;
  }
  const tail = process.stdout.isTTY ? Math.max(1, (process.stdout.rows || 24) - 1) : undefined;
  return followLog(root, file, { tail }, (text) => write(process.stdout, text));
}

async function update(args: Args): Promise<number> {
  const scope = await chooseScope(args.scope);
  for (const folder of await installSkills(scope)) {
    await write(process.stdout, `wrote ${folder}\n`);
  }
  return 0;
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
