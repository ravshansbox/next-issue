export const ISSUE_SECTIONS = [
  'Problem',
  'Context and findings',
  'Acceptance criteria',
  'Out of scope',
  'Open questions',
] as const;

const OPEN_QUESTIONS = /^(#{1,6})[^\S\r\n]+Open questions[^\S\r\n]*$/im;

export function numbered(items: string[]): string {
  return items.map((item, index) => `${index + 1}. ${item}`).join('\n');
}

export function withOpenQuestions(body: string, questions: string[]): string {
  const list = numbered(questions);
  const heading = OPEN_QUESTIONS.exec(body);
  if (heading === null) {
    const kept = body.trimEnd();
    return `${kept === '' ? '' : `${kept}\n\n`}## Open questions\n\n${list}`;
  }
  const start = heading.index + heading[0].length;
  const level = heading[1]!.length;
  const next = new RegExp(`^#{1,${level}}[^\\S\\r\\n]`, 'm').exec(body.slice(start));
  const end = next === null ? body.length : start + next.index;
  const section = body.slice(start, end).trimEnd();
  const rest = body.slice(end);
  return `${body.slice(0, start)}${section}\n\n${list}${rest === '' ? '' : `\n\n${rest}`}`;
}
