# 4. A humanless flow

## Status

Accepted

## Context

The harness is built for a flow with as few people in it as possible, but no
record says so. Today:

- a person, or the hunter with `--hunt`, files an issue. The `create-issue`
  skill adds the ready label without showing the body first, and a going run
  may claim the issue before anyone reviews it;
- the implementer, the reviewer and the fixer agents take the issue to a
  landed commit on the base branch, with no pull request and no human
  approval ([ADR 0003](0003-land-without-pull-requests.md));
- a person comes in only on a hand-over (`status:needs-human`), answered with
  the `answer-hand-over` skill.

Without a record, these choices look like oversights rather than design, and
there is no rule to judge a proposal that adds a human step.

## Options

### A. Humanless by default

People own intent and exceptions. Everything else is the harness's.

- Pro: the harness works through issues with nobody waiting on it.
- Pro: one default path to build, test and keep.
- Con: automatic safeguards must replace human checks, and some risks stay.

### B. A human gate by default

A person approves each issue before the claim, or each change before it lands.

- Pro: a person sees every change before it reaches the base branch.
- Con: each issue waits for a person, which defeats the aim of the harness.
- Con: more states, labels and code on the default path.

### C. No stated rule

- Pro: no change.
- Con: each proposal for a human step is judged anew, and the design drifts.

## Decision

Option A.

- Humanless by default. A human gate may exist only as an opt-in that is off
  by default and adds no complexity to the default path. A proposal that adds
  a human step to the default path is rejected.
- The human boundary: writing or approving an issue is the human step.
  Everything from the claim to a closed issue is the harness's. People come
  back only on a hand-over. The hunter filing its own issues fits this, as it
  acts only within the trust the maintainer gave by turning `--hunt` on.
- [ADR 0003](0003-land-without-pull-requests.md) is an application of this
  principle.

### Recommended setup

These safeguards replace the human checks. The harness does not enforce them.

- Set a non-empty `checks` gate in `.next-issue/config.json`, so each change
  passes the checks before it is pushed.
- Give the reviewer a different model from the implementer and the fixer in
  `models`, so the review does not share the blind spots of the author.
- Run the whole harness in a container, the main isolation step of
  [ADR 0001](0001-reviewer-isolation.md).

## Consequences

These risks are accepted:

- With `checks` empty (the default), CI runs only after the change is on the
  base branch, so the base can be red until a fix or a revert lands
  ([ADR 0003](0003-land-without-pull-requests.md)).
- A direct push to the base branch rules out GitHub branch protection with
  required reviews or required status checks.
- Agents run any command with the rights of the user, and the reviewer keeps a
  full shell ([ADR 0001](0001-reviewer-isolation.md)).
- By default all agent roles use the same model (`models` in the config).
- The reviewer prompt (`reviewScope` in `packages/next-issue/src/prompts.mts`)
  names correctness, scope, conventions and test cover, not security.
- Budgets count rounds, not tokens or cost.
