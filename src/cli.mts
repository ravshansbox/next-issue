#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createModelRuntime } from "./agents.mts";
import { loadConfig } from "./config.mts";
import { setCommandObserver } from "./exec.mts";
import { detectRepo } from "./git.mts";
import { currentLogin, defaultBranch, openIssues } from "./github.mts";
import { type Level, message, Recorder } from "./observe.mts";
import { type Context, type IssueReport, processIssue } from "./pipeline.mts";
import { clearState } from "./state.mts";

type Args = {
  issue?: number;
  once: boolean;
  max?: number;
  help: boolean;
  reset: boolean;
  level: Level;
};

const USAGE = `next-issue [options]

  --issue <n>  handle one issue only
  --once       stop after the first handled issue
  --max <n>    handle at most n issues
  --reset      drop the saved budgets and findings first
  --verbose    show every command and all agent output
  --quiet      show only the milestones and the summary
  --help       show this text
`;

function parseArgs(argv: string[]): Args {
  const args: Args = { once: false, help: false, reset: false, level: "normal" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--help") {
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

  const [base, login, modelRuntime] = await Promise.all([
    defaultBranch(repo),
    currentLogin(repo),
    createModelRuntime(),
  ]);
  const context: Context = { repo, config, base, login, modelRuntime, recorder };
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

  const summary = { ...recorder.summary(), issues: reports };
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
  const summaryFile = join(repo.root, ".next-issue", "runs", `${recorder.runId}.summary.json`);
  await writeFile(summaryFile, `${JSON.stringify(summary, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  await recorder.close();
  return count(reports, "needs-human") + count(reports, "error") > 0 ? 1 : 0;
}

function count(reports: IssueReport[], outcome: IssueReport["outcome"]): number {
  return reports.filter((report) => report.outcome === outcome).length;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`next-issue failed: ${message(error)}\n`);
    process.exit(1);
  },
);
