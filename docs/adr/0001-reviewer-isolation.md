# 1. Reviewer isolation

## Status

Accepted

## Context

The reviewer must read the worktree and run checks, but must not change
anything. Today three things keep it in line:

- `REVIEWING` in `packages/next-issue/src/agents.mts` removes the `edit` and
  `write` tools. The `bash` tool stays, because the reviewer needs it to run
  tests and read git history.
- The reviewer prompt in `packages/next-issue/src/prompts.mts` says: "Do not
  change a file. Do not write with git or gh."
- After the reviewer, `packages/next-issue/src/review.mts` calls
  `discardChanges`, which runs `git reset --hard` to the commit from before the
  review and `git clean -fd`.

These do not stop the reviewer's shell. It can run any command, with the
rights of the user, anywhere on the machine. `discardChanges` undoes changes in
the worktree only. It does not undo:

- changes outside the worktree, such as in the home folder or in other
  repositories;
- ignored files in the worktree, because `git clean -fd` leaves them;
- remote actions, such as `git push` or `gh` calls.

The implementer and the fixer have the same reach, and the prompt can hold text
from GitHub. The README "Safety" section describes that risk.

## Options

### A. Run the reviewer's shell in a container

Run each `bash` command of the reviewer in a container that mounts the
worktree read-only and has no network, or only the network that checks need.

- Pro: a real limit. The reviewer cannot change the worktree, the rest of the
  machine or the remote.
- Con: needs a container runtime (Docker, Podman) on every machine that runs
  the harness.
- Con: the container needs the same tool chain as the project (Node, package
  manager, build tools). Each repository may need its own image.
- Con: checks that write files (build output, caches, test snapshots) fail on a
  read-only mount, so the mount needs a writable overlay.
- Con: slower start for each command, and more code to keep.
- Con: does not help the implementer or the fixer, which have the same reach.

### B. Allow only a list of commands

Replace `bash` with a tool that runs a command only if it matches an allowlist,
such as `git log`, `git diff`, `npm test`.

- Pro: no new runtime; simple to add to the agent profile.
- Con: weak. Many allowed commands can run any code: `npm test` runs scripts
  from the repository, `git` runs hooks and aliases, `node -e` runs anything.
  A pattern match on the command line is easy to get round with pipes,
  subshells or quoting.
- Con: the list differs for each repository, so it needs config, and a
  reviewer that cannot run a needed check gives a worse verdict.

### C. Keep the current design and document it

Keep the smaller tool set, the prompt rule and `discardChanges`. State in the
README what they do and do not cover, and advise a container for the whole
harness when the issue authors are not trusted.

- Pro: no new code or runtime; the reviewer keeps every check it needs.
- Pro: one rule for all agents. The reviewer is no riskier than the
  implementer and the fixer, which need a full shell anyway.
- Con: no real limit. A reviewer that ignores its prompt can still change files
  outside the worktree, keep ignored files, or act on the remote.

## Decision

Option C. The reviewer keeps a full shell. The harness discards changes in the
worktree after each review, and the README states the limits and points to
this record.

Option B gives a false sense of safety for little gain. Option A is the real
fix, but it brings a runtime and a per-project image, and the implementer and
the fixer would still have the same reach. A container for the whole harness
covers all three agents with one step, and the user can add it without changes
to the harness.

## Consequences

- The reviewer can still change things outside the worktree. Only trust in the
  issue authors, the prompt rule, or a container around the whole harness
  prevents it.
- `discardChanges` stays the one guard in the code, and its limits (ignored
  files, remote actions) stay.
- If the harness later runs agents in a container, revisit this record. A
  container for all agents would cover the reviewer too.
