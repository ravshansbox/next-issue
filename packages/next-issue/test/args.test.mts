import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseArgs } from '../src/args.mts';

test('an empty command line gives the defaults', () => {
  const args = parseArgs([]);
  assert.equal(args.command, 'run');
  assert.equal(args.level, 'normal');
  assert.equal(args.max, undefined);
  assert.equal(args.once, false);
  assert.equal(args.merge, false);
});

test('a user who passes --merge asks for the merge', () => {
  assert.equal(parseArgs(['--merge']).merge, true);
});

test('a user who passes --watch asks to keep watching', () => {
  assert.equal(parseArgs([]).watch, false);
  assert.equal(parseArgs(['--watch']).watch, true);
});

test('a user who passes --agent gets an unknown argument error', () => {
  assert.throws(() => parseArgs(['--agent', 'pi']), /Unknown argument: --agent/);
});

test('the flags set their fields', () => {
  const args = parseArgs(['--once', '--reset', '--json', '--verbose']);
  assert.equal(args.once, true);
  assert.equal(args.reset, true);
  assert.equal(args.json, true);
  assert.equal(args.level, 'verbose');
});

test('the last level wins', () => {
  assert.equal(parseArgs(['--verbose', '--quiet']).level, 'quiet');
  assert.equal(parseArgs(['--quiet', '--verbose']).level, 'verbose');
});

test('an option with a value eats the next argument', () => {
  const args = parseArgs(['--max', '2', '--quiet']);
  assert.equal(args.max, 2);
  assert.equal(args.level, 'quiet');
});

test('a value that is not a whole number of 1 or more stops the run', () => {
  for (const value of ['0', '-1', '1.5', 'two', '']) {
    assert.throws(() => parseArgs(['--max', value]), /needs a whole number/);
  }
  assert.throws(() => parseArgs(['--max']), /needs a whole number/);
});

test('init, serve and stop are commands, and only in the first place', () => {
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
