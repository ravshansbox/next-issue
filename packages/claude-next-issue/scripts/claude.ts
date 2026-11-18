import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const platform = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
const binary = join(dirname(require.resolve(`${platform}/package.json`)), 'claude');
const result = spawnSync(binary, process.argv.slice(2), { stdio: 'inherit' });
process.exit(result.status ?? 1);
