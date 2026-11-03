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
- The `next_issue_status` tool lets the model see the run of this repository. It returns the footer line, then one line per handled issue with its outcome, for example `#190 done`. When the worker has no run of this repository, it returns `next-issue · no run of <root>`. When no worker is going, it returns `next-issue · no worker is running` and does not start one. It reports no other repository.

The footer shows the issue, the stage, the number of tool calls and the time spent on the issue, for example `next-issue #12 · review 1 · 37 tools · 4m12s`. After a run ends, it keeps the last summary. In the terminal, it uses the dim colour of the theme, like the rest of the footer. A note appears when an issue is done, needs a human or fails while pi is open. Pi does not repeat the notes of a run that ended before it opened.

## Answer questions

When an issue waits for a person, with the `needsHuman` label of the [config](../next-issue/README.md), the footer shows the count, for example `2 questions waiting`, and a note appears once for each new question. Neither interrupts what you do. Pi asks the worker for the list when it connects and every minute, and the worker also sends it after each issue of a run. A question answered on GitHub or in another pi leaves the count with the next list.

Run `/next-issue answer` to go through the waiting questions one at a time. Pi suggests `answer` as you type after `/next-issue `. Each shows the issue, the title and the reason of the hand-over. Choose:

- **Retry**: takes the `needsHuman` label off the issue and its pull request, so the next run resumes it.
- **Retry with guidance**: asks for text, posts it as a comment where the worker reads it, on the pull request of the issue or on the issue when it has none, then takes the `needsHuman` label off.
- **Give up**: takes the `needsHuman` label off the issue and its pull request and adds the `skip` label.

Press Escape, or leave the guidance empty, to stop. Pi reads the list again before each question, so it skips a question answered elsewhere in the meantime. The worker sends the repository, the pull request and the label names with each question, from `next-issue.config.json` and its `remote`. Pi uses `gh` for the comment and the labels.

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
