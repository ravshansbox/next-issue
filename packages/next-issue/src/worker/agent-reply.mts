function lastMatch(text: string, pattern: RegExp): string | undefined {
  return [...text.matchAll(pattern)].at(-1)?.[1]?.trim();
}

const PLACEHOLDERS = new Set(['', 'none', 'n/a', '-']);

export function parseUnrelated(text: string): string | undefined {
  const note = lastMatch(text, /^unrelated:[^\S\r\n]*(.+)$/gim);
  return note === undefined || PLACEHOLDERS.has(note.toLowerCase()) ? undefined : note;
}

export function parseResolved(text: string): string | undefined {
  const note = lastMatch(text, /^resolved:[^\S\r\n]*(.+)$/gim);
  return note === undefined || PLACEHOLDERS.has(note.toLowerCase()) ? undefined : note;
}

export function parseDone(text: string): string | undefined {
  const note = lastMatch(text, /^done:[^\S\r\n]*(.+)$/gim);
  return note === undefined || PLACEHOLDERS.has(note.toLowerCase()) ? undefined : note;
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
