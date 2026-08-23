#!/usr/bin/env node
import { createModelRuntime } from "./agents.mts";
import { loadConfig } from "./config.mts";
import { detectRepo } from "./git.mts";
import { currentLogin, defaultBranch, openIssues } from "./github.mts";
import { type Context, processIssue } from "./pipeline.mts";

type Args = {
  issue?: number;
  once: boolean;
  max?: number;
  help: boolean;
};

const USAGE = `next-issue [options]

  --issue <n>  handle one issue only
  --once       stop after the first handled issue
  --max <n>    handle at most n issues
  --help       show this text
`;

function parseArgs(argv: string[]): Args {
  const args: Args = { once: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--help") {
      args.help = true;
    } else if (arg === "--once") {
      args.once = true;
    } else if (arg === "--issue") {
      args.issue = Number(argv[++index]);
    } else if (arg === "--max") {
      args.max = Number(argv[++index]);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const cwd = process.cwd();
  const config = await loadConfig(cwd);
  const repo = await detectRepo(cwd, config.remote);
  const [base, login, modelRuntime] = await Promise.all([
    defaultBranch(repo),
    currentLogin(repo),
    createModelRuntime(),
  ]);
  const context: Context = { repo, config, base, login, modelRuntime };
  process.stderr.write(`[next-issue] ${repo.owner}/${repo.name} on ${base} as ${login}\n`);

  const issues = (await openIssues(repo, config.issueLimit)).filter(
    (issue) => args.issue === undefined || issue.number === args.issue,
  );
  if (issues.length === 0) {
    process.stderr.write("[next-issue] no open issue matches\n");
    return 0;
  }

  let handled = 0;
  let handedOver = 0;
  for (const issue of issues) {
    if (args.max !== undefined && handled >= args.max) {
      break;
    }
    const outcome = await processIssue(context, issue);
    if (outcome === "skipped") {
      continue;
    }
    handled += 1;
    if (outcome === "needs-human") {
      handedOver += 1;
    }
    if (args.once) {
      break;
    }
  }

  process.stderr.write(`[next-issue] handled ${handled}, needs help on ${handedOver}\n`);
  return handedOver > 0 ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`[next-issue] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  },
);
