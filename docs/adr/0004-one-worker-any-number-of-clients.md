# 4. One worker and any number of clients

## Status

Accepted

## Context

Several CLI instances, such as several Claude Code sessions in the same repository, must be able to talk to the run of that repository at the same time without conflict. They share one set of issues, one landing queue (ADR 3) and one base branch.

## Options

### A. One worker per repository

`next-issue serve` holds the run. The `next-issue` CLI is a client that talks to it over a socket in the repository.

- Pro: any number of clients can follow, stop and switch the same run.
- Pro: the run keeps going when a terminal closes.
- Con: a socket, a protocol and worker upgrades to build and keep.

### B. No worker: each CLI instance runs the work in its own process

- Pro: no socket, protocol or upgrade code.
- Con: each instance needs lock files to share claims, landings and the base branch, or a second instance must refuse to run.
- Con: no instance can follow, stop or switch a run that another started, and a run ends when its terminal closes.

### C. A worker with several kinds of client

An editor plugin next to the CLI.

- Pro: users get a dashboard in the editor.
- Con: each feature is built twice, and the clients drift apart.

## Decision

Option A.

- Each repository has one worker, which runs at most one run.
- The `next-issue` CLI is the only kind of client, and any number of its instances can talk to the worker at the same time.
- Shared behaviour, such as upgrading the worker and starting a run again, lives in the worker, so the client stays thin.
- The `create-issue` and `answer-hand-over` skills ship in the `next-issue` package, and `next-issue update` installs them.

## Consequences

- New features need work only in the worker and the CLI.
- `next-issue` is the only package that the release job publishes.
- A known gap: a second `next-issue start` while a run is going exits with `a run is going in this repository already` instead of joining the run.
