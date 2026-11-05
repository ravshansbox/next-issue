import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as protocol from '../../next-issue/src/protocol.mts';
import * as extension from '../src/protocol.ts';

type Same<Left, Right> = [Left] extends [Right] ? ([Right] extends [Left] ? true : false) : false;

const sameProgress: Same<extension.Progress, protocol.Progress> = true;
const sameClientMessage: Same<extension.ClientMessage, protocol.ClientMessage> = true;
const sameWorkerMessage: Same<extension.WorkerMessage, protocol.WorkerMessage> = true;

test('the extension declares the same message types as the worker', () => {
  assert.deepEqual([sameProgress, sameClientMessage, sameWorkerMessage], [true, true, true]);
});

test('the extension and the worker agree on which version is newer', () => {
  const versions = [
    '1.9.9',
    '2.0.0',
    '2.0.1',
    '2.9.0',
    '2.10.0',
    '2.5.0-beta',
    '2.5.0-beta.1',
    '2.5.0-beta.2',
    '2.5.0-beta.10',
    '2.5.1-alpha.1',
    '2.5.1',
  ];
  for (const candidate of versions) {
    for (const current of versions) {
      assert.equal(
        extension.isNewer(candidate, current),
        protocol.isNewer(candidate, current),
        `${candidate} against ${current}`,
      );
    }
  }
});
