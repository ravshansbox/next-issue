# next-issue plugin for Claude Code

A Claude Code plugin that works through the open GitHub issues of a repository in the background, while you keep using Claude Code. The work is done by the [`next-issue`](../next-issue) worker, which this plugin starts and talks to.

Install it from this repository's marketplace in Claude Code:

```text
/plugin install next-issue --marketplace ravshansbox/next-issue
```

Or add the marketplace first with `/plugin marketplace add ravshansbox/next-issue`, then run `/plugin install next-issue@next-issue`. Keep the plugin named `next-issue` in the marketplace `next-issue`: the worker's agents run Claude Code too, and they leave out the plugin `next-issue@next-issue`, so its skills and tools never reach them.

It needs `git`, `node` with `npx`, and an authenticated [`gh`](https://cli.github.com/). It works on macOS and Linux. The repository must be on GitHub: `github.com` or a GitHub Enterprise host, which `gh` must be logged in to.

## Use

In Claude Code, inside a git repository:

- `/next-issue` opens the dashboard in a pane beside the conversation. Where no pane can be drawn, it asks what to do instead, with the actions that fit the run: Start when no run is going; Stop, Watch on or Watch off, Hunt on or Hunt off, and Refresh when a run is going. Stop then asks when to stop. Where nobody can be asked, such as `claude -p`, it prints the status of the run.
- The status line, under the plugin's name, shows the going run, such as `4 issues · #7 · implement · 3m`, and how many hand-overs wait for a person, such as `1 question waiting`. The plugin reads the worker each second and the hand-overs each minute while the session is open. A finished or stopped run leaves the status line.
- The dashboard has four tabs:
  - Active shows the going run: its status, whether it watches and hunts, the open-issue count, each running issue with its stage and time spent, and each handled issue with its outcome. With no run going, it shows the status and error of the last run. Its actions are Start, or Stop after the running issues, Stop after the current round of each running issue, Stop at once, Watch on or Watch off, Hunt on or Hunt off, and Refresh. Each shows its result as a toast. A running or handled issue opens its detail view.
  - Past lists the runs kept under `.next-issue/runs/`, newest first, each with its start time in UTC and its end: `finished`, `stopped`, `failed` or `not ended`. The chosen run shows its error, each issue with its outcome and reason, and the tokens and time of each role from its summary. An issue opens its detail view in that run.
  - The detail view of an issue shows its run events in time order (UTC), its lines in `.next-issue/worker.log` (local time), and what each agent said, called and got back, from the sessions under `.next-issue/runs/<runId>/sessions/`. Back returns.
  - Hand-overs lists the issues that wait for a person, each with its reason and link, and Retry, Retry with guidance and Give up. Retry swaps the `needsHuman` label for the `ready` label and asks the going run to check for new issues. Retry with guidance posts the guidance as a comment first; guidance that starts with a heading of the harness, such as `### Review:`, is refused, since it would not count as an answer. Give up swaps the label for the `skip` label, and creates that label when the repository lacks it.
  - Upcoming lists the issues that the worker would claim, in the order it claims them, and the blocked ones with their blockers.
- The model gets six tools, listed as `mcp__next-issue__<name>`:
  - `next_issue_start` starts a run when none is going: it watches and does not hunt. It starts the worker when none answers. When a run is going, it starts nothing, asks that run to check for new issues now (unless it is stopping or does not watch) and reports that run.
  - `next_issue_refresh` asks the going run to check for new issues now. It never starts a worker or a run.
  - `next_issue_watch` and `next_issue_hunt` switch watching or hunting of the going run on or off, with no restart. Watch off also turns hunting off, and hunt on also turns watching on.
  - `next_issue_stop` asks the going run to stop after the running issues (`issue`, the default), after the current round (`round`) or at once (`now`).
  - `next_issue_status` reports the run: its status line, watching, hunting and each handled issue. It never starts a worker.
  - A tool that cannot do what it was asked fails with the reason, such as `no run of <root> is going`.
- The `create-issue` skill turns a problem into an issue in the format that the worker reads, and the `answer-hand-over` skill explains a hand-over and answers it. Both call `next_issue_refresh` once they are done, and offer to start a run or turn watching on when that is what the run needs.

## The worker

The plugin talks to the worker of the repository over plain HTTP on `.next-issue/worker.sock`, see [Worker](../next-issue/README.md#worker). When no worker answers, `next_issue_start` and Start run `npx -y next-issue@<version> serve` in the repository, in the background, with its output in `.next-issue/worker.log`, and wait up to 2 minutes for it to listen. When the worker exits before it listens, they fail with `the next-issue worker exited before it listened (see .next-issue/worker.log)`.

`<version>` is the version of the plugin, or, for a plugin installed from the repository, the latest version of `next-issue` on npm. The plugin tells the worker that version when it first reaches it, so an older worker updates as it does for the other clients: an idle one closes and the plugin starts the newer one, and a watching run moves to the newer worker between issues. While the worker of a going run is older than the plugin, Watch and Hunt fail and ask you to stop the run and start it again.

## Develop

```bash
npm test
```

This runs the Node tests in `test/`, `claude plugin validate` and `claude plugin test`, with the Claude Code binary of `@anthropic-ai/claude-agent-sdk`. The plugin is not published to npm.
