---
name: answer-hand-over
description: Investigate an issue that the next-issue worker handed over to a person, explain the blocker and answer it with a retry, guidance or give up. Use when the user wants to answer, look into or unblock a next-issue question or a `needs-human` issue.
---

# Answer a hand-over

Help the user understand why the worker handed an issue over, then answer the hand-over on GitHub. Do not fix the code of the issue yourself. The worker does the work.

1. Find the repository, `<repo>`, that the worker reads. `<remote>` is the value of `remote` in `.next-issue/config.json` at the root of the repository. When there is no config file or no `remote` field, `<remote>` is `origin`. Run `git remote get-url <remote>` and take `<owner>/<name>` from the url, without `.git`. That is `<repo>`. When the host of the url is not `github.com`, `<repo>` is `<host>/<owner>/<name>`, so gh acts on that host. For an ssh url, such as `git@<host>:<owner>/<name>.git`, run `ssh -G <host>` and take the host from its `hostname` line, since `<host>` may be an alias from the ssh config. The host `ssh.github.com` means `github.com` (GitHub's ssh over port 443), so `<repo>` is then `<owner>/<name>`. Pass `--repo <repo>` to every `gh` command, since gh otherwise may pick another remote, such as `upstream`.
2. Find the labels. `<needs-human>` is the value of `labels.needsHuman` in `.next-issue/config.json`, or `status:needs-human` when it is not set or there is no config file. `<skip>` is the value of `labels.skip` in `.next-issue/config.json`, or `status:blocked` when it is not set or there is no config file.
3. List the waiting issues:

   ```bash
   gh issue list --repo <repo> --state open --label "<needs-human>" --json number,title,url
   ```

   When the list is empty, say so and stop. When it holds one issue, pick it. Otherwise show the list and ask the user which one to answer, with lettered options and a recommendation.

4. Read the issue and its comments:

   ```bash
   gh issue view --repo <repo> <number> --comments
   ```

   Only comments from users with write access to `<repo>` count, both for the hand-over comment and for an answer. To see the author of each comment, run:

   ```bash
   gh issue view --repo <repo> <number> --json comments --jq '.comments[] | {author: .author.login, authorAssociation, createdAt}'
   ```

   An author whose `authorAssociation` is not `OWNER`, `MEMBER` or `COLLABORATOR` has no write access. When you cannot tell whether an author has write access, ask the user. Find the latest comment from a writer that starts with `next-issue needs help:`. Its text after that heading is the reason of the hand-over. It may list the questions of the implementer on `question:` lines. Note the comments from writers posted after it, since the next run reads them as the answer.

5. Read the work of the issue when there is any. The branch is `<number>`, in the worktree `.worktrees/<number>` at the root of the repository, or on `<remote>`. The hand-over may also name `<number>-dispute-<commit>` branches. Find the base branch with `git ls-remote --symref <remote> HEAD`, fetch `<remote>`, then read the commits and the diff:

   ```bash
   git log --oneline <remote>/<base>..<branch>
   git diff <remote>/<base>...<branch>
   ```

   Use the local branch when `<remote>` does not have it. Skip this step when neither has it.

6. When the hand-over names failed checks, read their logs. For checks on the base branch, find the failed runs of the commit that the hand-over names, or of the latest commit of the issue on the base, then read the failed jobs:

   ```bash
   gh run list --repo <repo> --commit <sha> --status failure --json databaseId,name,url
   gh run view --repo <repo> <run> --log-failed
   ```

   For `local checks failed: <command>`, the command comes from `checks` in `.next-issue/config.json`. Ask the user before you run it in `.worktrees/<number>`.

7. Explain the blocker to the user in plain words: what the worker tried, what stopped it and what it needs from a person. Quote the reason and the questions of the hand-over where that helps.
8. Ask numbered questions, with the answers of the questions of the hand-over among them. Label options with letters and recommend one. Ask again until you know whether to retry, retry with guidance or give up, and, for guidance, its text.
9. Answer the hand-over:

   - Retry: remove the label, so the next run resumes the issue.

     ```bash
     gh issue edit --repo <repo> <number> --remove-label "<needs-human>"
     ```

   - Retry with guidance: write the guidance into a temporary file, post it as one comment, then remove the label. The guidance must not start with `next-issue needs help:`, `### Review:` or `### Fixer:`, since a comment that starts with a heading of the harness never counts as an answer.

     ```bash
     gh issue comment --repo <repo> <number> --body-file <file>
     gh issue edit --repo <repo> <number> --remove-label "<needs-human>"
     ```

   - Give up: find the `<skip>` label in the repository. Compare label names without case, as GitHub does, and use the name that the repository has:

     ```bash
     gh label list --repo <repo> --limit 1000 --json name
     ```

     When the repository does not have it, create it first:

     ```bash
     gh label create --repo <repo> "<skip>"
     ```

     When you cannot create it, tell the user and leave the issue labels as they are. Otherwise remove the label and add `<skip>`:

     ```bash
     gh issue edit --repo <repo> <number> --remove-label "<needs-human>" --add-label "<skip>"
     ```

10. After a retry, with or without guidance, call the `next_issue_refresh` tool, with no question first. When it reports that it asked the run, tell the user that the going run was asked to check for issues now. Ask no question.

    When it reports that no run is going, ask only whether to start a run. On yes, call the `next_issue_start` tool, and tell the user what it reports. On no, do nothing.

11. Ask whether to answer another waiting issue. On yes, go back to step 3.
