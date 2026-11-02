import assert from "node:assert/strict";
import { test } from "node:test";
import { listenForInterrupts } from "../src/interrupt.mts";

test("a user who presses Ctrl-C during a wait ends the wait at once", async () => {
  const said: string[] = [];
  const interrupts = listenForInterrupts((text) => said.push(text));
  const waited = interrupts.sleep(60_000);
  process.emit("SIGINT");
  assert.equal(await waited, false);
  assert.deepEqual(said, ["Stopping now."]);
  assert.equal(await interrupts.sleep(60_000), false);
});

test("a wait with no Ctrl-C runs to its end", async () => {
  const interrupts = listenForInterrupts(() => undefined);
  assert.equal(await interrupts.sleep(1), true);
});
