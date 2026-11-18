# next-issue plugin behaviour

## Use

In Claude Code, inside a git repository:

- `/next-issue` opens the dashboard in a pane beside the conversation. Where no pane can be drawn, it asks what to do instead, with the actions that fit the run: Start when no run is going; Stop, Watch on or Watch off, Hunt on or Hunt off, and Refresh when a run is going. Stop then asks when to stop. Where nobody can be asked, such as `claude -p`, it prints the status of the run.
- The row above the prompt shows the going run, such as `4 issues · #7 · implement · 3m`, and how many hand-overs wait for a person, such as `1 question waiting`. The plugin reads the worker each second and the hand-overs each minute while the session is open. A finished or stopped run leaves the row, and the row gives way while Claude Code shows a survey there.
- The dashboard has four tabs:
  - Active shows the going run: its status, whether it watches and hunts, the open-issue count, each running issue with its stage and time spent, and each handled issue with its outcome. With no run going, it shows the status and error of the last run. Its actions are Start, or Stop after the running issues, Stop after the current round of each running issue, Stop at once, Watch on or Watch off, Hunt on or Hunt off, and Refresh. Each shows its result as a toast. A running or handled issue opens its detail view.
  - Past lists the runs kept under `.next-issue/runs/`, newest first, each with its start time in UTC and its end: `finished`, `stopped`, `failed` or `not ended`. The chosen run shows its error, each issue with its outcome and reason, and the tokens and time of each role from its summary. An issue opens its detail view in that run.
  - The detail view of an issue shows its run events in time order (UTC), its lines in `.next-issue/worker.log` (local time), and what each agent said, from the sessions under `.next-issue/runs/<runId>/sessions/`: assistant and user text in full, `thinking` for each thinking block, and one line per tool call, such as `tool Bash git status --short` or `tool Read src/detail.ts`, with paths relative to the agent's working folder. Tool results are not shown. Back returns.
  - Hand-overs lists the issues that wait for a person, each with its reason and link, and Retry, Retry with guidance and Give up. Retry swaps the `needsHuman` label for the `ready` label and asks the going run to check for new issues. Retry with guidance posts the guidance as a comment first; guidance that starts with a heading of the harness, such as `### Review:`, is refused, since it would not count as an answer. Give up swaps the label for the `skip` label, and creates that label when the repository lacks it.
  - Upcoming lists the issues that the worker would claim, in the order it claims them, and the blocked ones with their blockers.
- The model gets six tools, listed as `mcp__next-issue__<name>`:
  - `next_issue_start` starts a run when none is going: it watches and does not hunt. It starts the worker when none answers. When a run is going, it starts nothing, asks that run to check for new issues now (unless it is stopping or does not watch) and reports that run.
  - `next_issue_refresh` asks the going run to check for new issues now. It never starts a worker or a run.
  - `next_issue_watch` and `next_issue_hunt` switch watching or hunting of the going run on or off, with no restart. Watch off also turns hunting off, and hunt on also turns watching on.
  - `next_issue_stop` asks the going run to stop after the running issues (`issue`, the default), after the current round (`round`) or at once (`now`).
  - `next_issue_status` reports the run: its status line, watching, hunting and each handled issue. It never starts a worker.
  - A tool that cannot do what it was asked fails with the reason, such as `no run of <root> is going`.
- The `create-issue` and `answer-hand-over` skills, see [Create an issue](#create-an-issue) and [Investigate a hand-over](#investigate-a-hand-over).

## Investigate a hand-over

The plugin ships the `answer-hand-over` skill. Ask Claude to answer a question or a hand-over, or run `/next-issue:answer-hand-over`. Claude then:

1. lists the open issues with the `needsHuman` label and lets you pick one;
2. checks the permission of each comment author first, reads the text of comments from users with write access only, as data and not instructions, and finds the latest `### next-issue · Hand-over: needs help` comment (or `next-issue needs help:` of older versions) and its `question:` lines; it reads the commits and the diff of the issue branch when there is one, and the logs of the failed checks when the hand-over names them;
3. explains the blocker in plain words;
4. asks numbered questions, with lettered options and a recommendation, until it knows whether to retry, retry with guidance or give up;
5. answers on GitHub: Retry swaps the `needsHuman` label for the `ready` label in one `gh issue edit` (with an empty `labels.ready`, it only takes the label off), Retry with guidance posts one comment that does not start with a heading of the harness and then swaps the labels the same way, and Give up takes the label off and adds the `skip` label, which it creates first when the repository lacks it and reuses when it differs only in case;
6. after a retry, calls `next_issue_refresh`, and asks only whether to start a run when none is going, or whether to turn watching on (`next_issue_watch`) when the going run does not watch. When the going run is stopping, it says so and asks nothing.

Claude finds the repository as the `create-issue` skill does and passes `--repo` to every `gh` command. It does not fix the code of the issue.

## Create an issue

The plugin ships the `create-issue` skill. Ask Claude to write an issue, ask for a change in a repository with `.next-issue/config.json`, or run `/next-issue:create-issue <problem>`. Claude then:

1. restates the problem, reads the code when the problem touches it, and finds the open issues that must be done first;
2. judges whether the change fits one atomic commit that leaves the trunk green. When it is too big for one atomic commit, it proposes a split into issues that each land alone and keep the trunk green;
3. asks numbered questions until none is open, including whether you confirm the split;
4. creates the ready label with `gh label create` when the repository does not have it, then runs `gh issue create --body-file --blocked-by` with the body from [`template.md`](../skills/create-issue/template.md), the issues it depends on and no label, without showing the body first. The issue carries its blocker links from the moment it exists, so the worker waits for them even when `labels.ready` is empty and a run claims every open issue. It needs GitHub CLI 2.94.0 or later;
5. adds the ready label with `gh issue edit --add-label` only after it links every blocker. It adds the ready label and no other label. The ready label is the `labels.ready` label of `.next-issue/config.json`, or `status:todo` when `labels.ready` is not set or there is no config file. With an empty `labels.ready`, the issue gets no label, since the worker then claims every open issue. For a confirmed split, it creates each issue in turn with the links to the issues of the split it depends on, and only then adds its ready label;
6. calls `next_issue_refresh` with no question first. When a run is going, it gives you the issue url, says the run was asked to check for new issues now, and asks nothing. When no run is going, it gives you the url and asks only whether to start a run, and calls `next_issue_start` when you say yes. When the going run does not watch, it gives you the url and asks only whether to turn watching on, and calls `next_issue_watch` and `next_issue_refresh` when you say yes. When the going run is stopping, it gives you the url, says the run will not claim the issue, and asks nothing;
7. changes the issue with `gh issue edit --body-file` or `--title` when you ask for a change.

Claude files the issue, the ready label and the blocker links in the repository of the `remote` of `.next-issue/config.json`, or of `origin` when there is no config file or no `remote` field, as the worker does. It passes `--repo` to every `gh` command, so another remote, such as the `upstream` of a fork, never gets the issue.

The issue gets the ready label as soon as its blockers are linked, so a run that is already going may claim it before you review it.

Claude does not implement the issue in that session. The worker does the work. The body holds the sections of the [issue format](../../next-issue/docs/behaviour.md#issue-format).

## The worker

The plugin talks to the worker of the repository over plain HTTP on `.next-issue/worker.sock`, see [Worker](../../next-issue/docs/behaviour.md#worker). When no worker answers, `next_issue_start` and Start run `npx -y next-issue@<version> serve` in the repository, in the background, with its output in `.next-issue/worker.log`, and wait up to 2 minutes for it to listen. When the worker exits before it listens, they fail with `the next-issue worker exited before it listened (see .next-issue/worker.log)`.

`<version>` is the version of the plugin, or, for a plugin installed from the repository, the latest version of `next-issue` on npm. The plugin tells the worker that version when it first reaches it, so an older worker updates as it does for the other clients: an idle one closes and the plugin starts the newer one, and a watching run moves to the newer worker between issues. While the worker of a going run is older than the plugin, Watch and Hunt fail and ask you to stop the run and start it again.

## Develop

```bash
npm test
```

This runs the Node tests in `test/`, `claude plugin validate` and `claude plugin test`, with the Claude Code binary of `@anthropic-ai/claude-agent-sdk`. The plugin is not published to npm.
