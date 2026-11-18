# 7. Agent isolation

## Status

Accepted

## Context

The implementer and the fixer must edit files and run any command a project needs. The reviewer and the hunter must not change anything, but need a shell to run tests and read git history. Every agent runs with the rights of the user.

## Options

### A. A container for each agent shell

- Pro: a real limit on what an agent can reach.
- Con: needs a container runtime and an image with the tools of each project.
- Con: checks that write files fail on a read-only mount, and each command starts slower.

### B. An allowlist of commands

- Pro: no new runtime.
- Con: weak: `npm test`, `git` hooks and `node -e` run any code, and pipes or quoting get round a pattern match.
- Con: the list differs for each repository.

### C. A full shell, with the limits documented

- Pro: no new code or runtime, and each agent keeps every check it needs.
- Con: no real limit.

## Decision

Option C.

- The implementer and the fixer have every tool, with permission checks off.
- The reviewer and the hunter cannot write or edit files, but keep a full shell. Their prompts tell them to change nothing.
- After each review, the harness resets the worktree to the commit from before the review.
- The docs state the limits and advise running the whole harness in a container, which covers every agent at once.

## Consequences

- An agent can still change files outside its worktree, keep ignored files and act on the remote with the user's `git` and `gh` rights.
- Only trust in the people with write access (ADR 6) or a container around the harness prevents it.
