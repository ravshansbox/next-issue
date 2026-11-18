# 5. Budgets and hand-over

## Status

Accepted

## Context

The review, fix and CI loops can go on for ever when an agent cannot finish the work. With nobody watching (ADR 2), the harness needs its own rule for when to stop.

## Options

### A. A budget per loop, then a hand-over

- Pro: each issue ends, either done or with a person.
- Pro: one way out of every loop, which a person can retry.
- Con: an issue that needed one more round goes to a person.

### B. No limit

- Pro: no issue goes to a person too early.
- Con: a stuck issue holds a slot and spends money for ever.

### C. A limit on cost

- Pro: matches what a user pays for.
- Con: needs token counts and a number that fits every repository.

## Decision

Option A.

- Each issue has a budget of review rounds (`maxReviewRounds`), CI fixes (`maxCiFixes`) and fixes of a commit that a git hook stopped (`maxCommitFixes`), and each agent call has a time limit (`agentTimeoutMinutes`).
- When a budget runs out or the work cannot go on, the harness reverts any change it landed, gives the issue `status:needs-human` and comments the reason. Then it takes the next issue.
- A person answers on the issue, with the `answer-hand-over` skill, and the next run claims it again.
- When the base branch is broken and cannot be fixed, the run claims no new issue.

## Consequences

- Budgets count rounds, not tokens or cost.
