# pi-next-issue

A [pi](https://github.com/earendil-works/pi) extension that works through the open GitHub issues of a repository in the background, while you keep using pi. The work is done by the [`next-issue`](../next-issue) worker, which this extension starts and talks to.

```bash
pi install npm:@ravshansbox/pi-next-issue
```

It needs `git`, `npx` and an authenticated [`gh`](https://cli.github.com/). It works on macOS and Linux.

## Use

Run this in pi, inside a git repository:

- `/next-issue` starts a run of this repository when none is going, and stops the run when one is going. A stop takes effect after the current round, and the issue keeps its saved state, so the next run resumes it.

The footer shows the issue, the stage, the number of tool calls and the time spent on the issue, for example `next-issue #12 · review 1 · 37 tools · 4m12s`. After a run ends, it keeps the last summary. In the terminal, it uses the dim colour of the theme, like the rest of the footer. A note appears when an issue is done, needs a human or fails while pi is open. Pi does not repeat the notes of a run that ended before it opened.

## Worker

The extension does no work itself. On `/next-issue` it connects to the `next-issue` worker on the socket file `~/.pi/agent/next-issue.sock`. When no worker answers, it starts one with `npx -y next-issue@latest serve`, in the background, and writes the output of the worker to `~/.pi/agent/next-issue-worker.log`.

- Every pi on the machine shares the one worker, and every pi in a repository shows the run of that repository, whoever started it.
- Opening pi does not start a worker. It only shows a run when a worker is going.
- The run does not belong to pi: it goes on after `/new`, `/resume`, a fork, a reload or quitting pi.
- The worker stays when every pi is closed. Stop it with `npx next-issue stop`.
- When the extension is newer than the worker, the worker closes once no run is going, and the extension starts the newer worker.

Each run asks the worker to merge the pull requests. See the [`next-issue` README](../next-issue/README.md) for what a run does, its labels, its state and its config.
