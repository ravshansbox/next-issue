# pi-next-issue

A [pi](https://github.com/earendil-works/pi) extension that works through the open GitHub issues of a repository in the background, while you keep using pi. The work is done by the [`next-issue`](../next-issue) worker, which this extension starts and talks to.

```bash
pi install npm:@ravshansbox/pi-next-issue
```

It needs `git`, `npx` and an authenticated [`gh`](https://cli.github.com/). It works on macOS and Linux. The repository must be on GitHub: `github.com` or a GitHub Enterprise host, which `gh` must be logged in to. Pi passes that host to `gh` when it is not `github.com`. Other hosts, such as GitLab, are not supported.

## Use

Run this in pi, inside a git repository:

- `/next-issue start [flags]` starts a run of this repository when none is going. The flags are those of the `next-issue` CLI: `--once`, `--max <n>`, `--watch`, `--hunt`, `--reset`, `--verbose` and `--quiet`. For example, `/next-issue start --hunt` hunts for bugs and keeps watching, like `next-issue --hunt`. The worker refuses any other argument, or a command such as `init`, and a note says why. When a run is going, a note says so, and nothing starts or restarts.
- `/next-issue stop [--after issue|round|now]` stops the run of this repository. When no run is going, a note says so. An unknown value or flag shows an error and stops nothing.
  - `--after issue`, the default: the run claims no new issue and starts no new hunt. It finishes the issues that it holds and a hunt that is going, then ends as `stopped`.
  - `--after round`: each running issue stops after its current round and keeps its saved state, worktree and labels, so the next run resumes it. A hunt that is going ends first.
  - `--after now`: the run stops every agent, command and hunt at once. The worker keeps running.
  - A stop with a later point than one already asked for changes nothing. A stop with an earlier point replaces it.
- `/next-issue` with no argument shows the usage: `start [flags]`, `stop [--after issue|round|now]` and `answer`. Pi suggests these as you type after `/next-issue `. After `/next-issue start `, pi suggests the flags that are not typed yet, each with a short description.
- The `next_issue_start` tool lets the model start a run. It takes an optional `args` array with the same flags as `/next-issue start`. When no run is going, it starts a run like `/next-issue start`. When a run is going, it starts nothing and reports the current run, which picks up new issues by itself. It never stops a run, and it does not ask for confirmation. Its result says whether it started a run.
- The `next_issue_status` tool lets the model see the run of this repository. It returns the footer line, then one line per handled issue with its outcome, for example `#190 done`. When the worker has no run of this repository, it returns `no run of <root>`. When no worker is going, it returns `no worker is running` and does not start one. It reports no other repository.

The footer shows each running issue with the number of open issues at the latest fetch, its stage, the number of tool calls and the time spent on it, for example `#12/7 · review 2/5 · 37 tools · 4m12s | #13/7 · implement · 5 tools · 40s`. The open count is the number of open issues that the run lists, including the running issues and the ones it skips. A stage with a limited number of rounds shows the round and its limit: `review 2/5`, `review fix 2/5`, `checks fix 1/5` or `commit fix 1/10`. Other lines read, for example, `looking for issues`, `finished: 2 done` or `stopped: 1 done, 1 needs a human`. After a run ends, it keeps the last summary. In the terminal, it uses the dim colour of the theme, like the rest of the footer. A note appears when an issue is done, needs a human or fails while pi is open. Pi does not repeat the notes of a run that ended before it opened.

## Answer questions

When an issue waits for a person, with the `needsHuman` label of the [config](../next-issue/README.md), the footer shows the count, for example `2 questions waiting`, and a note appears once for each new question. Neither interrupts what you do. Pi asks the worker for the list when it connects and every minute, and the worker also sends it after each issue of a run. A question answered on GitHub or in another pi leaves the count with the next list.

Run `/next-issue answer` to go through the waiting questions one at a time. Each shows the issue, the title and the reason of the hand-over. Choose:

- **Retry**: takes the `needsHuman` label off the issue, so the next run resumes it.
- **Retry with guidance**: asks for text, posts it as a comment on the issue, where the worker reads it, then takes the `needsHuman` label off.
- **Give up**: takes the `needsHuman` label off the issue and adds the `skip` label. Pi compares label names without case, as GitHub does, so it uses a `Status:Blocked` the repository already has. Pi creates the `skip` label first when the repository does not have it. When it cannot create the label, it shows an error that names the label and leaves the issue labels as they were. When the issue halted a run with a commit on the base whose checks nobody read, Give up also lets the next runs land other issues again, see [Stops for a loop](../next-issue/README.md#stops-for-a-loop).

To drop an issue for good, close it on GitHub instead. The next run removes its saved state, branches and worktree, see [Retry an issue that waits for a person](../next-issue/README.md#retry-an-issue-that-waits-for-a-person).

Press Escape, or leave the guidance empty, to stop. Pi reads the list again before each question, so it skips a question answered elsewhere in the meantime. The worker sends the repository and the label names with each question, from `.next-issue/config.json` and its `remote`. Pi uses `gh` for the comment and the labels.

## Create an issue

The package ships the `create-issue` skill. Ask pi to write an issue, ask for a change in a repository with `.next-issue/config.json`, or run `/skill:create-issue <problem>`. Pi then:

1. restates the problem, reads the code when the problem touches it, and finds the open issues that must be done first;
2. judges whether the change fits one atomic commit that leaves the trunk green. When it is too big for one atomic commit, it proposes a split into issues that each land alone and keep the trunk green;
3. asks numbered questions until none is open, including whether you confirm the split;
4. creates the ready label with `gh label create` when the repository does not have it, then runs `gh issue create --body-file --blocked-by` with the body from [`template.md`](skills/create-issue/template.md), the issues it depends on and no label, without showing the body first. The issue carries its blocker links from the moment it exists, so the worker waits for them even when `labels.ready` is empty and a run claims every open issue. It needs GitHub CLI 2.94.0 or later;
5. adds the ready label with `gh issue edit --add-label` only after it links every blocker. It adds the ready label and no other label. The ready label is the `labels.ready` label of `.next-issue/config.json`, or `status:todo` when `labels.ready` is not set or there is no config file. With an empty `labels.ready`, the issue gets no label, since the worker then claims every open issue. For a confirmed split, it creates each issue in turn with the links to the issues of the split it depends on, and only then adds its ready label;
6. gives you the issue url and asks once whether to start a run, leave it or change it, and changes it with `gh issue edit --body-file` or `--title` until you start a run or leave it;
7. calls `next_issue_start` when you asked for a run.

Pi files the issue, the ready label and the blocker links in the repository of the `remote` of `.next-issue/config.json`, or of `origin` when there is no config file or no `remote` field, as the worker does. It passes `--repo` to every `gh` command, so another remote, such as the `upstream` of a fork, never gets the issue.

The issue gets the ready label as soon as its blockers are linked, so a run that is already going may claim it before you review it.

Pi does not implement the issue in that session. The worker does the work. The body holds the sections of the [issue format](../next-issue/README.md#issue-format).

## Worker

The extension does no work itself. On `/next-issue start`, `stop` or `answer`, or `next_issue_start`, it connects to the `next-issue` worker of the repository on the socket file `.next-issue/worker.sock` in the repository. When no worker answers, it starts one in the repository with `npx -y next-issue@<version> serve`, and passes the flags of each start to it, where `<version>` is the version of the extension, or `latest` when the extension runs from a source checkout with version `0.0.0`, in the background, and writes the output of the worker to `.next-issue/worker.log` in the repository. The worker keeps that file within 10 MiB: it cuts a larger file to its newest 5 MiB when it starts and once a minute while it runs. When the path of the socket file is too long for the system, the extension says so and starts nothing.

While a command-line `next-issue` run holds the repository (its lock file `.next-issue/worker.lock`), no worker can start there. `/next-issue start`, `stop` and `answer`, and `next_issue_start`, then fail within a few seconds with `a command-line next-issue run (process <pid>) is going in this repository`, and start no worker. Wait until that run ends, or stop it, then try again. When the worker that the extension starts exits before it listens, the extension says so at once with its exit code and points to `.next-issue/worker.log`, for example `the next-issue worker exited before it listened: exit code 1 (see .next-issue/worker.log)`. A worker that starts slowly, for example while `npx` downloads it, still connects, for up to 2 minutes.

- Each repository has its own worker. Every pi in a repository shares the worker of that repository and shows its run, whoever started it. A run, restart or upgrade in one repository never affects another.
- Opening pi does not start a worker. It only shows a run when a worker is going.
- The run does not belong to pi: it goes on after `/new`, `/resume`, a fork, a reload or quitting pi.
- The worker exits when no run is going and no pi is connected. Stop it at once with `npx next-issue stop` in the repository.
- Versions before one worker per repository ran one worker for the machine, which does not stop by itself and can keep claiming issues alongside the new worker. Stop it once after you upgrade, as the [`next-issue` README](../next-issue/README.md#worker) says.
- When the extension is newer than the worker of a repository, that worker closes once no run is going, and the extension starts the newer worker. Workers of other repositories carry on.

Each run lands approved changes straight on the base branch, with no pull request, as [ADR 0003](https://github.com/ravshansbox/next-issue/blob/main/docs/adr/0003-land-without-pull-requests.md) records. See the [`next-issue` README](../next-issue/README.md) for what a run does, its labels, its state and its config.
