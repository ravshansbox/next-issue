function lastMatch(text: string, pattern: RegExp): string | undefined {
  return [...text.matchAll(pattern)].at(-1)?.[1]?.trim();
}

const PLACEHOLDERS = new Set(['', 'none', 'n/a', '-']);

function parseTagged(text: string, tag: string): string | undefined {
  const note = lastMatch(text, new RegExp(`^${tag}:[^\\S\\r\\n]*(.+)$`, 'gim'));
  return note === undefined || PLACEHOLDERS.has(note.toLowerCase()) ? undefined : note;
}

export function parseUnrelated(text: string): string | undefined {
  return parseTagged(text, 'unrelated');
}

export function parseResolved(text: string): string | undefined {
  return parseTagged(text, 'resolved');
}

export function parseDone(text: string): string | undefined {
  return parseTagged(text, 'done');
}

export function parseQuestions(text: string): string[] {
  return [...text.matchAll(/^question:[^\S\r\n]*(.+)$/gim)]
    .map((match) => match[1]!.replace(/^\d+[.)]\s*/, '').trim())
    .filter((question) => !PLACEHOLDERS.has(question.toLowerCase()));
}

export function parseCommitSubject(text: string, fallback: string): string {
  const subject = lastMatch(text, /^commit:[^\S\r\n]*(.*)$/gim)
    ?.replace(/^`+|`+$/g, '')
    .trim();
  return subject || fallback;
}
