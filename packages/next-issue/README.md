# next-issue

A small harness that works through the open issues of a GitHub repository with
the [pi](https://github.com/earendil-works/pi) SDK. Run it inside a git repository.

```bash
npx -y next-issue@latest
```

## Overview

The harness claims the oldest open issue with the `status:todo` label and gives it its own git worktree and branch. An implementer agent does the work, and the harness commits, pushes and opens a draft pull request. It then waits for the checks. A fixer agent repairs a red build, and a reviewer agent judges the diff. The fixer deals with any open finding, and the checks and review run again. With no open finding left, the pull request is marked ready and the issue gets `status:done`. When a budget runs out or the work cannot go on, the issue gets `status:needs-human` and goes to a person. Then the harness takes the next issue.

```mermaid
flowchart TD
    claim[Claim the oldest status:todo issue] --> worktree[Add a worktree and branch]
    worktree --> implement[Implementer does the work, harness commits and pushes]
    implement --> pr[Open a draft pull request]
    pr --> checks{Checks pass?}
    checks -- no --> fixCi[Fixer repairs the build]
    fixCi --> checks
    checks -- yes --> review{Reviewer finds an open finding?}
    review -- yes --> fixReview[Fixer deals with the findings]
    fixReview --> checks
    review -- no --> done[Mark ready, set status:done]
    fixCi -. budget runs out .-> human[Hand over to a person: status:needs-human]
    fixReview -. budget runs out .-> human
    done --> claim
    human --> claim
```

## What it does

Before each issue, fetch the open issues again and take the oldest one not yet
seen in this run. An issue seen once in a run, also a skipped or failed one, is
not tried again in that run. The run ends when no unseen issue is left. When
the fetch fails, the run claims no new issue, ends once the running issues end,
writes the summary of the issues it handled and exits with code 1.

A run handles up to `concurrency` issues at the same time, 1 by default. When an
issue ends, the run fetches the open issues again and claims the oldest unseen
one for the free slot. Each issue has its own worktree and branch. Step 3 below
and the removal of a worktree or branch run for one issue at a time, so two
issues never change the git refs or worktrees of the repository at once. An issue blocked by a running issue is skipped and not tried again in
that run, even when the blocker closes before the run ends. `--max <n>` counts the handled issues across the run, and with `--once`
the run handles one issue. For each issue:

1. Claim the issue only when it holds the `status:todo` label and holds no
   `status:in-progress` or `status:in-review` label. A `status:done`,
   `status:needs-human` or `status:blocked` label always stops the claim, a
   resume too. An issue that GitHub lists as blocked by an open issue waits,
   because its blocker closes only when the pull request of the blocker merges.
   An issue with saved state under `.next-issue/` resumes instead, whatever its
   other labels and blockers. Such an issue joins the list also when it is
   closed, if its pull request is merged.
2. Add `status:in-progress` to the issue.
3. Fetch the remote, fast-forward the local copy of the default branch when
   that is safe, then add a git worktree at `.worktrees/<n>` in the
   repository root on the `<n>` branch. An issue that resumes from saved
   state keeps the branch name that the state holds, and a worktree that
   holds that branch already stays in use. A branch that exists on the
   remote is the start, and a local branch that fell behind the remote is
   fast-forwarded. A local branch that the remote does not hold and that has
   no commits of its own starts again from the remote base. An issue with no
   saved state does not reuse a local `<n>` branch: it resets that branch,
   and any worktree that holds it, to the remote branch, or to the remote
   base when there is none. A fast-forward of the base that is not safe
   leaves the local base branch as it is and writes a `base.behind` event. A
   new branch then starts from the remote base.
4. Let the implementer agent do the work, then commit and push. When a git
   hook stops a commit, the agent that made the change gets the hook output,
   fixes it, and the harness commits again. A `commit:` line in the reply of
   the agent replaces the subject, so a hook that rejects the subject can pass.
   The budget is `maxCommitFixes`. Any other git failure in the commit stops
   the run with an error. An implementer that makes no change hands the issue
   to a person, unless the branch is already ahead of the base, for example
   after the state file was lost: the run then carries on with the commits on
   the branch, and the newest of them gives the title of the pull request.
5. Open a draft pull request that closes the issue. Its title is the subject
   of the commit that starts it, so a squash merge gives a conventional
   commit.
6. Wait for the checks, once the pull request shows the pushed commit. A
   pending state waits again, up to `checkTimeoutMinutes`. A read that fails
   is tried three times before the run stops. A watch that exits with an error
   while no check failed counts as such a read, not as a red build. A repository that reports no
   check keeps asking for `checkGraceSeconds`, because a new pull request often
   shows no check yet, and only then goes straight to the review. The later
   gates of the same issue ask once. GitHub runs no check on a pull request
   that conflicts with its base, so no check and a conflict hand the issue to
   a person. While GitHub still works out whether the pull request can merge,
   the run asks again until `checkTimeoutMinutes`.
7. On a red build, give the failed job logs to the fixer agent, then go to step
   6 again. The budget is `maxCiFixes`.
8. Let the reviewer agent judge the diff, at most `diffMaxChars` of it. The
   reviewer reads files and runs commands in the worktree, so it can prove a
   finding with the tests or the type check. The harness then throws away every
   change that the reviewer left, so no such change can reach a later commit.
   The reviewer ends its last message with its verdict as a json block: a
   summary and one entry per finding, each rated `blocking` or `minor`. A
   reply without a valid block hands the issue to a person. The findings are the only ground
   truth. The reviewer gives no approve or reject field, because such a field
   can contradict the findings. The harness puts the result on the pull
   request.
9. An open finding is any finding, blocking or minor, while a review round is
   left. In the last round, only a blocking finding stays open: a minor finding
   there goes on the pull request but starts no fix, because a fix in the last
   round gets no review. Thus `maxReviewRounds` of `1` never fixes a minor
   finding.
10. No open finding means approval: mark the pull request ready for review and
    set `status:done`. The merge stays with you, unless you pass `--merge`:
    then the harness squash-merges the pull request, deletes the remote
    branch, waits until the pull request is merged, for example through a
    merge queue, and then waits for the checks that the merge commit starts on
    the base branch. A cancelled run there is no failure. When those checks
    fail, the fixer gets their logs on a branch reset to the base branch, from
    the check budget, and the harness force-pushes the fix, reopens the issue
    and opens a new pull request that goes to step 6 again, with fresh review
    rounds. The next issue waits for this, and a second ctrl-c stops only after
    it. The worktree, the local branch and the state file go away. A resume
    whose pull request is already merged goes straight to the wait for the
    checks on the base branch, and opens no new pull request. A resume that
    stopped inside the fix of the base branch carries on with that fix, and
    uses no more of the check budget. Without `--merge`, the remote branch
    stays, and a resume whose pull request a person merged sets
    `status:done` and waits for no check. A problem that the reviewer leaves out
    of the findings thus gets an approval: only the findings count.
11. With an open finding, run the fixer agent and go to step 6 again. The
    budget is `maxReviewRounds`. A fixer that holds every finding to be wrong
    changes nothing and gives its reason instead. The reason goes on the pull
    request and into the next round, where it answers every finding of its own
    round, so the reviewer withdraws them all or repeats them all. With only
    some findings wrong, the fixer fixes the correct ones, and the next round
    holds the rest.

## Issue format

Every agent prompt holds the body of the issue and the comments of users with write or admin access to the repository. An issue reads best with these sections, in this order:

1. `Problem`
2. `Context and findings`
3. `Acceptance criteria`
4. `Out of scope`
5. `Open questions`, empty when the issue is created

The list lives in `src/issue-format.mts`. The `create-issue` skill of [`@ravshansbox/pi-next-issue`](../pi-next-issue) writes an issue in this format, and a contract test fails when its template and the list disagree. The harness does not reject an issue without the format.

## Stops for a loop

The harness hands the issue to a person, with the `status:needs-human` label,
and comments the reason on the pull request, or on the issue when there is no
pull request yet, when:

- the check budget or the review budget runs out. A finding that the reviewer
  repeats, even one that the fixer disputed, goes back to the fixer until the
  review budget runs out;
- a fixer round adds no commit and gives no reason, so there is no progress;
- the fixer reports that the checks fail for a reason the change did not cause,
  such as a test already broken on the base branch or one that fails only under
  load. It changes nothing and the reason reaches the pull request, rather than
  the fixer spending its whole budget on a failure it cannot fix. A commit it
  makes anyway moves aside, as for a dispute of the findings;
- a fixer disputes the findings and leaves a change behind, either in the
  worktree or in a commit of its own. A dispute carries a reason, not a diff,
  so the harness throws none of it away: an unclean worktree stays on the
  disk, and a commit of the fixer moves to a new local
  `<n>-dispute-<commit>` branch, so the `<n>` branch keeps only what the pull
  request holds. The worktree drops the change of that commit, unless the fixer
  edited the worktree after the commit: then the worktree keeps both and stays
  on the disk. Neither is pushed, so the pull request shows no such change. It
  holds the reason of the dispute, and the change is on the machine that ran
  the harness. The `<n>-dispute-<commit>` branches go away with the `<n>`
  branch when the issue is done;
- the reviewer gives no verdict, or the checks do not finish in time;
- someone pushes to the pull request while the harness waits for the checks,
  so the pull request no longer shows the commit that the harness pushed;
- with `--merge`, the merge of an approved pull request fails, for example
  because branch protection asks for a human approval;
- with `--merge`, a queued merge does not finish in `checkTimeoutMinutes`, or
  the pull request closes without a merge;
- with `--merge`, the checks on the base branch fail after the merge and the
  fixer cannot fix them, or they do not finish in time. The base branch is
  then broken, so the run claims no new issue and ends once the running
  issues end;
- an agent does not finish in `agentTimeoutMinutes`;
- the setup command fails, or does not finish in `setupTimeoutMinutes`;
- a step of the run fails with an error. A `gh` call that is safe to repeat,
  such as a read or a label edit, is tried up to three times first when the
  network fails. A `gh pr create`, `gh pr comment` or `gh issue comment` is
  tried once, so a lost reply never makes a duplicate.

The fixer sees the findings of all earlier rounds, not only the last one, with
its own disputes next to them. From round two, the reviewer judges only the
earlier findings and any regression.

Each agent that writes to the pull request names itself in the first line of the
comment: `### Review: approved`, `### Review: changes requested` and
`### Fixer: no change`. The account is the same for all of them, so the heading,
not the author, tells them apart. The agents read the comments of the issue, not
of the pull request, so a comment of an agent never returns to a prompt: the
dispute of the fixer reaches the reviewer through the state file. The one
exception is the answer to a hand-over, see
[Retry an issue that waits for a person](#retry-an-issue-that-waits-for-a-person).

## Stop a run

Press `Ctrl-C` to stop the run step by step:

1. The first press stops new claims. The harness finishes every issue that it
   holds and then writes the summary as usual.
2. The second press stops every running issue after its current round: the
   implementation, one checks round (wait, then fix) or one review round
   (review, then fix). The issue ends as `stopped`. Its state, worktree and
   labels stay, so the next run carries on from that point.
3. The third press stops every agent, kills the command that runs and every
   child of it, so the run dies in the middle of a step. The saved state lets the next run continue the
   issue, but the issue keeps `status:in-progress` and the run writes no
   summary.

Each of the first two presses prints a line that says what happens next. The
agents run inside the harness, and their commands and the harness commands run
in a process group of their own, so a press reaches only the harness.

A status label that the harness puts on the issue goes on the pull request too,
but only if the pull request exists at that moment. The `status:in-progress`
label of a fresh issue comes before the pull request, and stays on the issue
alone. Thus a draft pull request shows work that the harness has not finished,
and a `status:needs-human` pull request shows work that waits for a person.

The harness runs all git and `gh` commands itself. The commit holds all the
changes in the worktree, so a setup command that writes a file outside
`.gitignore` puts that file in the commit. The reviewer is the one agent whose
changes never get that far: the harness discards them, and undoes any commit
that the reviewer made, before it reads the verdict.

## Safety

Every agent can run a shell command. The implementer and the fixer run with the
permission checks off; the reviewer runs with a smaller tool set, but its shell
has no limit on the commands. They all start in the worktree, but nothing holds
them there: they can run any command, with your rights, anywhere on the machine.
The prompt holds the title and the body of the issue, which come from GitHub.
It also holds the comments of the issue, but only those by users with write or
admin access to the repository. The harness leaves out every other comment and
writes a `comment.skip` event with its author to the run log. If an access check
fails for a reason other than a 404, the issue stops with an error.

Thus a person who can write an issue, or a writer who can comment, can try to
give an instruction to the agent. Use the harness only on a repository where you
trust the issue authors, or run it in a container.

[ADR 0001](https://github.com/ravshansbox/next-issue/blob/main/docs/adr/0001-reviewer-isolation.md) records why the reviewer
keeps a full shell, and which other options were considered.

## Observability

Every run has an id, `<timestamp>`, and writes these under `.next-issue/runs/`:

- `<id>.jsonl` — one JSON object per event, with `ts`, `runId`, `kind`, and the
  `issue`, `role` or `round` in scope;
- `<id>.summary.json` — token totals per agent role, event counts, and
  one report per issue with the outcome, the reason, the pull request number
  and the budgets used;
- `<id>/sessions/` — the full pi session of each agent call, with every
  message, tool call and tool result. The session id in a `usage` event is
  part of the file name.

At the start of a run, the harness deletes the files and folders under
`.next-issue/runs/` that are older than `keepRunDays`. Set the field to `0` to keep them all.

A short text summary of the same data goes to standard output. Use `--json` to
get the full summary object there instead, so the harness fits in a pipe. All
progress goes to standard error.

Recorded for each step: `claim`, `comments`, `reply`, `worktree`, `setup`,
`implement`, `push`, `pull-request`, `checks`, `review` and `fix`, each with a
`.start`, `.end` or `.error` event and a duration in `ms`. Every `git` and `gh`
command is recorded with its exit code and duration. A `tool` event holds the
tool name, and for a `bash` tool the command too. Each agent call adds a `usage`
event with the tokens, the cost estimate in dollars, the turn count, the
tool-call count, the model and the session id.

```bash
jq -r 'select(.kind=="usage") | [.issue,.role,.turns,.total] | @tsv' \
  .next-issue/runs/*.jsonl
```

`next-issue logs` shows the newest run log, one readable line per event, and
then prints new events as the run adds them, until `Ctrl-C`. In a terminal it
starts with the last events that fit the screen; in a pipe it starts with all
of them. It stops when the reader of the pipe closes it; on Linux it notices
this only at the next event. With `--json` it prints the raw JSON lines. This also shows a run of
the worker, whose progress goes to no terminal.

Three levels of console output:

| Level       | Shows                                                            |
| ----------- | ---------------------------------------------------------------- |
| `--quiet`   | Run and issue milestones, verdicts, hand-overs, errors           |
| default     | The above plus each step end, each tool call and failed commands |
| `--verbose` | The above plus every command and all agent text                  |

## Requirements

- Node 24 or later
- `gh`, authenticated with write access to the repository
- pi, logged in to a model provider. The agents use the model, the thinking
  level, the extensions and the skills from your pi settings, except the
  extension and the skills of `pi-next-issue`. The implementer and the fixer get the default tools of your pi
  settings, the `grep`, `find` and `ls` tools and the tools of your
  extensions. The reviewer gets all of them except `edit` and `write`. The
  agents run with `GIT_OPTIONAL_LOCKS=0`, so a `git status` from an agent or
  an extension does not hold the index lock while the harness commits.

## Configuration

To write the file with the defaults, run the `init` command in the repository:

```bash
npx -y next-issue@latest init
```

The command writes `next-issue.config.json` in the root of the repository and
adds `.next-issue/` and `.worktrees/` to `.gitignore`. It stops when the
config file is there already; `--force` replaces it. The file holds no
`setupCommand`, because the harness deduces one from the lock file of the
project.

With no file, every field keeps its default. A field that is not in the file
keeps its default. A file that cannot be read, a file that is not valid
JSON, a field with a value of the wrong type and a field name that the harness
does not know all stop the run, so a typo cannot pass without a word.

```json
{
  "remote": "origin",
  "issueLimit": 100,
  "concurrency": 1,
  "maxCiFixes": 5,
  "maxCommitFixes": 10,
  "maxReviewRounds": 5,
  "checkIntervalSeconds": 15,
  "checkGraceSeconds": 60,
  "checkTimeoutMinutes": 60,
  "agentTimeoutMinutes": 30,
  "setupTimeoutMinutes": 15,
  "commandTimeoutMinutes": 10,
  "logMaxChars": 20000,
  "diffMaxChars": 60000,
  "keepRunDays": 7,
  "draftPullRequest": true,
  "models": {
    "implementer": null,
    "reviewer": null,
    "fixer": null
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

| Field                   | Default            | Effect                                                                                                                               |
| ----------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `remote`                | `origin`           | The git remote for the repository and the branches                                                                                   |
| `issueLimit`            | `100`              | The maximum number of open issues to read. With `labels.ready` set, only issues with the ready, in-progress or in-review label count |
| `concurrency`           | `1`                | The most issues that a run handles at the same time                                                                                  |
| `maxCiFixes`            | `5`                | The budget for check fixes per issue                                                                                                 |
| `maxCommitFixes`        | `10`               | The budget for fixes of a commit that a git hook stopped, per issue                                                                  |
| `maxReviewRounds`       | `5`                | The budget for review rounds per issue                                                                                               |
| `checkIntervalSeconds`  | `15`               | The time between two check states                                                                                                    |
| `checkGraceSeconds`     | `60`               | The time to wait for the first check to show                                                                                         |
| `checkTimeoutMinutes`   | `60`               | The limit for one check wait                                                                                                         |
| `agentTimeoutMinutes`   | `30`               | The limit for one agent call                                                                                                         |
| `setupTimeoutMinutes`   | `15`               | The limit for the setup command                                                                                                      |
| `commandTimeoutMinutes` | `10`               | The limit for one `git` or `gh` command                                                                                              |
| `logMaxChars`           | `20000`            | The maximum length of the failed job logs, shared between the failed jobs                                                            |
| `diffMaxChars`          | `60000`            | The maximum length of the diff that the reviewer reads                                                                               |
| `keepRunDays`           | `7`                | The number of days to keep the run files; `0` keeps them all                                                                         |
| `draftPullRequest`      | `true`             | Open the pull request as a draft, until the review approves                                                                          |
| `setupCommand`          | from the lock file | A shell command to run in a new worktree, before the implementer                                                                     |
| `models`                | `null` per role    | The pi model per agent role, as `provider/model`: `implementer`, `reviewer`, `fixer`                                                 |
| `labels`                | see above          | The names of the labels that the harness reads and sets                                                                              |

An empty `labels.ready` turns the ready requirement off. The harness then
claims every open issue that no other label holds back.

The log gives the reason for a skipped issue as `stop-label`, `not-ready`,
`in-flight` or `blocked`, the last one with the open blockers.

A role set to `null`, or with no entry in `models`, uses the default model of
your pi settings.

Without a `setupCommand`, the harness looks in the new worktree for a lock file
and runs the install command that goes with it:

| Lock file               | Command                                                                              |
| ----------------------- | ------------------------------------------------------------------------------------ |
| `pnpm-lock.yaml`        | `pnpm install --frozen-lockfile`                                                     |
| `package-lock.json`     | `npm ci`                                                                             |
| `yarn.lock`             | `yarn install --frozen-lockfile`, or `yarn install --immutable` with a `.yarnrc.yml` |
| `bun.lock`, `bun.lockb` | `bun install --frozen-lockfile`                                                      |
| `Cargo.lock`            | `cargo fetch`                                                                        |
| `go.sum`                | `go mod download`                                                                    |
| `uv.lock`               | `uv sync`                                                                            |
| `poetry.lock`           | `poetry install`                                                                     |
| `Gemfile.lock`          | `bundle install`                                                                     |

The first match in that order wins. A project with no lock file in the list
runs no setup, and a `setupCommand` in the config file always wins. Thus the
agents find a worktree with its dependencies in place, and the reviewer can run
the tests. Each command holds to the lock file, so a lock file that does not
match the manifest stops the issue rather than changing the lock file.

A `setupCommand` that fails, or that does not finish in `setupTimeoutMinutes`,
hands the issue to a person. The wait for the checks has its own limit, so
`commandTimeoutMinutes` holds for every other `git` and `gh` command. State per
issue goes to `.next-issue/<issue>.json`, so a new run continues where the last
run stopped. A state file that is not valid JSON, or that does not hold a valid
state, gives the issue an `error` outcome that names the file, rather than a
silent skip.

## Retry an issue that waits for a person

A hand-over marks the state file as handed over. To give the issue another try,
take the `status:needs-human` label off. The next run that claims the issue puts
the budgets and the findings back to zero, clears the mark and keeps the branch,
the pull request and the step that the last run reached, so the work carries on
where it stopped. A commit that you pushed to the pull request in the meantime
is fetched first. An issue that still has the label is not claimed.

To give guidance, answer the hand-over with a comment in the same place: on the
pull request, or on the issue when there is no pull request. When the run
resumes the issue, it reads the comments posted after its last
`next-issue needs help:` comment there. Only comments from users with write
access to the repository count, for the hand-over comment too. The implementer
and every fixer of that run get them in their prompt, under the heading
`Answer of a person to the hand-over`. A short reply such as "ready, take it" is
enough. With no such comment, the run resumes with no guidance.

The `--reset` flag does the same for any issue that the run handles, whether or
not it was handed over. It touches only an issue that the run handles, so the
state of an issue that a label still holds back stays as it was.

## Commands and options

| Argument    | Effect                                                                                                                        |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `init`      | Write the config file with the defaults                                                                                       |
| `serve`     | Run the worker that pi extensions talk to, see [Worker](#worker)                                                              |
| `stop`      | Stop the worker, see [Worker](#worker)                                                                                        |
| `logs`      | Show the latest run log and follow it, see [Observability](#observability)                                                    |
| `--force`   | Replace an existing config file, with `init`                                                                                  |
| `--once`    | Stop after the first handled issue                                                                                            |
| `--max <n>` | Handle at most n issues                                                                                                       |
| `--merge`   | Squash-merge the pull request after the approval, delete the remote branch and fix a failure of the checks on the base branch |
| `--watch`   | Keep running, and read the open issues again after each pass                                                                  |
| `--reset`   | Drop the saved budgets and findings, and keep the rest of the state                                                           |
| `--json`    | Print the machine summary instead of the text one, or the raw JSON lines with `logs`                                          |
| `--verbose` | Show every command and all agent output                                                                                       |
| `--quiet`   | Show only the milestones and the summary                                                                                      |
| `--help`    | Show the option list                                                                                                          |

The exit code is 1 when an issue needs a person or failed, and 0 when it does
not, so a cron job or a CI step can read the result of the run.

## Watch for new issues

A run without `--watch` ends when no unseen issue is left. With `--watch`, the
harness then waits, reads the open issues again and runs another pass, so it
picks up an issue that someone opens during the run, or one whose blocker
merges. Each pass tries every open issue again, also one that an earlier pass
skipped. An issue that failed in an earlier pass is not tried again until the
next run.

The waits follow a fixed back-off in minutes: 1, 2, 3, 5, 10, then 10 from then
on. A pass that handles an issue, with any outcome other than `skipped`, resets
the back-off to 1 minute. A pass where every issue is skipped does not reset
it. Each wait prints a line on standard error with the minutes until the next
pass.

After each pass that handled an issue, the harness prints the summary of that
pass. The token totals in it cover that pass only. The exit code at the end
covers all passes. `--max <n>` counts the handled issues across all passes,
and `--once` is the same as `--max 1`.

The watch stops:

- at the first `Ctrl-C` during a wait, at once;
- at the first `Ctrl-C` during an issue, after the running issues;
- after a pass that halts the run, for example when the base branch is broken
  after `--merge`;
- when the open issues cannot be read.

## Worker

`next-issue serve` runs one worker for the machine. The
[`@ravshansbox/pi-next-issue`](../pi-next-issue) extension starts it and talks
to it. The worker:

- listens with WebSocket on the socket file `~/.pi/agent/next-issue.sock`, or
  in the folder that `PI_CODING_AGENT_DIR` names. Only your user can open the
  file. It works on macOS and Linux;
- holds `next-issue.lock` in the same folder, with its process id, so only one
  worker runs. A lock whose process is no longer alive is taken over;
- keeps the repositories it knows in `next-issue.roots.json` in the same
  folder, so it still knows them after a restart;
- runs at most one run per repository, and runs in several repositories at
  once. Each run is like `next-issue` without `--watch`, and the client says
  whether it merges;
- sends every client the progress of every run when it connects and on every
  change: for each running issue the issue, the step, the tool count and the
  last tool, and the handled issues;
- sends every client a `questions` message for each repository: the open
  issues with the `needsHuman` label, each with its number, title, the reason
  of the hand-over, the url of the comment that holds it, the `owner/name`
  repository, the pull request when there is one, and the `needsHuman` and
  `skip` labels. It reads them
  from GitHub, so the list is the same after a restart. It sends them when a
  client connects, for each repository it knows, after each issue of a run
  ends, and when a client sends `{ "type": "questions", "root": "<path>" }`.
  An issue that no longer has the label leaves the list. An issue with the
  label but no hand-over comment is in the list with an empty reason and url.
  The issues are read one at a time. A client never gets an older list after
  a newer one. When the client adds an `"id"` to its message, the list that
  answers it carries the same `id` and is read after the message arrived. When the list cannot be read, the client gets
  `{ "type": "questions-error", "root": "<path>", "message": "<text>" }`;
- stops a run, when a client asks, like a second `Ctrl-C`: each running issue
  after its current round, with the state kept;
- stays when all clients close;
- closes once no run is going when a client with a newer version connects, so
  that the client can start the newer worker;
- stops every agent and command and exits on `SIGTERM` or `SIGINT`, and
  removes its socket and lock files.

Stop it with `next-issue stop`. This sends `SIGTERM` to the process in the
lock file, so the worker stops at once and a run that is going resumes from
its saved state next time. When no worker is running, the command says so and
exits with 0.

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

The workflow then gives `next-issue` and `@ravshansbox/pi-next-issue` the same
new version and publishes both packages to npm with a
[trusted publish](https://docs.npmjs.com/trusted-publishers), so no token is
stored. Only after the publish does it push the tag and make the GitHub release,
so a failed publish leaves no half-release behind. npm makes a new version
live a few minutes after the publish, and not always in the order it got them,
so before it publishes, the job waits until npm serves both packages at the
version of the last tag, for up to 10 minutes. Thus a new version never goes
live before the one that came before it. A manual run of the workflow checks
out the last tag and publishes that commit under the tag version, and
changes nothing else. This repairs a release that reached GitHub but not npm.
The release job stays on a GitHub runner, because npm takes provenance only
from a GitHub runner.
