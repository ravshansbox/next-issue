# 3. Land changes without pull requests

## Status

Accepted

## Context

The harness opens a pull request for each issue. With `--merge` it
squash-merges the pull request after the review, so CI runs twice: on the
pull request and again on the base branch after the merge.

The review is done by an agent in the worktree. The pull request only holds
the verdict, the hand-overs and the answers to them.

The one user of the harness works on repositories that commit straight to the
base branch, and the tests in CI gate each deploy there.

## Options

### A. Keep pull requests

- Pro: CI runs before a change lands, so the base branch stays green.
- Pro: no code change.
- Con: with `--merge`, CI runs twice for each change.
- Con: does not fit a repository that forbids pull requests.

### B. Add direct commits next to pull requests

- Pro: each repository picks the flow it wants.
- Con: two landing flows to build, test and keep.

### C. Replace pull requests with direct commits

Each issue still gets its own worktree and branch, and `concurrency` still
runs several issues at once. After the approval, the harness rebases the
branch onto the base branch, pushes it there and waits for CI. Approved
changes land one at a time: the next one waits until the CI of the last one
ends, so each commit gets its own CI run.

- Pro: one CI run for each change.
- Pro: less code: no pull request, draft or merge code, and no `--merge`.
- Pro: verdicts, hand-overs and answers all live on the issue.
- Con: CI runs after a change lands, so the base branch can be red until a
  fix or a revert lands.
- Con: a breaking change for both packages.

## Decision

Option C. The review is already done by an agent in the worktree, so a pull
request adds a second CI run and little else, and `concurrency` keeps the
issues working in parallel.

## Consequences


- The pull request and merge code, `--merge` and `draftPullRequest` go, and
  [ADR 0002](0002-merge-setting.md) no longer applies.
- A red CI run on the base branch goes to the fixer, from the check budget,
  and its fix lands like any other change. When the fixer cannot fix it, the
  harness reverts the change and hands the issue to a person.
- A conflict in the rebase goes to the fixer, as a merge conflict does today.
- Hand-overs and the answers to them move from the pull request to the issue.
- The pi extension stops sending `merge`, and the `questions` message of the
  worker drops the pull request.
- Both packages get a new major version.
