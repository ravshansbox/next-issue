# 1. Claude Code only

## Status

Accepted

## Context

The harness needs an agent engine to run its agents. Supporting more than one engine means each feature is built and tested once for each engine.

## Options

### A. Claude Code only

- Pro: one engine to build and test.
- Con: users of other coding agents must use Claude Code.

### B. Several engines

- Pro: users keep the coding agent they have.
- Con: each feature needs work in each engine, and the engines drift apart.

## Decision

Option A. The worker runs its agents with the Claude Agent SDK and takes Claude model IDs only.

## Consequences

- A user needs Claude Code, logged in.
- The `create-issue` and `answer-hand-over` skills are Claude Code skills.
