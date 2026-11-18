import type { Question } from './protocol.ts';

export type Gh = (args: string[]) => Promise<string>;

export type Answer = { kind: 'retry'; guidance?: string } | { kind: 'give-up' };

const HEADINGS = [
  '### next-issue ·',
  'next-issue needs help:',
  '### Review:',
  '### Fixer:',
  '### Already done',
];

export function guidanceProblem(text: string): string | undefined {
  if (text.trim() === '') {
    return 'Type the guidance first.';
  }
  const heading = HEADINGS.find((item) => text.trimStart().startsWith(item));
  return heading === undefined
    ? undefined
    : `The guidance must not start with ${heading}, since it would not count as an answer.`;
}

async function existingLabel(gh: Gh, question: Question): Promise<string | undefined> {
  const wanted = question.labels.skip.toLowerCase();
  const listed = JSON.parse(
    await gh(['label', 'list', '--repo', question.repo, '--limit', '1000', '--json', 'name']),
  ) as Array<{ name: string }>;
  return listed.find((label) => label.name.toLowerCase() === wanted)?.name;
}

async function skipLabel(gh: Gh, question: Question): Promise<string> {
  const found = await existingLabel(gh, question);
  if (found !== undefined) {
    return found;
  }
  const wanted = question.labels.skip;
  try {
    await gh(['label', 'create', '--repo', question.repo, wanted]);
    return wanted;
  } catch (error) {
    const created = await existingLabel(gh, question);
    if (created === undefined) {
      throw error;
    }
    return created;
  }
}

export async function answerHandOver(gh: Gh, question: Question, answer: Answer): Promise<void> {
  const issue = ['--repo', question.repo, String(question.issue)];
  const remove = ['--remove-label', question.labels.needsHuman];
  if (answer.kind === 'give-up') {
    const skip = await skipLabel(gh, question);
    await gh(['issue', 'edit', ...issue, ...remove, '--add-label', skip]);
    return;
  }
  if (answer.guidance !== undefined) {
    await gh(['issue', 'comment', ...issue, '--body', answer.guidance]);
  }
  const ready = question.labels.ready;
  const add = ready === undefined || ready === '' ? [] : ['--add-label', ready];
  await gh(['issue', 'edit', ...issue, ...remove, ...add]);
}
