import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { RunOptions } from './exec.ts';
import type { Question } from './protocol.ts';

type Gh = (args: string[], options: RunOptions) => Promise<string>;

const RETRY = 'Retry';
const GUIDE = 'Retry with guidance';
const GIVE_UP = 'Give up';

function threadsOf(question: Question): Array<[string, number]> {
  return question.pr === undefined
    ? [['issue', question.issue]]
    : [
        ['issue', question.issue],
        ['pr', question.pr],
      ];
}

function promptOf(question: Question): string {
  return `#${question.issue} ${question.title}\n\n${question.reason || 'No reason given.'}`;
}

export function answeredOf(question: Question, choice: string): string {
  return `next-issue: #${question.issue} ${choice === GIVE_UP ? 'given up' : 'will be retried'}`;
}

function labelsOf(question: Question, choice: string): string[] {
  const remove = ['--remove-label', question.labels.needsHuman];
  return choice === GIVE_UP ? [...remove, '--add-label', question.labels.skip] : remove;
}

export async function reply(
  gh: Gh,
  root: string,
  question: Question,
  choice: string,
  guidance: string,
): Promise<void> {
  const threads = threadsOf(question);
  const repo = ['--repo', question.repo];
  if (choice === GUIDE) {
    const [kind, number] = threads.at(-1)!;
    await gh([kind, 'comment', String(number), ...repo, '--body-file', '-'], {
      cwd: root,
      input: guidance,
    });
  }
  const labels = labelsOf(question, choice);
  for (const [kind, number] of threads) {
    await gh([kind, 'edit', String(number), ...repo, ...labels], { cwd: root });
  }
}

export async function ask(
  ui: ExtensionContext['ui'],
  question: Question,
): Promise<{ choice: string; guidance: string } | undefined> {
  const choice = await ui.select(promptOf(question), [RETRY, GUIDE, GIVE_UP]);
  if (choice === undefined) {
    return undefined;
  }
  if (choice !== GUIDE) {
    return { choice, guidance: '' };
  }
  const guidance = (await ui.editor(`Guidance for #${question.issue}`))?.trim() ?? '';
  return guidance === '' ? undefined : { choice, guidance };
}
