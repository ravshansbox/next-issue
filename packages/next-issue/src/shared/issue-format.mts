export const ISSUE_SECTIONS = [
  'Problem',
  'Context and findings',
  'Decisions',
  'Acceptance criteria',
  'Out of scope',
  'Open questions',
] as const;

const OPEN_QUESTIONS = /^ {0,3}#{1,6}[^\S\r\n]+Open questions(?:[^\S\r\n]+#+)?[^\S\r\n]*$/im;

export function numbered(items: string[]): string {
  return items.map((item, index) => `${index + 1}. ${item}`).join('\n');
}

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const HEADING = /^ {0,3}(#{1,6})[^\S\r\n]/;

function headings(body: string): { index: number; length: number; text: string }[] {
  const found = [];
  let fence = '';
  let index = 0;
  for (const text of body.split('\n')) {
    const marker = FENCE.exec(text.replace(/\r$/, ''));
    if (fence === '') {
      if (marker !== null && !(marker[1]![0] === '`' && marker[2]!.includes('`'))) {
        fence = marker[1]!;
      } else if (HEADING.test(text)) {
        found.push({ index, length: text.length, text });
      }
    } else if (
      marker !== null &&
      marker[1]![0] === fence[0] &&
      marker[1]!.length >= fence.length &&
      marker[2]!.trim() === ''
    ) {
      fence = '';
    }
    index += text.length + 1;
  }
  return found;
}

export function withOpenQuestions(body: string, questions: string[]): string {
  const list = numbered(questions);
  const all = headings(body);
  const position = all.findIndex((line) => OPEN_QUESTIONS.test(line.text));
  if (position === -1) {
    const kept = body.trimEnd();
    return `${kept === '' ? '' : `${kept}\n\n`}## Open questions\n\n${list}`;
  }
  const heading = all[position]!;
  const start = heading.index + heading.length;
  const level = HEADING.exec(heading.text)![1]!.length;
  const next = all.slice(position + 1).find((line) => HEADING.exec(line.text)![1]!.length <= level);
  const end = next === undefined ? body.length : next.index;
  const section = body.slice(start, end).trimEnd();
  const rest = body.slice(end);
  return `${body.slice(0, start)}${section}\n\n${list}${rest === '' ? '' : `\n\n${rest}`}`;
}
