# 6. Claude Code instead of pi

## Status

Accepted

## Context

The worker ran its agents with pi, and the `pi-next-issue` extension was a
client in pi. We want next-issue to work with Claude Code only.

## Options

### A. Move to Claude Code and remove pi

- Pro: one agent engine and one editor client to build and test.
- Con: pi users must move to Claude Code.

### B. Support both

- Pro: pi users keep working.
- Con: every feature needs work in two engines and three clients.

## Decision

Option A.

- The worker runs its agents with the Claude Agent SDK and takes Claude model
  IDs only (#561).
- The Claude Code plugin, `packages/claude-next-issue`, replaces the pi
  extension (#562). It is served from this repository by
  `.claude-plugin/marketplace.json`, not from npm.
- `packages/pi-next-issue` is removed, and `@ravshansbox/pi-next-issue` is
  deprecated on npm (#563).

## Consequences

- The clients are the `next-issue` CLI and the Claude Code plugin, see
  [ADR 0005](0005-one-worker-two-clients.md).
- `next-issue` is the only package that the release job publishes.
