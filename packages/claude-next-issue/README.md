# next-issue plugin for Claude Code

A Claude Code plugin that works through the open GitHub issues of a repository in the background, while you keep using Claude Code. The work is done by the [`next-issue`](../next-issue) worker, which this plugin starts and talks to.

Install it from this repository's marketplace in Claude Code:

```text
/plugin install next-issue --marketplace ravshansbox/next-issue
```

Or add the marketplace first with `/plugin marketplace add ravshansbox/next-issue`, then run `/plugin install next-issue@next-issue`. Keep the plugin named `next-issue` in the marketplace `next-issue`: the worker's agents run Claude Code too, and they leave out the plugin `next-issue@next-issue`, so its tools never reach them.

It needs `git`, `node` with `npx`, and an authenticated [`gh`](https://cli.github.com/). It works on macOS and Linux. The repository must be on GitHub: `github.com` or a GitHub Enterprise host, which `gh` must be logged in to.

## Use

In Claude Code, inside a git repository, run `/next-issue` to open the dashboard in a pane beside the conversation. The row above the prompt shows the going run and how many hand-overs wait for a person. See [Use](https://github.com/ravshansbox/next-issue/blob/main/packages/claude-next-issue/docs/behaviour.md#use).

### Dashboard

- Active shows the going run, with Start, Stop, Watch, Hunt and Refresh.
- Past lists the runs kept under `.next-issue/runs/`.
- The detail view of an issue shows its run events, worker log lines and what each agent said.
- Hand-overs lists the issues that wait for a person, with Retry, Retry with guidance and Give up.
- Upcoming lists the issues that the worker would claim, and the blocked ones.

### Tools

The model gets six tools, listed as `mcp__next-issue__<name>`:

- `next_issue_start` starts a run when none is going.
- `next_issue_refresh` asks the going run to check for new issues now.
- `next_issue_watch` switches watching of the going run on or off.
- `next_issue_hunt` switches hunting of the going run on or off.
- `next_issue_stop` asks the going run to stop.
- `next_issue_status` reports the run.

The `create-issue` and `answer-hand-over` skills now ship with `next-issue`: run `npx -y next-issue@latest update` to install them, see [Skills](https://github.com/ravshansbox/next-issue/blob/main/packages/next-issue/docs/behaviour.md#skills).

## Links

- [Use](https://github.com/ravshansbox/next-issue/blob/main/packages/claude-next-issue/docs/behaviour.md#use)
- [The worker](https://github.com/ravshansbox/next-issue/blob/main/packages/claude-next-issue/docs/behaviour.md#the-worker)
- [Develop](https://github.com/ravshansbox/next-issue/blob/main/packages/claude-next-issue/docs/behaviour.md#develop)
