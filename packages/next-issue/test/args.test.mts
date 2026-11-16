import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseArgs } from '../src/args.mts';

test('a user who runs start with no flags gets the defaults', () => {
  const args = parseArgs(['start']);
  assert.equal(args.command, 'start');
  assert.equal(args.watch, false);
  assert.equal(args.hunt, false);
});

test('a user who passes --watch asks to keep watching', () => {
  assert.equal(parseArgs(['start']).watch, false);
  assert.equal(parseArgs(['start', '--watch']).watch, true);
});

test('start, init, serve and stop are commands, and only in the first place', () => {
  assert.equal(parseArgs(['start']).command, 'start');
  assert.throws(() => parseArgs(['--watch', 'start']), /Unknown argument: start/);
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

test('a user who passes --hunt asks to hunt and keeps watching', () => {
  assert.equal(parseArgs(['start']).hunt, false);
  const args = parseArgs(['start', '--hunt']);
  assert.equal(args.hunt, true);
  assert.equal(args.watch, true);
});

test('a user who passes a flag to serve gets an error that serve does not take it', () => {
  for (const argv of [['--hunt'], ['--watch'], ['--force']]) {
    assert.throws(
      () => parseArgs(['serve', ...argv]),
      new RegExp(`serve does not take ${argv[0]}`),
    );
  }
});

test('a user who passes an unknown flag or --help to serve gets the usual result', () => {
  assert.throws(() => parseArgs(['serve', '--unknown']), /Unknown argument: --unknown/);
  assert.equal(parseArgs(['serve', '--help']).help, true);
  assert.equal(parseArgs(['serve', '--help', '--hunt']).help, true);
});

test('a user who passes no argument gets no command', () => {
  assert.equal(parseArgs([]).command, undefined);
});

test('a user who passes a run flag with no command gets an error that says to use next-issue start', () => {
  for (const argv of [['--watch'], ['--hunt']]) {
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
  for (const command of ['init', 'stop', 'logs']) {
    for (const flag of ['--watch', '--hunt']) {
      assert.throws(
        () => parseArgs([command, flag]),
        new RegExp(`^Error: ${command} does not take ${flag}: it belongs to start$`),
      );
    }
  }
});
