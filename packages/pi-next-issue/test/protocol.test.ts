import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as worker from '../src/worker.ts';
import * as protocol from '../../next-issue/src/protocol.mts';

type Same<Left, Right> = [Left] extends [Right] ? ([Right] extends [Left] ? true : false) : false;

const sameProgress: Same<worker.Progress, protocol.Progress> = true;
const sameClientMessage: Same<worker.ClientMessage, protocol.ClientMessage> = true;
const sameWorkerMessage: Same<worker.WorkerMessage, protocol.WorkerMessage> = true;

test('the extension declares the same message types as the worker', () => {
  assert.deepEqual([sameProgress, sameClientMessage, sameWorkerMessage], [true, true, true]);
});

test('the extension and the worker agree on which version is newer', () => {
  const versions = ['1.9.9', '2.0.0', '2.0.1', '2.9.0', '2.10.0'];
  for (const candidate of versions) {
    for (const current of versions) {
      assert.equal(
        worker.isNewer(candidate, current),
        protocol.isNewer(candidate, current),
        `${candidate} against ${current}`,
      );
    }
  }
});
