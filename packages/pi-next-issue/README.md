# pi-next-issue

A [pi](https://github.com/earendil-works/pi) extension that works through the open GitHub issues of a repository in the background, while you keep using pi.

```bash
pi install npm:@ravshansbox/pi-next-issue
```

It needs `git` and an authenticated [`gh`](https://cli.github.com/). It works with github.com and GitHub Enterprise remotes.

## Use

Run this in pi, inside a git repository:

- `/next-issue` starts a run when none is going, and stops the run when one is going or stopping. A stopped issue keeps its saved state, and the next run resumes it.

The footer shows the issue, the stage, the number of tool calls and the time spent on the issue, for example `next-issue #12 · review 1/3 · 37 tools · 4m12s`. After a run ends, it keeps the last summary. A line above the editor shows the last tool call. In the terminal, both use the dim colour of the theme, like the rest of the footer. A note appears when an issue is merged or needs a human.

The run does not belong to a session: it goes on after `/new`, `/resume`, a fork or a reload, and the new session shows it. It stops when you quit pi.

## What it does

Each loop fetches the 200 oldest open issues with the `status:todo` label and none of `status:in-progress`, `status:done`, `status:needs-human` or `status:blocked`, and the open issues with saved state that it can read. It takes the oldest one with saved state and none of `status:done`, `status:needs-human` or `status:blocked`, else the oldest one with the `status:todo` label and none of `status:in-progress`, `status:done`, `status:needs-human` or `status:blocked`. The run ends when no such issue is left, or at the first error. For each issue:

1. Swap `status:todo` for `status:in-progress`.
2. Add a git worktree at `.worktrees/<n>` on the `<n>` branch, from the remote default branch.
3. The implementer agent does the work. The extension commits it, with the subject from a `commit:` line in the reply of the agent, and pushes. When a resumed issue already has a commit ahead of the base, the extension keeps it and skips the implementer.
4. Open a pull request that closes the issue.
5. Wait for the checks. On a red build, the fixer agent gets the failed logs. It gets at most `maxCiFixes` such fixes for the whole issue, and this count includes the checks after review fixes.
6. The reviewer agent judges the diff and gives a verdict with `blocking` and `minor` findings, which goes on the pull request. Any change the reviewer makes is thrown away.
7. While review rounds are left, the fixer gets every finding, and the checks and the review run again. In the last round only a blocking finding stops the merge.
8. Squash-merge the pull request, wait until it is merged, set `status:done`, and remove the worktree, the local branch, the remote branch and the saved state.

An issue that cannot go on gets `status:needs-human` and a comment with the reason. Its worktree stays for you to look at.

The implementer and the reviewer read the issue title, the body and the comments. They get only comments by the owner, members and collaborators of the repository. The body is passed as it is, and its author can edit it after you add the label, so check the body before you add the label.

Each agent is a pi session in the worktree. It uses the model and thinking level from your pi settings, and loads all of your extensions except this one.

The state of each issue is saved in `.worktrees/<n>.json`. Each loop removes the saved state of an issue that is closed. A run holds `.worktrees/run.lock`, which keeps the process id, so that only one pi at a time works on a repository. A second run fails at once. A lock whose process is no longer alive is taken over. If the operating system gives that process id to another process, the lock stays; remove `.worktrees/run.lock` by hand when no run is going. The extension adds `/.worktrees/` to `.git/info/exclude`.

## Config

An optional `.pi/next-issue.json` in the repository sets these fields:

| Field                 | Default    | Meaning                                                                           |
| --------------------- | ---------- | --------------------------------------------------------------------------------- |
| `remote`              | `"origin"` | The git remote to push to.                                                        |
| `maxCiFixes`          | `3`        | Fixes of red checks for the whole issue, including the checks after review fixes. |
| `maxReviewRounds`     | `3`        | Review rounds per issue.                                                          |
| `checkTimeoutMinutes` | `30`       | The longest wait for the checks, and for a merge.                                 |
| `diffMaxChars`        | `60000`    | The longest diff that the reviewer gets.                                          |
| `logMaxChars`         | `20000`    | The longest failed log that the fixer gets.                                       |
