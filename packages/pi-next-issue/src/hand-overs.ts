import type { Question } from './protocol.ts';

export type Gh = (args: string[]) => Promise<string>;

export type Answer = { kind: 'retry'; guidance?: string } | { kind: 'give-up' };

const HEADINGS = ['next-issue needs help:', '### Review:', '### Fixer:'];

export function guidanceProblem(text: string): string | undefined {
  if (text.trim() === '') {
    return 'Type the guidance first.';
  }
  const heading = HEADINGS.find((item) => text.trimStart().startsWith(item));
  return heading === undefined
    ? undefined
    : `The guidance must not start with ${heading}, since it would not count as an answer.`;
}

async function skipLabel(gh: Gh, question: Question): Promise<string> {
  const wanted = question.labels.skip;
  const listed = JSON.parse(
    await gh(['label', 'list', '--repo', question.repo, '--limit', '1000', '--json', 'name']),
  ) as Array<{ name: string }>;
  const found = listed.find((label) => label.name.toLowerCase() === wanted.toLowerCase());
  if (found !== undefined) {
    return found.name;
  }
  await gh(['label', 'create', '--repo', question.repo, wanted]);
  return wanted;
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
  await gh(['issue', 'edit', ...issue, ...remove]);
}
