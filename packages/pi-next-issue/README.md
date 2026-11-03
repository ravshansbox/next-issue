# pi-next-issue

A [pi](https://github.com/earendil-works/pi) extension that works through the open GitHub issues of a repository in the background, while you keep using pi. The work is done by the [`next-issue`](../next-issue) worker, which this extension starts and talks to.

```bash
pi install npm:@ravshansbox/pi-next-issue
```

It needs `git`, `npx` and an authenticated [`gh`](https://cli.github.com/). It works on macOS and Linux.

## Use

Run this in pi, inside a git repository:

- `/next-issue` starts a run of this repository when none is going, and stops the run when one is going. A stop takes effect after the current round, and the issue keeps its saved state, so the next run resumes it.
- The `next_issue_start` tool lets the model start a run. When no run is going, it starts a run like `/next-issue`. When a run is going, it starts nothing and reports the current run, which picks up new issues by itself. It never stops a run, and it does not ask for confirmation. Its result says whether it started a run.

The footer shows the issue, the stage, the number of tool calls and the time spent on the issue, for example `next-issue #12 · review 1 · 37 tools · 4m12s`. After a run ends, it keeps the last summary. In the terminal, it uses the dim colour of the theme, like the rest of the footer. A note appears when an issue is done, needs a human or fails while pi is open. Pi does not repeat the notes of a run that ended before it opened.

## Create an issue

The package ships the `create-issue` skill. Ask pi to write an issue, or run `/skill:create-issue <problem>`. Pi then:

1. restates the problem, reads the code when the problem touches it, and finds the open issues that must be done first;
2. asks numbered questions until none is open;
3. shows the title, the body and those blockers, and asks once whether to create the issue and start a run;
4. runs `gh issue create --body-file` with the body from [`template.md`](skills/create-issue/template.md) and the `status:todo` label;
5. links each blocker with `gh issue edit --add-blocked-by`, so the worker waits for it;
6. calls `next_issue_start` when you asked for a run.

Pi does not implement the issue in that session. The worker does the work. The body holds the sections of the [issue format](../next-issue/README.md#issue-format).

## Worker

The extension does no work itself. On `/next-issue` or `next_issue_start` it connects to the `next-issue` worker on the socket file `~/.pi/agent/next-issue.sock`. When no worker answers, it starts one with `npx -y next-issue@<version> serve`, where `<version>` is the version of the extension, or `latest` when the extension runs from a source checkout with version `0.0.0`, in the background, and writes the output of the worker to `~/.pi/agent/next-issue-worker.log`.

- Every pi on the machine shares the one worker, and every pi in a repository shows the run of that repository, whoever started it.
- Opening pi does not start a worker. It only shows a run when a worker is going.
- The run does not belong to pi: it goes on after `/new`, `/resume`, a fork, a reload or quitting pi.
- The worker stays when every pi is closed. Stop it with `npx next-issue stop`.
- When the extension is newer than the worker, the worker closes once no run is going, and the extension starts the newer worker.

Each run asks the worker to merge the pull requests. See the [`next-issue` README](../next-issue/README.md) for what a run does, its labels, its state and its config.
