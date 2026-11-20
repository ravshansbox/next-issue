# 2. A humanless flow

## Status

Accepted

## Context

The harness exists to work through issues with nobody waiting on it. Without a stated rule, each proposal to add a human step is judged anew and the design drifts.

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

## Decision

Option A.

- Writing or approving an issue is the human step. Everything from the claim to a closed issue is the harness's. People come back only on a hand-over (ADR 5).
- A human gate may exist only as an opt-in that is off by default and adds no complexity to the default path.

### Recommended setup

These safeguards replace the human checks. The harness enforces the first one.

- The local gate: the `format`, `lint`, `typecheck` and `test` scripts of the root `package.json`, which the harness requires and runs before each push (ADR 9).
- A different model for the reviewer than for the implementer and the fixer, in `models`.
- The whole harness in a container (ADR 7).

## Consequences

- Every change passes the local gate before it reaches the base branch; CI runs only after that (ADR 3).
- By default every agent role uses the same model.
- The reviewer prompt names correctness, scope, conventions and test cover, not security.
