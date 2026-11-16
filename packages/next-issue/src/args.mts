import { CONFIG_FILE } from './config-fields.mts';
import type { Level } from './observe.mts';

type Command = 'start' | 'init' | 'serve' | 'stop' | 'logs';

export type Args = {
  command?: Command;
  max?: number;
  help: boolean;
  json: boolean;
  reset: boolean;
  force: boolean;
  watch: boolean;
  hunt: boolean;
  level: Level;
};

type Switch = 'help' | 'json' | 'reset' | 'force' | 'watch' | 'hunt';

const SWITCHES = new Map<string, Switch>([
  ['--force', 'force'],
  ['--json', 'json'],
  ['--help', 'help'],
  ['--watch', 'watch'],
  ['--hunt', 'hunt'],
  ['--reset', 'reset'],
]);

const LEVELS = new Map<string, Level>([
  ['--verbose', 'verbose'],
  ['--quiet', 'quiet'],
]);

export const USAGE = `next-issue <command> [options]

  start        start a run: claim issues, fix them and push them to the base branch
    --max <n>  handle at most n issues
    --watch    keep running and read the issues again after each pass
    --hunt     hunt the repository for bugs and file issues alongside the issues, turns on --watch
    --reset    drop the saved budgets and findings first
  init         write ${CONFIG_FILE} with the defaults and add .next-issue/ and .worktrees/ to info/exclude
  serve        run the worker of this repository that pi extensions talk to
  stop         stop the worker of this repository
  logs         show the latest run log and follow it

  --json       print the machine summary instead of the text one, or raw lines with logs
  --force      replace an existing config file, with init
  --verbose    show every command and all agent output
  --quiet      show only the milestones and the summary
  --help       show this text
`;

const RUN_FLAGS = new Set(['--max', '--watch', '--hunt', '--reset']);

export function parseArgs(argv: string[]): Args {
  const { args, flag, runFlag } = readArgs(argv);
  if (args.help) {
    return args;
  }
  if (args.command === undefined && flag !== undefined) {
    throw new Error(
      'no command given: use next-issue start to start a run, or see next-issue --help',
    );
  }
  if (args.command !== undefined && args.command !== 'start' && runFlag !== undefined) {
    throw new Error(`${args.command} does not take ${runFlag}: it belongs to start`);
  }
  if (args.command === 'serve' && flag !== undefined) {
    throw new Error(`serve does not take ${flag}`);
  }
  return args;
}

function readArgs(argv: string[]): { args: Args; flag?: string; runFlag?: string } {
  const args: Args = {
    help: false,
    json: false,
    reset: false,
    force: false,
    watch: false,
    hunt: false,
    level: 'normal',
  };
  let flag: string | undefined;
  let runFlag: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if ((index !== 0 || arg.startsWith('-')) && arg !== '--help') {
      flag ??= arg;
    }
    if (RUN_FLAGS.has(arg)) {
      runFlag ??= arg;
    }
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
  return { args, flag, runFlag };
}

function command(arg: string): Command {
  if (arg !== 'start' && arg !== 'init' && arg !== 'serve' && arg !== 'stop' && arg !== 'logs') {
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

const OUTPUT_ONLY: Switch[] = ['json', 'force', 'help'];

export function parseStartArgs(argv: string[]): Args {
  const { args } = readArgs(argv);
  if (args.command !== undefined) {
    throw new Error(`start does not take ${args.command}`);
  }
  const refused = OUTPUT_ONLY.find((name) => args[name]);
  if (refused !== undefined) {
    throw new Error(`start does not take --${refused}`);
  }
  return { ...args, command: 'start' };
}
