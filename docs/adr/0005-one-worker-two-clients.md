# 5. One worker and two clients

## Status

Accepted

## Context

Each repository has one worker, `next-issue serve`
(`packages/next-issue/src/serve.mts`). It holds `.next-issue/worker.lock` and
listens on `.next-issue/worker.sock`. Two clients talk to it:

- the `next-issue` CLI. `next-issue start` reaches the worker through
  `reachWorker` (`packages/next-issue/src/worker-client.mts`) and follows the
  run in `packages/next-issue/src/start.mts`;
- the `pi-next-issue` extension (`packages/pi-next-issue/src/worker.ts`).

Both speak the protocol in `packages/next-issue/src/protocol.mts` and
`packages/pi-next-issue/src/protocol.ts`.

No record says so, and the two clients have drifted apart. There is no rule
to check a change against.

## Options

### A. Feature parity, shared behaviour in the worker

- Pro: a user gets the same features from either client.
- Pro: shared behaviour is built and tested once, in the worker.
- Con: each new feature needs work in both clients.

### B. No stated rule

- Pro: no change.
- Con: the clients keep drifting apart, and each change is judged anew.

## Decision

Option A.

- Each repository has one worker and two clients: the `next-issue` CLI and the
  `pi-next-issue` extension.
- The two clients keep feature parity. A feature that one client offers, the
  other offers too.
- Shared behaviour, such as updating the worker and starting a run again,
  lives in the worker, so the clients stay thin.

## Consequences

These known gaps break parity and are to be closed:

- `open` in `worker-client.mts` sends `hello` only when no run is going. pi
  always sends it (`worker.ts`, on `open`), so only pi gets an older worker
  updated between issues.
- Only pi starts a run again after an update (`resume` in `worker.ts`). This
  belongs in the worker.
- `requestUpgrade` in `packages/next-issue/src/worker-run.mts` leaves runs of
  `next-issue start` alone (`run.command`, from #527).
