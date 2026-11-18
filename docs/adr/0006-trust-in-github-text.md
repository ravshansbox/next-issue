# 6. Trust in GitHub text

## Status

Accepted

## Context

Agent prompts hold the title, body and comments of an issue, which come from GitHub. On a public repository anyone can open an issue or comment, and an author can edit the body after a maintainer adds the ready label.

## Options

### A. Trust only people with write access

- Pro: a person with write access can still guide the agent in a comment or an answer.
- Pro: text from anyone else never reaches an agent as an instruction.
- Con: an issue opened by anyone else waits until a person with write access changes it.

### B. Trust all text

- Pro: no access checks.
- Con: anyone who can open an issue can instruct an agent that has a full shell (ADR 7).

## Decision

Option A.

- Agents get only the comments of people with write or admin access.
- When a person without write or admin access last changed the title or the body, no agent gets the issue: it goes to a person with the reason `untrusted editor`.
- The body, check logs, hook output, diffs, the replies of other agents and earlier findings go inside `untrusted` fences, and the prompt tells the agent to treat them as data, not instructions.

## Consequences

- The fences are advice to the model, not a hard limit.
- An agent can still read other text by itself, such as linked issues or files.
- `.next-issue/notes.md`, which agents write for later agents, reaches every prompt outside the fences.
