# pi-next-issue

A [pi](https://github.com/earendil-works/pi) extension that works through the open GitHub issues of a repository in the background, while you keep using pi. The work is done by the [`next-issue`](../next-issue) worker, which this extension starts and talks to.

```bash
pi install npm:@ravshansbox/pi-next-issue
```

It needs `git`, `npx` and an authenticated [`gh`](https://cli.github.com/). It works on macOS and Linux. The repository must be on GitHub: `github.com` or a GitHub Enterprise host, which `gh` must be logged in to. Pi passes that host to `gh` when it is not `github.com`. Other hosts, such as GitLab, are not supported.

## Use

Run this in pi, inside a git repository:

- `/next-issue start` starts a run of this repository when none is going. The run does one pass, with watching and hunting off: it handles the issues it finds, then ends. `/next-issue watch on` and `/next-issue hunt on` change that while it runs. It takes no argument: any argument shows an error and starts nothing. When a run is going, a note says so, the run is asked to check for new issues now, and nothing starts or restarts. The `--max`, `--reset`, `--verbose` and `--quiet` flags of the `next-issue` CLI have no form in pi.
- `/next-issue watch on` makes the going run of this repository keep watching for new issues after the current pass, with no restart: it reads the open issues again after each pass, like `next-issue start --watch`. `/next-issue watch off` makes it end after the current pass, or at once when it waits between passes, as a run without `--watch` does. Off also turns hunting off. When no run is going, a note says so. A note says when watching of the going run turns on or off. When no worker is running, it starts none.
- `/next-issue hunt on` and `/next-issue hunt off` switch hunting for bugs on or off for the going run of this repository, with no restart: the run keeps its issues, worktrees and progress. On also turns watching on, when the run does not watch. Off lets a hunt that is going finish, so the issues it files stay, and starts no new hunt. On wakes the hunter at once, with no back-off wait; the hunter then hunts only while fewer than `huntCap` ready issues wait, see [Hunt for bugs](../next-issue/README.md#hunt-for-bugs). When no run is going, a note says so. The setting lasts for that run only. It works only for runs of the worker that this extension starts, not for a `next-issue start` run on the command line. A note says when hunting of the going run turns on or off. When no worker is running, it starts none.
- `/next-issue stop [issue|round|now]` stops the run of this repository. When no run is going, a note says so. When no worker is running, it starts none. An unknown value, a flag such as `--after`, or a second value shows an error and stops nothing.
  - `issue`, the default: the run claims no new issue and starts no new hunt. It finishes the issues that it holds and a hunt that is going, then ends as `stopped`.
  - `round`: each running issue stops after its current round and keeps its saved state, worktree and labels, so the next run resumes it. A hunt that is going ends first.
  - `now`: the run stops every agent, command and hunt at once. The worker keeps running.
  - A stop with a later point than one already asked for changes nothing. A stop with an earlier point replaces it.
- `/next-issue` with no argument shows the usage: `start`, `stop [issue|round|now]`, `watch on|off` and `hunt on|off`. Pi suggests `start`, `stop`, `watch` and `hunt` as you type after `/next-issue `. After `/next-issue stop `, it suggests `issue`, `round` and `now`, and after `/next-issue watch ` or `/next-issue hunt `, it suggests `on` and `off`, each with a short description. It suggests nothing after `/next-issue start `.
- The `next_issue_start` tool lets the model start a run. It takes no argument. When no run is going, it starts a run like `/next-issue start`. When a run is going, it starts nothing, asks that run to check for new issues now (a `refresh` message, so an issue filed just before is claimed with no back-off wait) and reports the run. It never stops a run (use `next_issue_stop`), and it does not ask for confirmation. Its result says whether it started a run.
- The `next_issue_refresh` tool lets the model ask the going run of this repository to check for new issues now (a `refresh` message), for example right after it files an issue. It reports `Asked the run of <root> to check for new issues now.` When no run of this repository is going, or no worker is running, it starts nothing (no worker, no run) and reports `No run of <root> is going, so nothing was asked.` When the going run does not watch for issues, it asks nothing and reports `The run of <root> does not watch for new issues, so it would ignore the request and nothing was asked.`
- The `next_issue_watch` tool lets the model switch watching of the going run on or off, like `/next-issue watch`, with an `on` argument, `true` or `false`. It waits for the worker and returns the new setting, or fails with the reason when no run is going. When no worker is running, it fails with `no run of <root> is going` and starts none.
- The `next_issue_hunt` tool lets the model switch hunting of the going run on or off, like `/next-issue hunt`, with an `on` argument, `true` or `false`. It waits for the worker and returns the new setting, or fails with the reason when no run is going. When no worker is running, it fails with `no run of <root> is going` and starts none.
- The `next_issue_stop` tool lets the model stop the going run, like `/next-issue stop`, with an optional `after` argument, `issue` (the default), `round` or `now`. It does not ask for confirmation and does not wait for the run to end: it returns at once and says that the run of the repository was asked to stop and at which point, for example `Asked the run of /repo to stop after the running issues.` It fails with `no run of <root> is going` when no run is going, and starts no worker when none is running.
- The `next_issue_status` tool lets the model see the run of this repository. It returns the footer line, `watching on` or `watching off` and `hunting on` or `hunting off` while the run is going, then one line per handled issue with its outcome, for example `#190 done`. When the worker has no run of this repository, it returns `no run of <root>`. When no worker is going, it returns `no worker is running` and does not start one. It reports no other repository.

The footer starts with the number of open issues at the latest fetch, then shows each running issue with its stage, the number of tool calls and the time spent on it, for example `7 issues · #12 · review 2/5 · 37 tools · 4m12s | #13 · implement · 5 tools · 40s`. The open count is the number of open issues that the run lists, including the running issues and the ones it skips. A stage with a limited number of rounds shows the round and its limit:

- `review 2/5`: the reviewer reviews the change.
- `review fix 2/5`: the fixer works on the findings of the review.
- `local fix 1/5`: the fixer works on a failed command from `checks` before the push.
- `conflict fix 1/5`: the fixer resolves a merge conflict with the base.
- `checks fix 1/5`: the fixer works on failed checks on the base after the push.
- `commit fix 1/10`: the agent works on a failed commit hook.

`local fix`, `conflict fix` and `checks fix` share one limit, `maxCiFixes`, from the [config](../next-issue/README.md).

Other lines read, for example, `7 issues · looking for issues` or `#12 · stopping`. When a run finishes or stops, the line is cleared. When a run fails, it shows the error, for example `failed: gh failed`. In the terminal, it uses the dim colour of the theme, like the rest of the footer. A note appears when an issue is done, needs a human or fails while pi is open. Pi does not repeat the notes of a run that ended before it opened.

## Answer questions

When an issue waits for a person, with the `needsHuman` label of the [config](../next-issue/README.md), the footer shows the count, for example `2 questions waiting`, and a note appears once for each new question, for example `next-issue: #12 has a question: Fix the parser. Ask pi to answer it with the answer-hand-over skill.` Neither interrupts what you do. Pi asks the worker for the list when it connects and every minute, and the worker also sends it after each issue of a run. A question answered on GitHub or in another pi leaves the count with the next list.

Answer a question with the `answer-hand-over` skill, see [Investigate a hand-over](#investigate-a-hand-over). When the issue halted a run with a commit on the base whose checks nobody read, Give up also lets the next runs land other issues again, see [Stops for a loop](../next-issue/README.md#stops-for-a-loop).

To drop an issue for good, close it on GitHub instead. The next run removes its saved state, branches and worktree, see [Retry an issue that waits for a person](../next-issue/README.md#retry-an-issue-that-waits-for-a-person).

### Investigate a hand-over

The package ships the `answer-hand-over` skill. Ask pi to answer a question or a hand-over, or run `/skill:answer-hand-over`. Pi then:

1. lists the open issues with the `needsHuman` label and lets you pick one;
2. reads the latest `next-issue needs help:` comment from a user with write access and its `question:` lines, the commits and the diff of the issue branch when there is one, and the logs of the failed checks when the hand-over names them;
3. explains the blocker in plain words;
4. asks numbered questions, with lettered options and a recommendation, until it knows whether to retry, retry with guidance or give up;
5. answers on GitHub: Retry takes the `needsHuman` label off, Retry with guidance posts one comment that does not start with a heading of the harness and then takes the label off, and Give up takes the label off and adds the `skip` label, which it creates first when the repository lacks it and reuses when it differs only in case;
6. after a retry, calls `next_issue_refresh`, and asks only whether to start a run when none is going, or whether to turn watching on (`next_issue_watch`) when the going run does not watch.

Pi finds the repository as the `create-issue` skill does and passes `--repo` to every `gh` command. It does not fix the code of the issue.

## Create an issue

The package ships the `create-issue` skill. Ask pi to write an issue, ask for a change in a repository with `.next-issue/config.json`, or run `/skill:create-issue <problem>`. Pi then:

1. restates the problem, reads the code when the problem touches it, and finds the open issues that must be done first;
2. judges whether the change fits one atomic commit that leaves the trunk green. When it is too big for one atomic commit, it proposes a split into issues that each land alone and keep the trunk green;
3. asks numbered questions until none is open, including whether you confirm the split;
4. creates the ready label with `gh label create` when the repository does not have it, then runs `gh issue create --body-file --blocked-by` with the body from [`template.md`](skills/create-issue/template.md), the issues it depends on and no label, without showing the body first. The issue carries its blocker links from the moment it exists, so the worker waits for them even when `labels.ready` is empty and a run claims every open issue. It needs GitHub CLI 2.94.0 or later;
5. adds the ready label with `gh issue edit --add-label` only after it links every blocker. It adds the ready label and no other label. The ready label is the `labels.ready` label of `.next-issue/config.json`, or `status:todo` when `labels.ready` is not set or there is no config file. With an empty `labels.ready`, the issue gets no label, since the worker then claims every open issue. For a confirmed split, it creates each issue in turn with the links to the issues of the split it depends on, and only then adds its ready label;
6. calls `next_issue_refresh` with no question first. When a run is going, it gives you the issue url, says the run was asked to check for new issues now, and asks nothing. When no run is going, it gives you the url and asks only whether to start a run, and calls `next_issue_start` when you say yes. When the going run does not watch, it gives you the url and asks only whether to turn watching on, and calls `next_issue_watch` and `next_issue_refresh` when you say yes;
7. changes the issue with `gh issue edit --body-file` or `--title` when you ask for a change.

Pi files the issue, the ready label and the blocker links in the repository of the `remote` of `.next-issue/config.json`, or of `origin` when there is no config file or no `remote` field, as the worker does. It passes `--repo` to every `gh` command, so another remote, such as the `upstream` of a fork, never gets the issue.

The issue gets the ready label as soon as its blockers are linked, so a run that is already going may claim it before you review it.

Pi does not implement the issue in that session. The worker does the work. The body holds the sections of the [issue format](../next-issue/README.md#issue-format).

## Worker

The extension does no work itself. On `/next-issue start` or `next_issue_start`, it connects to the `next-issue` worker of the repository on the socket file `.next-issue/worker.sock` in the repository. When no worker answers, it starts one in the repository with `npx -y next-issue@<version> serve`, where `<version>` is the version of the extension, or `latest` when the extension runs from a source checkout with version `0.0.0`, in the background, and writes the output of the worker to `.next-issue/worker.log` in the repository. The worker keeps that file within 10 MiB: it cuts a larger file to its newest 5 MiB when it starts and once a minute while it runs. On `/next-issue stop`, `watch` or `hunt`, or `next_issue_stop`, `next_issue_watch` or `next_issue_hunt`, it only connects to a worker that is running, and never starts one. When the path of the socket file is too long for the system, the extension says so and starts nothing.

While a command-line `next-issue start` run holds the repository (its lock file `.next-issue/worker.lock`), no worker can start there. `/next-issue start`, `stop`, `watch` and `hunt`, and `next_issue_start`, `next_issue_stop`, `next_issue_watch` and `next_issue_hunt`, then fail within a few seconds with `a command-line next-issue run (process <pid>) is going in this repository`, and start no worker. Wait until that run ends, or stop it, then try again. When the worker that the extension starts exits before it listens, the extension says so at once with its exit code and points to `.next-issue/worker.log`, for example `the next-issue worker exited before it listened: exit code 1 (see .next-issue/worker.log)`. A worker that starts slowly, for example while `npx` downloads it, still connects, for up to 2 minutes.

- Each repository has its own worker. Every pi in a repository shares the worker of that repository and shows its run, whoever started it. A run, restart or upgrade in one repository never affects another.
- Opening pi does not start a worker. It only shows a run when a worker is going. When the worker goes away, for example after `npx next-issue stop`, pi clears the run and the questions count from the footer, and shows them again once a worker answers.
- The run does not belong to pi: it goes on after `/new`, `/resume`, a fork, a reload or quitting pi.
- The worker exits when no run is going and no pi is connected. Stop it at once with `npx next-issue stop` in the repository.
- Versions before one worker per repository ran one worker for the machine, which does not stop by itself and can keep claiming issues alongside the new worker. Stop it once after you upgrade, as the [`next-issue` README](../next-issue/README.md#worker) says.
- When the extension is newer than the worker of a repository, that worker closes once no run is going, and the extension starts the newer worker. Workers of other repositories carry on. While a run of an older worker is going, `/next-issue watch`, `/next-issue hunt`, `next_issue_watch` and `next_issue_hunt` show an error and send nothing: stop the run, then start it again on the newer worker.

Each run lands approved changes straight on the base branch, with no pull request, as [ADR 0003](https://github.com/ravshansbox/next-issue/blob/main/docs/adr/0003-land-without-pull-requests.md) records. See the [`next-issue` README](../next-issue/README.md) for what a run does, its labels, its state and its config.
