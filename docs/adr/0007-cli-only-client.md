# 7. The CLI as the only client

## Status

Accepted. Supersedes [ADR 0005](0005-one-worker-two-clients.md) and the plugin part of [ADR 0006](0006-claude-code-only.md).

## Context

Each repository has one worker, `next-issue serve`, and two clients: the `next-issue` CLI and the Claude Code plugin, `packages/claude-next-issue` ([ADR 0005](0005-one-worker-two-clients.md), [ADR 0006](0006-claude-code-only.md)).

The plugin keeps its own copy of the protocol (`packages/claude-next-issue/src/protocol.ts`) and of shared code, such as `TOOL_FIELDS` in `detail.ts`. Feature parity means each feature is built twice, and the two clients keep drifting apart.

The plugin also ships the `create-issue` and `answer-hand-over` skills (`packages/claude-next-issue/skills/`), which a user needs to write issues and answer hand-overs in Claude Code.

Several CLI instances, such as several Claude Code sessions in the same repository, must be able to talk to the run of that repository at the same time without conflict. With one client left, the worker could look removable: `next-issue start` could run the work in its own process.

## Options

### A. Keep two clients with feature parity

- Pro: no change; Claude Code users keep the dashboard.
- Con: each feature is built and tested twice, and the copies drift.

### B. Keep the plugin for the skills only

- Pro: skills install through the Claude Code plugin system.
- Con: a second package and release path, served from `.claude-plugin/marketplace.json`, only for two skills.
- Con: the skills and the CLI can be at different versions.

### C. The CLI as the only client, skills shipped in `next-issue`

- Pro: one client to build and test, and the protocol lives in one place.
- Pro: the skills ship with the same version as the CLI and the worker.
- Con: Claude Code users lose the dashboard.
- Con: `next-issue update` must install the skills where Claude Code finds them.

### D. No worker: each CLI instance runs the work in its own process

- Pro: no socket, protocol or worker upgrade code.
- Con: each instance needs lock files to share claims, landings and the base branch with the others, or a second instance must refuse to run.
- Con: no instance can follow, stop or switch a run that another started, and a run ends when its terminal closes.

## Decision

Option C.

- The `next-issue` CLI is the only kind of client of the worker.
- The worker stays, so that any number of CLI instances can talk to it at the same time without conflict. Option D is rejected.
- The Claude Code plugin, `packages/claude-next-issue`, and `.claude-plugin/marketplace.json` are removed.
- The `create-issue` and `answer-hand-over` skills ship in the `next-issue` package. `next-issue update` installs them and keeps them up to date.
- The worker still runs its agents with the Claude Agent SDK and takes Claude model IDs only ([ADR 0006](0006-claude-code-only.md)).

## Consequences

- New features need work only in the worker and the CLI.
- The root README, the `next-issue` README and `packages/next-issue/docs/behaviour.md` stop naming the plugin, and describe how to install the skills.
- `next-issue` stays the only package that the release job publishes.
- A known gap: a second `next-issue start` while a run is going exits with `a run is going in this repository already` instead of joining the run.
