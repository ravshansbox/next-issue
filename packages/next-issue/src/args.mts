import { CONFIG_FILE } from './config-fields.mts';
import type { Level } from './observe.mts';

type Command = 'run' | 'init' | 'serve' | 'stop' | 'logs';

export type Args = {
  command: Command;
  once: boolean;
  max?: number;
  help: boolean;
  json: boolean;
  reset: boolean;
  force: boolean;
  watch: boolean;
  hunt: boolean;
  level: Level;
};

type Switch = 'once' | 'help' | 'json' | 'reset' | 'force' | 'watch' | 'hunt';

const SWITCHES = new Map<string, Switch>([
  ['--force', 'force'],
  ['--json', 'json'],
  ['--help', 'help'],
  ['--watch', 'watch'],
  ['--hunt', 'hunt'],
  ['--reset', 'reset'],
  ['--once', 'once'],
]);

const LEVELS = new Map<string, Level>([
  ['--verbose', 'verbose'],
  ['--quiet', 'quiet'],
]);

export const USAGE = `next-issue [command] [options]

  init         write ${CONFIG_FILE} with the defaults
  serve        run the worker of this repository that pi extensions talk to
  stop         stop the worker of this repository
  logs         show the latest run log and follow it

  --once       stop after the first handled issue
  --max <n>    handle at most n issues
  --watch      keep running and read the issues again after each pass
  --hunt       hunt the repository for bugs and file issues alongside the issues, turns on --watch
  --reset      drop the saved budgets and findings first
  --json       print the machine summary instead of the text one, or raw lines with logs
  --force      replace an existing config file, with init
  --verbose    show every command and all agent output
  --quiet      show only the milestones and the summary
  --help       show this text
`;

export function parseArgs(argv: string[]): Args {
  const args: Args = {
    command: 'run',
    once: false,
    help: false,
    json: false,
    reset: false,
    force: false,
    watch: false,
    hunt: false,
    level: 'normal',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (index === 0 && !arg.startsWith('-')) {
      args.command = command(arg);
    } else if (SWITCHES.has(arg)) {
      args[SWITCHES.get(arg)!] = true;
    } else if (LEVELS.has(arg)) {
      args.level = LEVELS.get(arg)!;
    } else if (arg === '--max') {
      args.max = whole(argv[++index], arg);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  args.watch ||= args.hunt;
  return args;
}

function command(arg: string): Command {
  if (arg !== 'init' && arg !== 'serve' && arg !== 'stop' && arg !== 'logs') {
    throw new Error(`Unknown command: ${arg}`);
  }
  return arg;
}

function whole(value: string | undefined, option: string): number {
  const parsed = Number(value);
  if (value === undefined || !Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${option} needs a whole number of 1 or more`);
  }
  return parsed;
}
