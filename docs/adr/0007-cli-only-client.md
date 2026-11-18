# 7. The CLI as the only client

## Status

Accepted. Supersedes [ADR 0005](0005-one-worker-two-clients.md) and the plugin part of [ADR 0006](0006-claude-code-only.md).

## Context

Each repository has one worker, `next-issue serve`, and two clients: the `next-issue` CLI and the Claude Code plugin, `packages/claude-next-issue` ([ADR 0005](0005-one-worker-two-clients.md), [ADR 0006](0006-claude-code-only.md)).

The plugin keeps its own copy of the protocol (`packages/claude-next-issue/src/protocol.ts`) and of shared code, such as `TOOL_FIELDS` in `detail.ts`. Feature parity means each feature is built twice, and the two clients keep drifting apart.

The plugin also ships the `create-issue` and `answer-hand-over` skills (`packages/claude-next-issue/skills/`), which a user needs to write issues and answer hand-overs in Claude Code.

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

## Decision

Option C.

- The `next-issue` CLI is the only client of the worker.
- The Claude Code plugin, `packages/claude-next-issue`, and `.claude-plugin/marketplace.json` are removed.
- The `create-issue` and `answer-hand-over` skills ship in the `next-issue` package. `next-issue update` installs them and keeps them up to date.
- The worker still runs its agents with the Claude Agent SDK and takes Claude model IDs only ([ADR 0006](0006-claude-code-only.md)).

## Consequences

- New features need work only in the worker and the CLI.
- The root README, the `next-issue` README and `packages/next-issue/docs/behaviour.md` stop naming the plugin, and describe how to install the skills.
- `next-issue` stays the only package that the release job publishes.
