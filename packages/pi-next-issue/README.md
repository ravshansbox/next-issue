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
- The `next_issue_status` tool lets the model see the run of this repository. It returns the footer line, then one line per handled issue with its outcome, for example `#190 done`. When the worker has no run of this repository, it returns `no run of <root>`. When no worker is going, it returns `no worker is running` and does not start one. It reports no other repository.

The footer shows each running issue with the number of open issues at the latest fetch, its stage, the number of tool calls and the time spent on it, for example `#12/7 · review 2/5 · 37 tools · 4m12s | #13/7 · implement · 5 tools · 40s`. The open count includes the running issues and issues the run skips. A stage with a limited number of rounds shows the round and its limit: `review 2/5`, `review fix 2/5`, `checks fix 1/5` or `commit fix 1/10`. Other lines read, for example, `looking for issues`, `finished: 2 done` or `stopped: 1 done, 1 needs a human`. After a run ends, it keeps the last summary. In the terminal, it uses the dim colour of the theme, like the rest of the footer. A note appears when an issue is done, needs a human or fails while pi is open. Pi does not repeat the notes of a run that ended before it opened.

## Answer questions

When an issue waits for a person, with the `needsHuman` label of the [config](../next-issue/README.md), the footer shows the count, for example `2 questions waiting`, and a note appears once for each new question. Neither interrupts what you do. Pi asks the worker for the list when it connects and every minute, and the worker also sends it after each issue of a run. A question answered on GitHub or in another pi leaves the count with the next list.

Run `/next-issue answer` to go through the waiting questions one at a time. Pi suggests `answer` as you type after `/next-issue `. Each shows the issue, the title and the reason of the hand-over. Choose:

- **Retry**: takes the `needsHuman` label off the issue and its pull request, so the next run resumes it.
- **Retry with guidance**: asks for text, posts it as a comment where the worker reads it, on the pull request of the issue or on the issue when it has none, then takes the `needsHuman` label off.
- **Give up**: takes the `needsHuman` label off the issue and its pull request and adds the `skip` label.

Press Escape, or leave the guidance empty, to stop. Pi reads the list again before each question, so it skips a question answered elsewhere in the meantime. The worker sends the repository, the pull request and the label names with each question, from `next-issue.config.json` and its `remote`. Pi uses `gh` for the comment and the labels.

## Create an issue

The package ships the `create-issue` skill. Ask pi to write an issue, ask for a change in a repository with `next-issue.config.json`, or run `/skill:create-issue <problem>`. Pi then:

1. restates the problem, reads the code when the problem touches it, and finds the open issues that must be done first;
2. asks numbered questions until none is open;
3. runs `gh issue create --body-file` with the body from [`template.md`](skills/create-issue/template.md) and the `status:todo` label, without showing the body first;
4. links each blocker with `gh issue edit --add-blocked-by`, so the worker waits for it;
5. gives you the issue url and asks once whether to start a run, leave it or change it, and changes it with `gh issue edit --body-file` or `--title` until you start a run or leave it;
6. calls `next_issue_start` when you asked for a run.

The issue gets `status:todo` when it is created, so a run that is already going may claim it before you review it.

Pi does not implement the issue in that session. The worker does the work. The body holds the sections of the [issue format](../next-issue/README.md#issue-format).

## Worker

The extension does no work itself. On `/next-issue` or `next_issue_start` it connects to the `next-issue` worker of the repository on the socket file `.next-issue/worker.sock` in the repository. When no worker answers, it starts one in the repository with `npx -y next-issue@<version> serve`, where `<version>` is the version of the extension, or `latest` when the extension runs from a source checkout with version `0.0.0`, in the background, and writes the output of the worker to `.next-issue/worker.log` in the repository. When the path of the socket file is too long for the system, the extension says so and starts nothing.

- Each repository has its own worker. Every pi in a repository shares the worker of that repository and shows its run, whoever started it. A run, restart or upgrade in one repository never affects another.
- Opening pi does not start a worker. It only shows a run when a worker is going.
- The run does not belong to pi: it goes on after `/new`, `/resume`, a fork, a reload or quitting pi.
- The worker exits when no run is going and no pi is connected. Stop it at once with `npx next-issue stop` in the repository.
- When the extension is newer than the worker of a repository, that worker closes once no run is going, and the extension starts the newer worker. Workers of other repositories carry on.

Each run asks the worker to merge the pull requests. [ADR 0002](https://github.com/ravshansbox/next-issue/blob/main/docs/adr/0002-merge-setting.md) compares where the merge setting could live. See the [`next-issue` README](../next-issue/README.md) for what a run does, its labels, its state and its config.
