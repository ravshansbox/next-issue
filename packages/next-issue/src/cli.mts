#!/usr/bin/env node
import { type Args, parseArgs, USAGE } from './shared/args.mts';
import {
  loadConfig,
  moveOldConfig,
  rejectOldConfig,
  removeUnknownFields,
  writeDefaultConfig,
} from './shared/config.mts';
import { CONFIG_FILE, OLD_CONFIG_FILE } from './shared/config-fields.mts';
import { message } from './shared/errors.mts';
import { detectRepo, repoRoot } from './shared/git.mts';
import { type BasePackage, basePackage, requireScripts } from './shared/setup.mts';
import { ensureExcluded, excludeFile, removeIgnored } from './cli/ignore.mts';
import { followLog, newestRunLog } from './cli/logs.mts';
import { serve } from './worker/serve.mts';
import { startInWorker } from './cli/start.mts';
import { STATE_DIR } from './shared/state.mts';
import { statusInWorker, stopInWorker, switchInWorker } from './cli/switch-run.mts';
import {
  chooseScope,
  installSkills,
  PROJECT_SKILL_FOLDERS,
  refreshSkills,
  untrackSkills,
} from './cli/skills.mts';
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
  const root = await repoRoot(process.cwd());
  if (args.command === 'init') {
    return init(root, args);
  }
  await rejectOldConfig(root);
  if (args.command === 'stop') {
    await write(process.stdout, await stopInWorker(root));
    return 0;
  }
  if (args.command === 'status') {
    await write(process.stdout, await statusInWorker(root));
    return 0;
  }
  if (args.command === 'watch' || args.command === 'hunt') {
    await write(process.stdout, await switchInWorker(root, args.command, args.on!));
    return 0;
  }
  if (args.command === 'logs') {
    return logs(root);
  }
  await removeUnknownConfig(root, process.stderr);
  if (args.command === 'start') {
    requireScripts(await rootBasePackage(root));
  }
  await excludeStateDirectories(root, process.stderr);
  if (args.command === 'serve') {
    return serve(root);
  }
  for (const note of [...(await untrackSkills(root)), ...(await refreshSkills(root))]) {
    await write(process.stderr, `${note}\n`);
  }
  await write(process.stderr, await startInWorker(root, argv.slice(1)));
  return 0;
}

async function logs(root: string): Promise<number> {
  const file = await newestRunLog(root);
  if (file === undefined) {
    await write(process.stderr, `no run log in ${STATE_DIR}/runs\n`);
    return 1;
  }
  const tail = process.stdout.isTTY ? Math.max(1, (process.stdout.rows || 24) - 1) : undefined;
  return followLog(root, file, { tail }, (text) => write(process.stdout, text));
}

async function init(root: string, args: Args): Promise<number> {
  const scope = await chooseScope(args.scope);
  const moved = await moveOldConfig(root, args.force);
  if (moved === undefined) {
    const { path, written } = await writeDefaultConfig(root, args.force);
    await write(process.stdout, `${written ? 'wrote' : 'kept'} ${path}\n`);
  } else {
    await write(process.stdout, `moved ${OLD_CONFIG_FILE} to ${moved}\n`);
  }
  await removeUnknownConfig(root, process.stdout);
  await excludeStateDirectories(root, process.stdout);
  for (const folder of await installSkills(scope)) {
    await write(process.stdout, `wrote ${folder}\n`);
  }
  const base = await rootBasePackage(root).catch((error: unknown) => {
    const reason = message(error);
    return write(process.stderr, `could not check the scripts on the base branch: ${reason}\n`);
  });
  if (base !== undefined) {
    requireScripts(base);
  }
  return 0;
}

async function rootBasePackage(root: string): Promise<BasePackage> {
  const { remote } = await loadConfig(root);
  return basePackage(await detectRepo(root, remote), remote);
}

async function removeUnknownConfig(root: string, stream: NodeJS.WriteStream): Promise<void> {
  for (const entry of await removeUnknownFields(root)) {
    await write(stream, `removed ${entry} from ${CONFIG_FILE}\n`);
  }
}

async function excludeStateDirectories(root: string, stream: NodeJS.WriteStream): Promise<void> {
  const exclude = await excludeFile(root);
  const entries = [
    ...[STATE_DIR, WORKTREE_DIR].map((directory) => `${directory}/`),
    ...PROJECT_SKILL_FOLDERS,
  ];
  for (const entry of entries) {
    if (await ensureExcluded(exclude, entry)) {
      await write(stream, `added ${entry} to ${exclude}\n`);
    }
  }
  for (const entry of await removeIgnored(root, [`${STATE_DIR}/`])) {
    await write(stream, `removed ${entry} from .gitignore\n`);
  }
}

main().then(
  (code) => process.exit(code),
  async (error: unknown) => {
    await write(process.stderr, `${message(error)}\n`);
    process.exit(1);
  },
);
