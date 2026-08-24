# next-issue

A small harness that works through the open issues of a GitHub repository with
the Claude Agent SDK. Run it inside a git repository.

```bash
npx next-issue
```

Or install it once:

```bash
npm install -g next-issue
next-issue
```

## What it does

For each open issue, oldest first:

1. Skip the issue when a `status:done`, `status:needs-human` or `status:blocked`
   label is present, or when another person is the assignee.
2. Assign the issue to you and add `status:in-progress`.
3. Add a git worktree on a new `issue-<n>` branch from the default branch.
4. Let the implementer agent do the work, then commit and push.
5. Open a pull request that closes the issue.
6. Wait for the checks. A pending state waits again, up to
   `checkTimeoutMinutes`. A repository without checks goes straight to the
   review.
7. On a red build, give the failed job logs to the fixer agent, then go to step
   6 again. The budget is `maxCiFixes`.
8. Let the reviewer agent judge the diff. The reviewer returns a structured
   verdict that rates each finding `blocking` or `minor`. The harness puts the
   result on the pull request.
9. No blocking finding means approval: set `status:done`. The merge stays with
   you.
10. With a blocking finding, run the fixer agent and go to step 6 again. The
    budget is `maxReviewRounds`.

## Stops for a loop

The harness hands the issue to a person, with the `status:needs-human` label,
when:

- the check budget or the review budget runs out;
- a fixer round adds no commit, so there is no progress;
- the reviewer repeats a finding set from an earlier round, which shows a
   ping-pong between the fixer and the reviewer;
- the reviewer gives no verdict, or the checks do not finish in time;
- a step of the run fails with an error.

The fixer sees the findings of all earlier rounds, not only the last one. From
round two, the reviewer judges only the earlier findings and any regression.

The harness runs all git and `gh` commands itself. The agents only read and
change files. The commit holds all the changes in the worktree, so a setup
command that writes a file outside `.gitignore` puts that file in the commit.

## Safety

The implementer and the fixer run with the permission checks off. They can run
any command in the worktree. The prompt holds the title, the body and the
comments of the issue, which come from GitHub.

Thus a person who can write an issue or a comment can try to give an
instruction to the agent. Use the harness only on a repository where you trust
the issue authors, or run it in a container.

## Observability

Every run has an id, `<timestamp>`, and writes two files under
`.next-issue/runs/`:

- `<id>.jsonl` — one JSON object per event, with `ts`, `runId`, `kind`, and the
  `issue`, `role` or `round` in scope;
- `<id>.summary.json` — token totals per agent role, event counts, and
  one report per issue with the outcome, the reason, the pull request number
  and the budgets used.

The summary also goes to standard output, so the harness fits in a pipe. All
progress goes to standard error.

Recorded for each step: `claim`, `comments`, `worktree`, `implement`, `push`,
`pull-request`, `checks`, `review` and `fix`, each with a `.start`, `.end` or
`.error` event and a duration in `ms`. Every `git` and `gh` command is recorded
with its exit code and duration. Each agent call adds a `usage` event with the
tokens, the cost estimate in dollars, the turn count, the tool-call count, the
model and the session id, so you can open the session again and read the full
transcript.

```bash
jq -r 'select(.kind=="usage") | [.issue,.role,.turns,.total] | @tsv' \
  .next-issue/runs/*.jsonl
```

Three levels of console output:

| Level | Shows |
| --- | --- |
| `--quiet` | Run and issue milestones, verdicts, hand-overs, errors |
| default | The above plus each step end, each tool call and failed commands |
| `--verbose` | The above plus every command and all agent text |

## Requirements

- Node 24 or later, because the command runs the TypeScript source directly
- `gh`, authenticated with write access to the repository
- Anthropic credentials for the Claude Agent SDK: `ANTHROPIC_API_KEY`, or a
  Claude subscription login

## Configuration

To write the file with the defaults, run the `init` command in the repository:

```bash
npx next-issue init
```

The command writes `next-issue.config.json` in the root of the repository and
adds `.next-issue/` to `.gitignore`. It stops when the config file is there
already; `--force` replaces it. The file holds no `setupCommand`, because that
field has no default.

A field that is not in the file keeps its default. A file that is not valid
JSON stops the run.

```json
{
  "remote": "origin",
  "issueLimit": 100,
  "maxCiFixes": 3,
  "maxReviewRounds": 3,
  "checkIntervalSeconds": 15,
  "checkTimeoutMinutes": 60,
  "logMaxChars": 20000,
  "setupCommand": "npm ci",
  "models": {
    "implementer": "claude-opus-5",
    "reviewer": "claude-opus-5",
    "fixer": "claude-opus-5"
  },
  "labels": {
    "ready": "status:todo",
    "inProgress": "status:in-progress",
    "inReview": "status:in-review",
    "done": "status:done",
    "needsHuman": "status:needs-human",
    "skip": "status:blocked"
  }
}
```

| Field | Default | Effect |
| --- | --- | --- |
| `remote` | `origin` | The git remote for the repository and the branches |
| `issueLimit` | `100` | The maximum number of open issues to read |
| `maxCiFixes` | `3` | The budget for check fixes per issue |
| `maxReviewRounds` | `3` | The budget for review rounds per issue |
| `checkIntervalSeconds` | `15` | The time between two check states |
| `checkTimeoutMinutes` | `60` | The limit for one check wait |
| `logMaxChars` | `20000` | The maximum length of the failed job logs |
| `setupCommand` | none | A shell command to run in a new worktree, before the implementer |
| `models` | `{}` | The model per agent role |
| `labels` | see above | The names of the labels that the harness sets |

A role without an entry in `models` uses the default model of the SDK. A
`setupCommand` that fails hands the issue to a person. State per issue goes to
`.next-issue/<issue>.json`, so a new run continues where the last run stopped.

## Commands and options

| Argument | Effect |
| --- | --- |
| `init` | Write the config file with the defaults |
| `--force` | Replace an existing config file, with `init` |
| `--issue <n>` | Handle one issue only |
| `--once` | Stop after the first handled issue |
| `--max <n>` | Handle at most n issues |
| `--reset` | Drop the saved budgets and findings first |
| `--verbose` | Show every command and all agent output |
| `--quiet` | Show only the milestones and the summary |
| `--help` | Show the option list |

## Development

```bash
npm install
npm run typecheck
npm test
```
