# next-issue

Works through the open GitHub issues of a repository with an agent.

| Package | Folder | Use |
| --- | --- | --- |
| [`next-issue`](packages/next-issue) | `packages/next-issue` | The command line harness. |
| [`@ravshansbox/pi-next-issue`](packages/pi-next-issue) | `packages/pi-next-issue` | The [pi](https://github.com/earendil-works/pi) extension. |

## Architecture

Each repository has one worker, `next-issue serve`, and two clients: the `next-issue` CLI and the `pi-next-issue` extension. The two clients keep feature parity. See [ADR 0005](docs/adr/0005-one-worker-two-clients.md).

## Develop

```bash
npm install
npm run typecheck
npm run lint
npm run format:check
npm test
npm run build
```

Each script runs in every package that has it.

## Releases

Both packages are released together with the same version. See
[Releases](packages/next-issue/README.md#releases).
