import { CONFIG_FILE } from './config-fields.mts';

type Command = 'start' | 'init' | 'serve' | 'stop' | 'status' | 'logs' | 'watch' | 'hunt';

export type Scope = 'user' | 'project';

export type Args = {
  command?: Command;
  help: boolean;
  force: boolean;
  watch: boolean;
  hunt: boolean;
  on?: boolean;
  scope?: Scope;
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

const COMMANDS: Command[] = ['start', 'init', 'serve', 'stop', 'status', 'logs', 'watch', 'hunt'];

export const USAGE = `npx -y next-issue@latest <command> [options]

  start             start a run: claim issues, fix them and push them to the base branch
    --watch on|off  on: read the issues again after each pass; off: do one pass and end (default on)
    --hunt on|off   hunt the repository for bugs and file issues alongside the issues, needs watching (default off)
  watch on|off      switch watching of the going run; off also turns hunting off
  hunt on|off       switch hunting of the going run; on also turns watching on
  init              set up the repository: write ${CONFIG_FILE}, add .next-issue/ and .worktrees/ to info/exclude and install the skills; run it again after an upgrade
    --scope user|project
                    user: in ~/.claude/skills; project: in .claude/skills of the main worktree (asks when not given)
  stop              stop the going run after its current issues
  status            show the going run, its worker and its running issues
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
      'no command given: use npx -y next-issue@latest start to start a run, or see npx -y next-issue@latest --help',
    );
  }
  if (args.command !== undefined && args.command !== 'start' && runFlag !== undefined) {
    throw new Error(`${args.command} does not take ${runFlag}: it belongs to start`);
  }
  if (args.command !== undefined && args.command !== 'init' && args.scope !== undefined) {
    throw new Error(`${args.command} does not take --scope: it belongs to init`);
  }
  if ((args.command === 'watch' || args.command === 'hunt') && args.on === undefined) {
    throw new Error(`${args.command} takes on or off`);
  }
  if (args.command !== undefined && args.command !== 'init' && args.force) {
    throw new Error(`${args.command} does not take --force: it belongs to init`);
  }
  return args;
}

function onOffValue(name: string, value: string | undefined): boolean {
  if (value !== 'on' && value !== 'off') {
    throw new Error(`${name} takes on or off`);
  }
  return value === 'on';
}

function scopeValue(value: string | undefined): Scope {
  if (value !== 'user' && value !== 'project') {
    throw new Error('--scope takes user or project');
  }
  return value;
}

type RunFlags = Partial<Record<RunFlag, boolean>>;

function readArgs(passed: string[]): {
  args: Args;
  flag?: string;
  runFlag?: string;
  given: RunFlags;
} {
  const argv = passed[0] === '--help' ? [...passed.slice(1), '--help'] : passed;
  const args: Args = {
    help: false,
    force: false,
    watch: true,
    hunt: false,
  };
  const given: RunFlags = {};
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
    } else if (arg === '--scope') {
      index += 1;
      args.scope = scopeValue(argv[index]);
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
  return { args, flag, runFlag, given };
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
  if (args.scope !== undefined) {
    throw new Error('start does not take --scope');
  }
  const refused = OUTPUT_ONLY.find((name) => args[name]);
  if (refused !== undefined) {
    throw new Error(`start does not take --${refused}`);
  }
  return { ...args, command: 'start' };
}

export function givenStartFlags(argv: string[]): RunFlags {
  parseStartArgs(argv);
  return readArgs(argv).given;
}
