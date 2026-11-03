---
name: create-issue
description: Turn a problem into a clear GitHub issue that the next-issue worker can claim. Use when the user wants to write, file or create an issue.
---

# Create an issue

Turn the problem of the user into one GitHub issue in the format of `template.md`, next to this file.

1. Understand the problem. Restate it in your own words.
2. Investigate the code when the problem touches it. Read the relevant files and note what you find, with file paths. Run `gh issue list` and note each open issue that must be done first, including the issues you create in the same session.
3. Ask numbered questions about anything that is unclear: the scope, the expected behaviour, the acceptance criteria. Label options with letters and recommend one. Ask again until no question is open.
4. Write the body from `template.md` into a temporary file. Keep every heading of the template and its order. Leave `Open questions` empty.
5. Create the issue without showing the body first:

   ```bash
   gh issue create --title "<title>" --body-file <file> --label status:todo
   ```

6. Link each blocker:

   ```bash
   gh issue edit <number> --add-blocked-by <blocker>
   ```

7. Give the user the issue url. Ask once: a) start a run, b) leave it, c) change the issue.
8. When the user picks c, make the change on GitHub and ask again. Write the new body into the temporary file and run:

   ```bash
   gh issue edit <number> --body-file <file>
   ```

   To change the title, run:

   ```bash
   gh issue edit <number> --title "<title>"
   ```

9. Only when the user picks a, call the `next_issue_start` tool, and tell the user what it reports.

Once the issue exists, do not implement it in this session. The next-issue worker does the work. Once the user picks a or b, do not ask about a run again.

## Sections

- Problem: what is wrong or missing, and who it affects.
- Context and findings: what you found in the code and the docs, with paths.
- Acceptance criteria: a list of checks that show the issue is done, each one observable.
- Out of scope: what the issue does not cover.
- Open questions: empty when the issue is created.
