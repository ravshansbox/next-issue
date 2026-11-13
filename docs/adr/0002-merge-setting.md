# 2. Where the merge setting lives

## Status

Superseded by [ADR 0003](0003-land-without-pull-requests.md)

## Context

The harness can squash-merge a pull request after the approval. Two entry
points start a run, and each sets this in its own way:

- The command line has the `--merge` flag in
  `packages/next-issue/src/args.mts`. Without it, the merge stays with the
  user.
- The pi extension in `packages/pi-next-issue/index.ts` sends
  `{ type: 'start', root, merge: true }` from both `/next-issue` and the
  `next_issue_start` tool. A pi user cannot turn the merge off.

`.next-issue/config.json`, read by `packages/next-issue/src/config.mts`, has no
`merge` field. So the two entry points have opposite defaults and share no
setting, and nothing records which design is intended.

## Options

### A. A `merge` field in `.next-issue/config.json`

Add `merge: boolean` to the config. The worker reads it for each run, whatever
started the run. `--merge` on the command line still turns the merge on for
that run.

- Pro: one setting for both entry points, kept with the repository and its
  other run settings, such as `draftPullRequest`.
- Pro: the choice belongs to the repository, which fits: a repository with a
  merge queue or strict rules may want it, another may not.
- Pro: no change to the pi command or tool arguments.
- Con: one of the two defaults must change. A default of `false` stops pi
  runs from merging until the user sets the field; a default of `true`
  makes command-line runs merge without `--merge`.
- Con: `--merge` can only turn the merge on. Turning it off for one run needs
  the file, or a new flag such as `--no-merge`.
- Con: the `merge` field in the `start` message becomes unused or an override,
  so the protocol needs a small change.

### B. An argument to `/next-issue`

Accept an argument such as `/next-issue merge`, and a matching parameter on
`next_issue_start`. The extension passes it in the `start` message.

- Pro: the choice is made for each run, as on the command line.
- Pro: no config change, and the protocol stays as it is.
- Con: the two entry points still share no setting; the user must give the
  choice each time.
- Con: the agent picks the tool parameter, so a pi run could merge without the
  user asking for it.
- Con: `/next-issue` with no argument already starts or stops a run, and
  `answer` is its one subcommand; a second word adds to the command's surface.

### C. Keep things as they are

The command line merges only with `--merge`; pi always merges.

- Pro: no code change.
- Con: a pi user cannot keep the merge in their own hands.
- Con: the two entry points behave in opposite ways, which the README must
  explain.

## Decision

To be decided by the maintainer. The proposal is option A with a default of
`false`, so that both entry points keep the merge with the user unless the
repository asks for it, and `--merge` stays as an override for one run.

## Consequences

If option A is accepted:

- `config.mts` gains a `merge` field, `init` writes it, and the
  `next-issue` README documents it.
- The worker takes the merge setting from the config, with `--merge` on the
  command line as an override. The pi extension stops sending `merge: true`.
- Pi runs stop merging until the repository sets `"merge": true`. The release
  notes must say so.

If option B is accepted, the extension and the tool gain an argument and
the README of `pi-next-issue` documents it. If option C is accepted, the
README of `pi-next-issue` points to this record to explain why pi always
merges.
