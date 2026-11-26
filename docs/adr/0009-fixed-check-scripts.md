# 9. Fixed check scripts

## Status

Accepted

## Context

The humanless flow (ADR 2) relies on automatic checks instead of a person. With an optional `checks` field that is empty by default, a project could run with no local gate: the reviewer was then the only check before a push, and CI ran only once the change was on the base branch.

## Options

### A. Keep `checks` optional

- Pro: works with any project and any build tool.
- Con: a project with no checks gives the fixer no failure to act on, and nothing tells the owner.

### B. Require `checks` to be non-empty

- Pro: works with any build tool.
- Con: one trivial command, such as `true`, passes the rule, so it says little about the project.

### C. npm-style projects only, with the fixed script names `format`, `lint`, `typecheck` and `test`

- Pro: the four scripts show that the owner set up a formatter, a linter, a type checker and tests on purpose.
- Pro: no config field to keep; the harness runs the same gate in every project.
- Con: a project needs a root `package.json`, so projects without one are not supported.

## Decision

Option C.

- The harness reads only the `scripts` of the root `package.json`, not those of workspace packages.
- Each script must fail on a problem; `format` checks and does not write files.
- The harness runs the setup again, then the four scripts in that order, before each push, with the package manager of the lock file (`npm run` with no JS lock file), each for at most `checksTimeoutMinutes`.
- `checks` is no longer a config field.
- `start` stops before the run starts, and `init` exits with 1 after its usual work, when a script is missing.

## Consequences

- A project without a root `package.json` cannot use the harness.
- The harness does not set the tools up for a project; the owner does.
- `init`, `start` and `serve` remove an existing `checks` field from the config file and print `removed checks from .next-issue/config.json`.
