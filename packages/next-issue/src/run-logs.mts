import { succeeded } from './exec.mts';
import { ghRun } from './gh.mts';
import type { Repo } from './git.mts';
import { joinFilled } from './text.mts';

export async function runLogs(
  repo: Repo,
  failed: Array<{ heading: string; runId: string | undefined }>,
  maxChars: number,
): Promise<string> {
  const share = Math.max(1, Math.floor(maxChars / Math.max(1, failed.length)));
  const parts: string[] = [];
  for (const { heading, runId } of failed) {
    parts.push(heading);
    if (runId === undefined) {
      continue;
    }
    parts.push(await runLog(repo, runId, share));
  }
  return parts.join('\n\n');
}

async function runLog(repo: Repo, runId: string, share: number): Promise<string> {
  const logs = await ghRun(repo, ['run', 'view', runId, '--log-failed'], { tailChars: share });
  if (succeeded(logs)) {
    return logs.stdout;
  }
  const reason = joinFilled(
    [`The log read failed with code ${logs.code}.`, logs.stderr.trim()],
    ' ',
  );
  return joinFilled([logs.stdout.trim(), reason], '\n');
}
