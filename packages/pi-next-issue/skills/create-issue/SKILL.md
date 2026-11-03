---
name: create-issue
description: Turn a problem into a clear GitHub issue that the next-issue worker can claim. Use when the user wants to write, file or create an issue.
---

# Create an issue

Turn the problem of the user into one GitHub issue in the format of `template.md`, next to this file.

1. Understand the problem. Restate it in your own words.
2. Investigate the code when the problem touches it. Read the relevant files and note what you find, with file paths.
3. Ask numbered questions about anything that is unclear: the scope, the expected behaviour, the acceptance criteria. Label options with letters and recommend one. Ask again until no question is open.
4. Write the body from `template.md` into a temporary file. Keep every heading of the template and its order. Leave `Open questions` empty.
5. Show the title and the body to the user. Ask once whether to create the issue and start a run: a) create the issue and start a run, b) create the issue only, c) change the draft. Change the draft and show it again until the user picks a or b.
6. Only after the user picks a or b, create the issue:

   ```bash
   gh issue create --title "<title>" --body-file <file> --label status:todo
   ```

7. Tell the user the issue url.
8. Only when the user picked a, call the `next_issue_start` tool, and tell the user what it reports.

Once the issue exists, do not implement it in this session. The next-issue worker does the work. Do not ask about a run a second time.

## Sections

- Problem: what is wrong or missing, and who it affects.
- Context and findings: what you found in the code and the docs, with paths.
- Acceptance criteria: a list of checks that show the issue is done, each one observable.
- Out of scope: what the issue does not cover.
- Open questions: empty when the issue is created.
