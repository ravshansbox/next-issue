# next-issue

A small harness that works through the open issues of a GitHub repository with
the Claude Agent SDK. Run it inside a git repository.

```bash
npx -y next-issue@latest
```

Or install it once:

```bash
npm install -g next-issue@latest
next-issue
```

## What it does

For each open issue, oldest first:

1. Claim the issue only when it holds the `status:todo` label, holds no
   `status:in-progress` or `status:in-review` label, and has no assignee. A
   `status:done`, `status:needs-human` or `status:blocked` label always stops
   the claim. An issue with saved state under `.next-issue/` resumes instead,
   whatever its labels, unless another person is now the assignee.
2. Assign the issue to you and add `status:in-progress`.
3. Fetch the default branch, fast-forward the local copy of it when that is
   safe, then add a git worktree on a new `issue-<n>` branch from it.
4. Let the implementer agent do the work, then commit and push.
5. Open a draft pull request that closes the issue.
6. Wait for the checks. A pending state waits again, up to
   `checkTimeoutMinutes`. A repository that reports no check keeps asking for
   `checkGraceSeconds`, because a new pull request often shows no check yet,
   and only then goes straight to the review.
7. On a red build, give the failed job logs to the fixer agent, then go to step
   6 again. The budget is `maxCiFixes`.
8. Let the reviewer agent judge the diff, at most `diffMaxChars` of it. The
   reviewer returns a structured verdict that rates each finding `blocking` or
   `minor`. The harness puts the result on the pull request.
9. No blocking finding means approval: mark the pull request ready for review
   and set `status:done`. The merge stays with you. A blocking finding always
   stops the approval, even when the reviewer also says approve.
10. With a blocking finding, run the fixer agent and go to step 6 again. The
    budget is `maxReviewRounds`.

## Stops for a loop

The harness hands the issue to a person, with the `status:needs-human` label,
when:

- the check budget or the review budget runs out;
- a fixer round adds no commit, so there is no progress;
- the fixer reports that the checks fail for a reason the change did not cause,
   such as a test already broken on the base branch or one that fails only under
   load. It changes nothing and the reason reaches the pull request, rather than
   the fixer spending its whole budget on a failure it cannot fix;
- the reviewer repeats a finding set from an earlier round, which shows a
   ping-pong between the fixer and the reviewer;
- the reviewer gives no verdict, or the checks do not finish in time;
- an agent does not finish in `agentTimeoutMinutes`;
- the setup command fails, or does not finish in `setupTimeoutMinutes`;
- a step of the run fails with an error.

The fixer sees the findings of all earlier rounds, not only the last one. From
round two, the reviewer judges only the earlier findings and any regression.

## Stop after the current issue

Run `touch .next-issue/stop` in a second terminal. The harness reads the file
only between two issues, finishes the issue that it holds, deletes the file and
then writes the summary as usual. A file from an earlier run is dropped at the
start, so it stops nothing.

`Ctrl-C` is different: the terminal signals every child too, so the run dies in
the middle of a step. The saved state lets the next run continue the issue, but
the issue keeps `status:in-progress` and the run writes no summary.

Every status label that the harness puts on the issue goes on the pull request
too, from the first review round. Thus a draft pull request shows work that the
harness has not finished, and a `status:needs-human` pull request shows work
that waits for a person.

The harness runs all git and `gh` commands itself. The agents only read and
change files. The commit holds all the changes in the worktree, so a setup
command that writes a file outside `.gitignore` puts that file in the commit.

## Safety

The implementer and the fixer run with the permission checks off. They start in
the worktree, but nothing holds them there: they can run any command, with your
rights, anywhere on the machine. The prompt holds the title, the body and the
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

A short text summary of the same data goes to standard output. Use `--json` to
get the full summary object there instead, so the harness fits in a pipe. All
progress goes to standard error.

Recorded for each step: `claim`, `comments`, `worktree`, `implement`, `push`,
`pull-request`, `checks`, `review` and `fix`, each with a `.start`, `.end` or
`.error` event and a duration in `ms`. Every `git` and `gh` command is recorded
with its exit code and duration. A `tool` event holds the tool name, and for a
`Bash` tool the command too. Each agent call adds a `usage` event with the
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
npx -y next-issue@latest init
```

The command writes `next-issue.config.json` in the root of the repository and
adds `.next-issue/` to `.gitignore`. It stops when the config file is there
already; `--force` replaces it. The file holds no `setupCommand`, because that
field has no default.

A field that is not in the file keeps its default. A file that is not valid
JSON, a field with a value of the wrong type and a field name that the harness
does not know all stop the run, so a typo cannot pass without a word.

```json
{
  "remote": "origin",
  "issueLimit": 100,
  "maxCiFixes": 3,
  "maxReviewRounds": 3,
  "checkIntervalSeconds": 15,
  "checkGraceSeconds": 60,
  "checkTimeoutMinutes": 60,
  "agentTimeoutMinutes": 30,
  "setupTimeoutMinutes": 15,
  "commandTimeoutMinutes": 10,
  "logMaxChars": 20000,
  "diffMaxChars": 60000,
  "draftPullRequest": true,
  "models": {},
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
| `checkGraceSeconds` | `60` | The time to wait for the first check to show |
| `checkTimeoutMinutes` | `60` | The limit for one check wait |
| `agentTimeoutMinutes` | `30` | The limit for one agent call |
| `setupTimeoutMinutes` | `15` | The limit for the setup command |
| `commandTimeoutMinutes` | `10` | The limit for one `git` or `gh` command |
| `logMaxChars` | `20000` | The maximum length of the failed job logs |
| `diffMaxChars` | `60000` | The maximum length of the diff that the reviewer reads |
| `draftPullRequest` | `true` | Open the pull request as a draft, until the review approves |
| `setupCommand` | none | A shell command to run in a new worktree, before the implementer |
| `models` | `{}` | The model per agent role |
| `labels` | see above | The names of the labels that the harness reads and sets |

An empty `labels.ready` turns the ready requirement off. The harness then
claims every open issue that no other label and no assignee holds back.

The log gives the reason for a skipped issue as `stop-label`, `not-ready`,
`in-flight` or `assigned`.

A role without an entry in `models` uses the default model of the SDK. A
`setupCommand` that fails, or that does not finish in `setupTimeoutMinutes`,
hands the issue to a person. The wait for the checks has its own limit, so
`commandTimeoutMinutes` holds for every other `git` and `gh` command. State per
issue goes to `.next-issue/<issue>.json`, so a new run continues where the last
run stopped.

## Retry an issue that waits for a person

A hand-over leaves the state file with the used budgets in it, so the next run
would hand the issue over again at once. To give the issue another try, take the
`status:needs-human` label off and run with `--reset`. The flag puts the budgets
and the findings back to zero and keeps the branch, the pull request and the
step that the last run reached, so the work carries on where it stopped.

## Commands and options

| Argument | Effect |
| --- | --- |
| `init` | Write the config file with the defaults |
| `--force` | Replace an existing config file, with `init` |
| `--once` | Stop after the first handled issue |
| `--max <n>` | Handle at most n issues |
| `--reset` | Drop the saved budgets and findings, and keep the rest of the state |
| `--json` | Print the machine summary instead of the text one |
| `--verbose` | Show every command and all agent output |
| `--quiet` | Show only the milestones and the summary |
| `--help` | Show the option list |

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
```

`npm run build` compiles `src/*.mts` to `dist/*.mjs`. The package holds the
compiled files, because Node does not strip types under `node_modules`.

## Releases

Releases are automatic and need no pull request. Push a
[conventional commit](https://www.conventionalcommits.org/) to `main`. The
workflow reads the commits since the last tag and picks the bump: `feat` gives a
minor, `fix` gives a patch, and a `!` mark or a `BREAKING CHANGE` body gives a
major. Any other type releases nothing.

The workflow then bumps the version and publishes the package to npm with a
[trusted publish](https://docs.npmjs.com/trusted-publishers), so no token is
stored. Only after the publish does it push the tag and make the GitHub release,
so a failed publish leaves no half-release behind. A manual run of the workflow
publishes the version in `package.json` and changes nothing else, which repairs
a release that reached GitHub but not npm. The release job stays on a
GitHub runner, because npm takes provenance only from a GitHub runner.
