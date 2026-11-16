---
name: create-issue
description: Turn a problem into a clear GitHub issue that the next-issue worker can claim. Use when the user wants to write, file or create an issue, or asks for a change to the code of a repository that has `.next-issue/config.json`.
---

# Create an issue

Turn the problem of the user into one GitHub issue, or a split of linked issues when the change is too big for one commit, in the format of `template.md`, next to this file.

1. Understand the problem. Restate it in your own words.
2. Find the repository, `<repo>`, that the worker reads. `<remote>` is the value of `remote` in `.next-issue/config.json` at the root of the repository. When there is no config file or no `remote` field, `<remote>` is `origin`. Run `git remote get-url <remote>` and take `<owner>/<name>` from the url, without `.git`. That is `<repo>`. When the host of the url is not `github.com`, `<repo>` is `<host>/<owner>/<name>`, so gh acts on that host. For an ssh url, such as `git@<host>:<owner>/<name>.git`, run `ssh -G <host>` and take the host from its `hostname` line, since `<host>` may be an alias from the ssh config. The host `ssh.github.com` means `github.com` (GitHub's ssh over port 443), so `<repo>` is then `<owner>/<name>`. Pass `--repo <repo>` to every `gh` command, since gh otherwise may pick another remote, such as `upstream`.

   Investigate the code when the problem touches it. Read the relevant files and note what you find, with file paths. Run `gh issue list --repo <repo>` and note each open issue that must be done first, including the issues you create in the same session.

3. Judge whether the change fits one atomic commit that leaves the trunk green. When it does not, propose a split into issues that each land alone and keep the trunk green, in the order they land, and note which issues of the split each one depends on.
4. Ask numbered questions about anything that is unclear: the scope, the expected behaviour, the acceptance criteria. When you propose a split, ask the user to confirm the split with the other questions. Label options with letters and recommend one. Ask again until no question is open.
5. Write the body from `template.md` into a temporary file. Keep every heading of the template and its order. Leave `Open questions` empty.
6. Find the ready label, `<ready>`: the value of `labels.ready` in `.next-issue/config.json` at the root of the repository. The worker claims only issues with that label. When `labels.ready` is not set, or there is no config file, `<ready>` is `status:todo`.

   Create the `<ready>` label when the repository does not have it:

   ```bash
   gh label list --repo <repo> --search "<ready>"
   gh label create --repo <repo> "<ready>"
   ```

   When `labels.ready` is empty (`""`), add no label, since the worker then claims every open issue. Skip the label commands.

   Then create the issue without showing the body first, and without a label. Pass every blocker with `--blocked-by`, so the issue carries its blocker links from the moment it exists and no run can claim it before its blockers, whatever `labels.ready` is:

   ```bash
   gh issue create --repo <repo> --title "<title>" --body-file <file> --blocked-by <blockers>
   ```

   `<blockers>` is the comma-separated list of the numbers of the issues it depends on. Leave out `--blocked-by <blockers>` when the issue has no blocker. When gh does not know `--blocked-by` (it needs GitHub CLI 2.94.0 or later), do not create the issue: ask the user to upgrade gh.

7. Only once the issue exists with every blocker linked, add the ready label, unless `labels.ready` is empty. Add no label other than `<ready>`:

   ```bash
   gh issue edit --repo <repo> <number> --add-label "<ready>"
   ```

   For a confirmed split, repeat steps 5 to 7 for each issue of the split, in order. Create each one with `--blocked-by` the issues of the split it depends on, so it is linked before you add its ready label.

8. Once the issue exists, or the last issue of a split, call the `next_issue_refresh` tool, with no question first.
9. When it reports that it asked the run, give the user the issue url, or each url of a split, and say that the going run was asked to check for new issues now. Ask no question.

   When it reports that no run is going, give the user the url or urls and ask only whether to start a run. On yes, call the `next_issue_start` tool, and tell the user what it reports. The run watches for new issues. On no, do nothing.

   When it reports that the going run is stopping, give the user the url or urls and say that the stopping run will not claim the issue. Ask no question.

   When it reports that the going run does not watch for new issues, give the user the url or urls and ask only whether to turn watching on. On yes, call the `next_issue_watch` tool with `on` set to `true`, then the `next_issue_refresh` tool, and tell the user what they report. On no, do nothing.

10. When the user asks for a change to the issue, make the change on GitHub. Write the new body into the temporary file and run:

    ```bash
    gh issue edit --repo <repo> <number> --body-file <file>
    ```

    To change the title, run:

    ```bash
    gh issue edit --repo <repo> <number> --title "<title>"
    ```

Once the issue exists, do not implement it in this session. The next-issue worker does the work. Once the user answers whether to start a run, do not ask about a run again.

## Sections

- Problem: what is wrong or missing, and who it affects.
- Context and findings: what you found in the code and the docs, with paths.
- Acceptance criteria: a list of checks that show the issue is done, each one observable. Write each check as a plain bullet (`- `), not a task-list checkbox (`- [ ]`), since nothing ticks the boxes.
- Out of scope: what the issue does not cover.
- Open questions: empty when the issue is created.
