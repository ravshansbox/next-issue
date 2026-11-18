import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseArgs } from '../src/shared/args.mts';

test('a user who runs start with no flags gets a run that watches and does not hunt', () => {
  const args = parseArgs(['start']);
  assert.equal(args.command, 'start');
  assert.equal(args.watch, true);
  assert.equal(args.hunt, false);
});

test('a user who passes --watch on or off gets a run that watches or does one pass', () => {
  assert.equal(parseArgs(['start', '--watch', 'on']).watch, true);
  assert.equal(parseArgs(['start', '--watch', 'off']).watch, false);
});

test('a user who passes --watch or --hunt with no value or another value gets an error that says it takes on or off', () => {
  for (const flag of ['--watch', '--hunt']) {
    for (const rest of [[], ['yes'], ['--force']]) {
      assert.throws(
        () => parseArgs(['start', flag, ...rest]),
        new RegExp(`${flag} takes on or off`),
      );
    }
  }
});

test('a user who passes --hunt on with --watch off gets an error that says hunting needs watching', () => {
  for (const argv of [
    ['--hunt', 'on', '--watch', 'off'],
    ['--watch', 'off', '--hunt', 'on'],
  ]) {
    assert.throws(() => parseArgs(['start', ...argv]), /hunting needs watching/);
  }
});

test('a user who runs watch or hunt with on or off gets that command and value', () => {
  for (const command of ['watch', 'hunt'] as const) {
    assert.deepEqual(
      [parseArgs([command, 'on']).command, parseArgs([command, 'on']).on],
      [command, true],
    );
    assert.equal(parseArgs([command, 'off']).on, false);
  }
});

test('a user who runs watch or hunt with no value or another value gets an error that says it takes on or off', () => {
  for (const command of ['watch', 'hunt']) {
    for (const rest of [[], ['yes'], ['--force']]) {
      assert.throws(() => parseArgs([command, ...rest]), new RegExp(`${command} takes on or off`));
    }
    assert.throws(() => parseArgs([command, 'on', 'off']), /Unknown argument: off/);
  }
});

test('start, init, serve, stop, logs, watch and hunt are commands, and only in the first place', () => {
  assert.equal(parseArgs(['start']).command, 'start');
  assert.throws(() => parseArgs(['--watch', 'on', 'start']), /Unknown argument: start/);
  assert.equal(parseArgs(['stop']).command, 'stop');
  assert.equal(parseArgs(['init', '--force']).command, 'init');
  assert.throws(() => parseArgs(['--force', 'init']), /Unknown argument: init/);
  assert.throws(() => parseArgs(['run']), /Unknown command: run/);
  assert.equal(parseArgs(['serve']).command, 'serve');
});

test('an unknown option stops the run', () => {
  assert.throws(() => parseArgs(['--nope']), /Unknown argument: --nope/);
  assert.throws(() => parseArgs(['--issue', '7']), /Unknown argument: --issue/);
});

test('a user who passes --hunt on asks to hunt and keeps watching, and --hunt off turns hunting off', () => {
  const args = parseArgs(['start', '--hunt', 'on']);
  assert.equal(args.hunt, true);
  assert.equal(args.watch, true);
  assert.equal(parseArgs(['start', '--hunt', 'off']).hunt, false);
});

test('a user who passes a flag to serve gets an error that serve does not take it', () => {
  for (const argv of [['--hunt', 'on'], ['--watch', 'off'], ['--force']]) {
    assert.throws(
      () => parseArgs(['serve', ...argv]),
      new RegExp(`serve does not take ${argv[0]}`),
    );
  }
});

test('a user who passes an unknown flag or --help to serve gets the usual result', () => {
  assert.throws(() => parseArgs(['serve', '--unknown']), /Unknown argument: --unknown/);
  assert.equal(parseArgs(['serve', '--help']).help, true);
  assert.equal(parseArgs(['serve', '--help', '--hunt', 'on']).help, true);
});

test('a user who passes no argument gets no command', () => {
  assert.equal(parseArgs([]).command, undefined);
});

test('a user who passes a run flag with no command gets an error that says to use next-issue start', () => {
  for (const argv of [
    ['--watch', 'on'],
    ['--hunt', 'on'],
  ]) {
    assert.throws(() => parseArgs(argv), /no command given: use next-issue start/);
  }
});

test('a user who passes --help with or without start asks for the usage', () => {
  assert.equal(parseArgs(['--help']).help, true);
  const args = parseArgs(['start', '--help']);
  assert.equal(args.help, true);
  assert.equal(args.command, 'start');
});

test('a user who passes a run flag to another command gets an error that names the flag and says it belongs to start', () => {
  for (const command of ['init', 'stop', 'logs', 'watch', 'hunt']) {
    for (const flag of ['--watch', '--hunt']) {
      assert.throws(
        () => parseArgs([command, flag, 'on']),
        new RegExp(`^Error: ${command} does not take ${flag}: it belongs to start$`),
      );
    }
  }
});

test('a user who runs update with --scope user or project gets that scope, and with no --scope gets none', () => {
  assert.equal(parseArgs(['update']).command, 'update');
  assert.equal(parseArgs(['update']).scope, undefined);
  assert.equal(parseArgs(['update', '--scope', 'user']).scope, 'user');
  assert.equal(parseArgs(['update', '--scope', 'project']).scope, 'project');
});

test('a user who passes --scope with no value or another value gets an error that says it takes user or project', () => {
  for (const rest of [[], ['all'], ['--force']]) {
    assert.throws(() => parseArgs(['update', '--scope', ...rest]), /--scope takes user or project/);
  }
});

test('a user who passes --scope to another command gets an error that says it belongs to update', () => {
  for (const command of ['start', 'init', 'stop']) {
    assert.throws(
      () => parseArgs([command, '--scope', 'user']),
      new RegExp(`${command} does not take --scope: it belongs to update`),
    );
  }
});
