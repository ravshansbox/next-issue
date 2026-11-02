import { readFile } from "node:fs/promises";
import { join } from "node:path";

export async function packageVersion(): Promise<string> {
  const raw = await readFile(join(import.meta.dirname, "..", "package.json"), "utf8");
  return (JSON.parse(raw) as { version: string }).version;
}
