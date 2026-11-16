import { CONFIG_FILE } from './config-fields.mts';

type Command = 'start' | 'init' | 'serve' | 'stop' | 'logs';

export type Args = {
  command?: Command;
  help: boolean;
  force: boolean;
  watch: boolean;
  hunt: boolean;
};

type Switch = 'help' | 'force' | 'watch' | 'hunt';

const SWITCHES = new Map<string, Switch>([
  ['--force', 'force'],
  ['--help', 'help'],
  ['--watch', 'watch'],
  ['--hunt', 'hunt'],
]);

export const USAGE = `next-issue <command> [options]

  start        start a run: claim issues, fix them and push them to the base branch
    --watch    keep running and read the issues again after each pass
    --hunt     hunt the repository for bugs and file issues alongside the issues, turns on --watch
  init         write ${CONFIG_FILE} with the defaults and add .next-issue/ and .worktrees/ to info/exclude
  serve        run the worker of this repository that pi extensions talk to
  stop         stop the worker of this repository
  logs         show the latest run log and follow it

  --force      replace an existing config file, with init
  --help       show this text
`;

const RUN_FLAGS = new Set(['--watch', '--hunt']);

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
    force: false,
    watch: false,
    hunt: false,
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

const OUTPUT_ONLY: Switch[] = ['force', 'help'];

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
