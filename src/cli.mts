#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CONFIG_FILE, type Config, loadConfig, writeDefaultConfig } from "./config.mts";
import { setCommandObserver } from "./exec.mts";
import { detectRepo, ensureIgnored, type Repo, repoRoot } from "./git.mts";
import { currentLogin, defaultBranch, openIssues } from "./github.mts";
import { type Level, message, Recorder } from "./observe.mts";
import { type Context, type IssueReport, processIssue } from "./pipeline.mts";
import { clearState, STATE_DIR } from "./state.mts";
import { formatSummary, type RunSummary } from "./summary.mts";

type Command = "run" | "init";

type Args = {
  command: Command;
  issue?: number;
  once: boolean;
  max?: number;
  help: boolean;
  json: boolean;
  reset: boolean;
  force: boolean;
  level: Level;
};

const USAGE = `next-issue [command] [options]

  init         write ${CONFIG_FILE} with the defaults

  --issue <n>  handle one issue only
  --once       stop after the first handled issue
  --max <n>    handle at most n issues
  --reset      drop the saved budgets and findings first
  --json       print the machine summary instead of the text one
  --force      replace an existing config file, with init
  --verbose    show every command and all agent output
  --quiet      show only the milestones and the summary
  --help       show this text
`;

function parseArgs(argv: string[]): Args {
  const args: Args = {
    command: "run",
    once: false,
    help: false,
    json: false,
    reset: false,
    force: false,
    level: "normal",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (index === 0 && !arg.startsWith("-")) {
      if (arg !== "init") {
        throw new Error(`Unknown command: ${arg}`);
      }
      args.command = "init";
    } else if (arg === "--force") {
      args.force = true;
    } else if (arg === "--json") {
      args.json = true;
    } else if (arg === "--help") {
      args.help = true;
    } else if (arg === "--reset") {
      args.reset = true;
    } else if (arg === "--once") {
      args.once = true;
    } else if (arg === "--verbose") {
      args.level = "verbose";
    } else if (arg === "--quiet") {
      args.level = "quiet";
    } else if (arg === "--issue") {
      args.issue = whole(argv[++index], arg);
    } else if (arg === "--max") {
      args.max = whole(argv[++index], arg);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function whole(value: string | undefined, option: string): number {
  const parsed = Number(value);
  if (value === undefined || !Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${option} needs a whole number of 1 or more`);
  }
  return parsed;
}

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
  const root = await repoRoot(process.cwd());
  if (args.command === "init") {
    return init(root, args.force);
  }
  const config = await loadConfig(root);
  const repo = await detectRepo(root, config.remote);
  const recorder = await Recorder.create(repo.root, args.level);
  setCommandObserver((record) => {
    recorder.event(
      record.code === 0 ? "command" : "command.fail",
      {
        cmd: `${record.command} ${record.args.join(" ")}`,
        code: record.code,
        ms: record.ms,
        stderr: record.stderr.length > 0 ? record.stderr : undefined,
      },
      record.code === 0 ? "verbose" : "quiet",
    );
  });

  try {
    return await handle(args, config, repo, recorder);
  } finally {
    await recorder.close();
  }
}

async function init(root: string, force: boolean): Promise<number> {
  const path = await writeDefaultConfig(root, force);
  await write(process.stdout, `wrote ${path}\n`);
  if (await ensureIgnored(root, `${STATE_DIR}/`)) {
    await write(process.stdout, `added ${STATE_DIR}/ to .gitignore\n`);
  }
  return 0;
}

async function handle(
  args: Args,
  config: Config,
  repo: Repo,
  recorder: Recorder,
): Promise<number> {
  const [base, login] = await Promise.all([defaultBranch(repo), currentLogin(repo)]);
  const context: Context = { repo, config, base, login, recorder };
  recorder.event(
    "run.start",
    { repo: `${repo.owner}/${repo.name}`, base, login, log: recorder.logFile },
    "quiet",
  );

  const issues = (await openIssues(repo, config.issueLimit)).filter(
    (issue) => args.issue === undefined || issue.number === args.issue,
  );
  recorder.event("issues", { open: issues.length }, "quiet");

  const reports: IssueReport[] = [];
  for (const issue of issues) {
    const handled = reports.filter((report) => report.outcome !== "skipped").length;
    if (args.max !== undefined && handled >= args.max) {
      break;
    }
    if (args.reset) {
      await clearState(repo, issue.number);
    }
    const report = await processIssue(context, issue);
    reports.push(report);
    if (args.once && report.outcome !== "skipped") {
      break;
    }
  }

  const summary: RunSummary = { ...recorder.summary(), issues: reports };
  recorder.event(
    "run.end",
    {
      done: count(reports, "done"),
      needsHuman: count(reports, "needs-human"),
      failed: count(reports, "error"),
      skipped: count(reports, "skipped"),
      tokens: summary.total.total,
    },
    "quiet",
  );
  const summaryFile = join(repo.root, STATE_DIR, "runs", `${recorder.runId}.summary.json`);
  await writeFile(summaryFile, `${JSON.stringify(summary, null, 2)}\n`);
  await write(process.stdout, args.json ? `${JSON.stringify(summary, null, 2)}\n` : formatSummary(summary));
  return count(reports, "needs-human") + count(reports, "error") > 0 ? 1 : 0;
}

function count(reports: IssueReport[], outcome: IssueReport["outcome"]): number {
  return reports.filter((report) => report.outcome === outcome).length;
}

main().then(
  (code) => process.exit(code),
  async (error: unknown) => {
    await write(process.stderr, `next-issue failed: ${message(error)}\n`);
    process.exit(1);
  },
);
