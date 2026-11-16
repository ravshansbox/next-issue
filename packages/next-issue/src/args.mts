import { CONFIG_FILE } from './config-fields.mts';

type Command = 'start' | 'init' | 'serve' | 'stop' | 'logs' | 'watch' | 'hunt';

export type Args = {
  command?: Command;
  help: boolean;
  force: boolean;
  watch: boolean;
  hunt: boolean;
  on?: boolean;
};

type Switch = 'help' | 'force';

type RunFlag = 'watch' | 'hunt';

const SWITCHES = new Map<string, Switch>([
  ['--force', 'force'],
  ['--help', 'help'],
]);

const RUN_FLAGS = new Map<string, RunFlag>([
  ['--watch', 'watch'],
  ['--hunt', 'hunt'],
]);

const COMMANDS: Command[] = ['start', 'init', 'serve', 'stop', 'logs', 'watch', 'hunt'];

export const USAGE = `next-issue <command> [options]

  start             start a run: claim issues, fix them and push them to the base branch
    --watch on|off  on: read the issues again after each pass; off: do one pass and end (default on)
    --hunt on|off   hunt the repository for bugs and file issues alongside the issues, needs watching (default off)
  watch on|off      switch watching of the going run; off also turns hunting off
  hunt on|off       switch hunting of the going run; on also turns watching on
  init              write ${CONFIG_FILE} with the defaults and add .next-issue/ and .worktrees/ to info/exclude
  serve             run the worker of this repository that pi extensions talk to
  stop              stop the worker of this repository
  logs              show the latest run log and follow it

  --force           replace an existing config file, with init
  --help            show this text
`;

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
  if ((args.command === 'watch' || args.command === 'hunt') && args.on === undefined) {
    throw new Error(`${args.command} takes on or off`);
  }
  return args;
}

function onOffValue(name: string, value: string | undefined): boolean {
  if (value !== 'on' && value !== 'off') {
    throw new Error(`${name} takes on or off`);
  }
  return value === 'on';
}

function readArgs(argv: string[]): { args: Args; flag?: string; runFlag?: string } {
  const args: Args = {
    help: false,
    force: false,
    watch: true,
    hunt: false,
  };
  const given: Partial<Record<RunFlag, boolean>> = {};
  let flag: string | undefined;
  let runFlag: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if ((index !== 0 || arg.startsWith('-')) && arg !== '--help') {
      flag ??= arg;
    }
    if (index === 0 && !arg.startsWith('-')) {
      args.command = command(arg);
    } else if (
      index === 1 &&
      (args.command === 'watch' || args.command === 'hunt') &&
      !arg.startsWith('-')
    ) {
      args.on = onOffValue(args.command, arg);
    } else if (SWITCHES.has(arg)) {
      args[SWITCHES.get(arg)!] = true;
    } else if (RUN_FLAGS.has(arg)) {
      runFlag ??= arg;
      index += 1;
      given[RUN_FLAGS.get(arg)!] = onOffValue(arg, argv[index]);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (given.hunt === true && given.watch === false) {
    throw new Error('hunting needs watching: --hunt on does not go with --watch off');
  }
  args.watch = given.watch ?? true;
  args.hunt = given.hunt ?? false;
  return { args, flag, runFlag };
}

function command(arg: string): Command {
  const found = COMMANDS.find((name) => name === arg);
  if (found === undefined) {
    throw new Error(`Unknown command: ${arg}`);
  }
  return found;
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
