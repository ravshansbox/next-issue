import { succeeded } from './exec.mts';
import { ghRun } from './gh.mts';
import type { Repo } from './git.mts';
import { joinFilled } from './text.mts';

export async function runLogs(
  repo: Repo,
  failed: Array<{ heading: string; view: string[] | undefined }>,
  maxChars: number,
): Promise<string> {
  const withLog = failed.filter(({ view }) => view !== undefined).length;
  const share = Math.max(1, Math.floor(maxChars / Math.max(1, withLog)));
  const parts: string[] = [];
  for (const { heading, view } of failed) {
    parts.push(heading);
    if (view === undefined) {
      continue;
    }
    parts.push(await runLog(repo, view, share));
  }
  return parts.join('\n\n');
}

async function runLog(repo: Repo, view: string[], share: number): Promise<string> {
  const logs = await ghRun(repo, ['run', 'view', ...view, '--log-failed'], { tailChars: share });
  if (succeeded(logs)) {
    return logs.stdout;
  }
  const reason = joinFilled(
    [`The log read failed with code ${logs.code}.`, logs.stderr.trim()],
    ' ',
  );
  return joinFilled([logs.stdout.trim(), reason], '\n');
}
