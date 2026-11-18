# next-issue

Works through the open GitHub issues of a repository with an agent.

| Package | Folder | Use |
| --- | --- | --- |
| [`next-issue`](packages/next-issue) | `packages/next-issue` | The command line harness. |
| [`@ravshansbox/pi-next-issue`](packages/pi-next-issue) | `packages/pi-next-issue` | The [pi](https://github.com/earendil-works/pi) extension. |
| [`next-issue` plugin](packages/claude-next-issue) | `packages/claude-next-issue` | The Claude Code plugin, installed with `/plugin install next-issue --marketplace ravshansbox/next-issue`. |

## Architecture

Each repository has one worker, `next-issue serve`, and its clients: the `next-issue` CLI, the `pi-next-issue` extension and the Claude Code plugin. The clients keep feature parity. See [ADR 0005](docs/adr/0005-one-worker-two-clients.md).

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

The two npm packages are released together with the same version. The Claude Code plugin is not published to npm: `.claude-plugin/marketplace.json` serves it from this repository. See
[Releases](packages/next-issue/README.md#releases).
