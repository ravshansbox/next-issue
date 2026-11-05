import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { RunOptions } from './exec.ts';
import type { Question } from './protocol.ts';
import { fresh } from './requests.ts';
import type { WorkerClient } from './worker.ts';

export type Gh = (args: string[], options: RunOptions) => Promise<string>;

const RETRY = 'Retry';
const GUIDE = 'Retry with guidance';
const GIVE_UP = 'Give up';

type Answer = { choice: string; guidance: string };

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

function answeredOf(question: Question, choice: string): string {
  return `next-issue: #${question.issue} ${choice === GIVE_UP ? 'given up' : 'will be retried'}`;
}

function labelsOf(question: Question, choice: string): string[] {
  const remove = ['--remove-label', question.labels.needsHuman];
  return choice === GIVE_UP ? [...remove, '--add-label', question.labels.skip] : remove;
}

async function reply(
  gh: Gh,
  root: string,
  question: Question,
  { choice, guidance }: Answer,
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

async function ask(ui: ExtensionContext['ui'], question: Question): Promise<Answer | undefined> {
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

export async function answerAll(
  ui: ExtensionContext['ui'],
  gh: Gh,
  client: WorkerClient,
  root: string,
): Promise<void> {
  const passed = new Set<number>();
  for (;;) {
    const question = (await fresh(client, root)).find((item) => !passed.has(item.issue));
    if (question === undefined) {
      if (passed.size === 0) {
        ui.notify('next-issue: no questions waiting', 'info');
      }
      return;
    }
    passed.add(question.issue);
    const answer = await ask(ui, question);
    if (answer === undefined) {
      return;
    }
    await reply(gh, root, question, answer);
    ui.notify(answeredOf(question, answer.choice), 'info');
  }
}
