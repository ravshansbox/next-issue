import { CONFIG_FILE } from "./config.mts";
import type { Level } from "./observe.mts";

export type Command = "run" | "init";

export type Args = {
  command: Command;
  once: boolean;
  max?: number;
  help: boolean;
  json: boolean;
  reset: boolean;
  force: boolean;
  level: Level;
};

export const USAGE = `next-issue [command] [options]

  init         write ${CONFIG_FILE} with the defaults

  --once       stop after the first handled issue
  --max <n>    handle at most n issues
  --reset      drop the saved budgets and findings first
  --json       print the machine summary instead of the text one
  --force      replace an existing config file, with init
  --verbose    show every command and all agent output
  --quiet      show only the milestones and the summary
  --help       show this text
`;

export function parseArgs(argv: string[]): Args {
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

