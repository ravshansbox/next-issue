---
name: create-issue
description: Turn a problem into a clear GitHub issue that the next-issue worker can claim. Use when the user wants to write, file or create an issue, or asks for a change to the code of a repository that has `.next-issue/config.json`.
---

# Create an issue

Turn the problem of the user into one GitHub issue, or a split of linked issues when the change is too big for one commit, in the format of `template.md`, next to this file.

1. Understand the problem. Restate it in your own words.
2. Investigate the code when the problem touches it. Read the relevant files and note what you find, with file paths. Run `gh issue list` and note each open issue that must be done first, including the issues you create in the same session.
3. Judge whether the change fits one atomic commit that leaves the trunk green. When it does not, propose a split into issues that each land alone and keep the trunk green, in the order they land, and note which issues of the split each one depends on.
4. Ask numbered questions about anything that is unclear: the scope, the expected behaviour, the acceptance criteria. When you propose a split, ask the user to confirm the split with the other questions. Label options with letters and recommend one. Ask again until no question is open.
5. Write the body from `template.md` into a temporary file. Keep every heading of the template and its order. Leave `Open questions` empty.
6. Find the ready label, `<ready>`: the value of `labels.ready` in `.next-issue/config.json` at the root of the repository. The worker claims only issues with that label. When `labels.ready` is not set, or there is no config file, `<ready>` is `status:todo`.

   Create the `<ready>` label when the repository does not have it:

   ```bash
   gh label list --search "<ready>"
   gh label create "<ready>"
   ```

   Then create the issue without showing the body first. Add no label other than `<ready>`:

   ```bash
   gh issue create --title "<title>" --body-file <file> --label "<ready>"
   ```

   When `labels.ready` is empty (`""`), add no label, since the worker then claims every open issue. Skip the label commands and run:

   ```bash
   gh issue create --title "<title>" --body-file <file>
   ```

7. Link each blocker:

   ```bash
   gh issue edit <number> --add-blocked-by <blocker>
   ```

   For a confirmed split, repeat steps 5 to 7 for each issue of the split, in order. Link each one to the issues of the split it depends on.

8. Give the user the issue url, or each url of a split. Ask once: a) start a run, b) leave it, c) change the issue.
9. When the user picks c, make the change on GitHub and ask again. Write the new body into the temporary file and run:

   ```bash
   gh issue edit <number> --body-file <file>
   ```

   To change the title, run:

   ```bash
   gh issue edit <number> --title "<title>"
   ```

10. Only when the user picks a, call the `next_issue_start` tool, and tell the user what it reports.

Once the issue exists, do not implement it in this session. The next-issue worker does the work. Once the user picks a or b, do not ask about a run again.

## Sections

- Problem: what is wrong or missing, and who it affects.
- Context and findings: what you found in the code and the docs, with paths.
- Acceptance criteria: a list of checks that show the issue is done, each one observable.
- Out of scope: what the issue does not cover.
- Open questions: empty when the issue is created.
