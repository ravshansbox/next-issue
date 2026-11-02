#!/usr/bin/env node
import { parseArgs, USAGE } from "./args.mts";
import { writeDefaultConfig } from "./config.mts";
import { ensureIgnored, repoRoot, WORKTREE_DIR } from "./git.mts";
import { listenForInterrupts } from "./interrupt.mts";
import { message } from "./observe.mts";
import { runRepo } from "./run.mts";
import { serve } from "./serve.mts";
import { STATE_DIR } from "./state.mts";
import { formatSummary } from "./summary.mts";

function write(stream: NodeJS.WriteStream, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(text, (error) => (error === null || error === undefined ? resolve() : reject(error)));
  });
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    await write(process.stdout, USAGE);
    return 0;
  }
  if (args.command === "serve") {
    return serve();
  }
  const root = await repoRoot(process.cwd());
  if (args.command === "init") {
    return init(root, args.force);
  }
  const interrupts = listenForInterrupts((text) => void write(process.stderr, `${text}\n`));
  return runRepo(root, args, {
    interrupts,
    print: (summary) =>
      write(process.stdout, args.json ? `${JSON.stringify(summary, null, 2)}\n` : formatSummary(summary)),
  });
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
