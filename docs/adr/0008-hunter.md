# 8. The hunter

## Status

Accepted

## Context

A watching run waits when no issue is ready. In a humanless flow (ADR 2), the harness can use that time to find its own work.

## Options

### A. A hunter in the run, opt-in

An agent reads the repository for bugs and files issues.

- Pro: the run keeps finding bugs with nobody filing issues.
- Con: a person must add the ready label to each hunted issue before it is claimed.
- Con: the hunter tends to find rare edge cases, often in code that earlier hunted fixes added.

### B. No hunter

- Pro: less code, and every issue comes from a person.
- Con: the run waits idle when no issue is ready.

## Decision

Option A.

- Hunting is off by default. `--hunt on` or `npx -y next-issue@latest hunt on` turns it on, and it needs watching.
- The hunter hunts only while fewer than `huntCap` issues wait, counting ready issues and hunted issues without the ready label, and files at most enough to reach it.
- It follows `.next-issue/hunt.md`, or a built-in prompt.
- The built-in prompt files only high-severity bugs that a user hits in normal use, and proposes to remove or simplify code that an earlier fix added instead of adding another guard, so the hunter does not file rare edge cases or grow the code it hunts.
- It works in its own worktree, gets the tools of the reviewer (ADR 7) and changes no file.
- Its issues get the `source:hunt` label and not the ready label. A person adds the ready label to approve each one. The hunter reads issue titles that anyone can write and runs `gh` and Bash with no permission checks, and its issues pass the write-access check (ADR 6), so a crafted title could otherwise steer it into filing work that the implementer runs with full shell access.
- After a hunt that files nothing or fails, it waits 1, 2, 3, 5, then 10 minutes.

## Consequences

- The hunter files issues as the `gh` user, so they pass the write-access check (ADR 6); the missing ready label keeps them from being claimed until a person approves them.
- There is no limit on the number of hunts in a run.
