import { access } from "node:fs/promises";
import { join } from "node:path";

const MARKERS: Array<[string, string]> = [
  ["pnpm-lock.yaml", "pnpm install --frozen-lockfile"],
  ["package-lock.json", "npm ci"],
  [".yarnrc.yml", "yarn install --immutable"],
  ["yarn.lock", "yarn install --frozen-lockfile"],
  ["bun.lock", "bun install --frozen-lockfile"],
  ["bun.lockb", "bun install --frozen-lockfile"],
  ["Cargo.lock", "cargo fetch"],
  ["go.sum", "go mod download"],
  ["uv.lock", "uv sync"],
  ["poetry.lock", "poetry install"],
  ["Gemfile.lock", "bundle install"],
];

export async function detectSetupCommand(root: string): Promise<string | undefined> {
  for (const [file, command] of MARKERS) {
    try {
      await access(join(root, file));
      return command;
    } catch {
      continue;
    }
  }
  return undefined;
}
