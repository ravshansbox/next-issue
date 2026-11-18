# 3. Land changes without pull requests

## Status

Accepted

## Context

An agent reviews each change in its worktree (ADR 2). A pull request would add a second CI run and hold little but the verdict. Some repositories commit straight to the base branch, and CI there gates each deploy.

## Options

### A. Pull requests

- Pro: CI runs before a change lands, so the base branch stays green.
- Con: CI runs twice for each change when the pull request is merged.
- Con: does not fit a repository that forbids pull requests.

### B. Pull requests and direct commits

- Pro: each repository picks its flow.
- Con: two landing flows to build, test and keep.

### C. Direct commits only

- Pro: one CI run for each change.
- Pro: verdicts, hand-overs and answers all live on the issue.
- Con: CI runs after a change lands, so the base branch can be red until a fix or a revert lands.

## Decision

Option C.

- Each issue gets its own worktree and branch, so several issues can be worked on at once (`concurrency`).
- After the approval, the harness rebases the change onto the base branch as one commit, pushes it there and waits for its checks. Changes land one at a time, so each commit gets its own CI run.
- A red build goes to the fixer, and its fix lands the same way. When the fixer cannot fix it, the harness reverts the change and hands the issue over (ADR 5).

## Consequences

- The `checks` field in the config adds an optional local gate before the push.
- A direct push rules out GitHub branch protection with required reviews or required status checks.
