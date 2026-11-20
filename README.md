# next-issue

Works through the open GitHub issues of a repository with an agent.

| Package | Folder | Use |
| --- | --- | --- |
| [`next-issue`](packages/next-issue) | `packages/next-issue` | The command line harness. |

## Architecture

Each repository has one worker, the `serve` command of next-issue, and any number of clients that talk to it at the same time: instances of the `next-issue` CLI, see [ADR 0004](docs/adr/0004-one-worker-any-number-of-clients.md).

## Develop

```bash
npm install
npm run typecheck
npm run lint
npm run format
npm test
npm run build
```

Each script runs in every package that has it.

## Releases

`next-issue` is the only npm package. See
[Releases](packages/next-issue/docs/behaviour.md#releases).
