# 6. Claude Code only

## Status

Accepted. The plugin part is superseded by [ADR 0007](0007-cli-only-client.md).

## Context

next-issue ran its agents with another coding agent and had an extension for
it. We want next-issue to work with Claude Code only.

## Options

### A. Claude Code only

- Pro: one agent engine and one editor client to build and test.
- Con: users of the other coding agent must move to Claude Code.

### B. Support both

- Pro: users of the other coding agent keep working.
- Con: every feature needs work in two engines and three clients.

## Decision

Option A.

- The worker runs its agents with the Claude Agent SDK and takes Claude model
  IDs only (#561).
- The Claude Code plugin, `packages/claude-next-issue`, is the editor client
  (#562). It is served from this repository by
  `.claude-plugin/marketplace.json`, not from npm.
- The old extension is removed, and its npm package is deprecated (#563).

## Consequences

- The clients are the `next-issue` CLI and the Claude Code plugin, see
  [ADR 0005](0005-one-worker-two-clients.md).
- `next-issue` is the only package that the release job publishes.
