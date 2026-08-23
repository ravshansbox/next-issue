# next-issue

A small harness that works through the open issues of a GitHub repository with
the pi SDK. Run it inside a git repository.

```bash
node /path/to/next-issue/src/cli.mts
```

## What it does

For each open issue, oldest first:

1. Skip the issue when a `status:done`, `status:needs-human` or `status:blocked`
   label is present, or when another person is the assignee.
2. Assign the issue to you and add `status:in-progress`.
3. Add a git worktree on a new `issue-<n>` branch from the default branch.
4. Let the implementer agent do the work, then commit and push.
5. Open a pull request that closes the issue.
6. Wait for the checks. On a failure, give the logs to the fixer agent.
7. Let the reviewer agent judge the diff. The reviewer must call the
   `submit_review` tool, and the harness puts the result on the pull request.
8. On approval, set `status:done`. The merge stays with you.
9. On a request for changes, run the fixer agent and go to step 6 again.
10. After `maxCycles`, set `status:needs-human` and stop work on that issue.

The harness runs all git and `gh` commands itself. The agents only read and
change files.

## Requirements

- Node 24 or later, for direct `.mts` execution
- `gh`, authenticated with write access to the repository
- Model credentials that the pi SDK can find

## Configuration

Put `next-issue.config.json` in the repository:

```json
{
  "maxCycles": 3,
  "checkIntervalSeconds": 15,
  "models": {
    "implementer": "anthropic/claude-sonnet-4-5",
    "reviewer": "anthropic/claude-opus-4-5:high",
    "fixer": "anthropic/claude-sonnet-4-5"
  }
}
```

Omit a model to use your pi default. State per issue goes to
`.next-issue/<issue>.json`, so a new run continues where the last run stopped.

## Options

| Option | Effect |
| --- | --- |
| `--issue <n>` | Handle one issue only |
| `--once` | Stop after the first handled issue |
| `--max <n>` | Handle at most n issues |
