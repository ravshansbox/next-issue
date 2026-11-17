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

const CLOSING_REFERENCE =
  /(\s*[,;]?\s*(?:and\s+)?)\b(close[sd]?|fix(?:e[sd])?|resolve[sd]?)(\s*:\s*|\s+)(?:[\w.-]+\/[\w.-]+#\d+|#\d+|GH-\d+|https?:\/\/\S+\/(?:issues|pull)\/\d+)/gi;

const BARE_TYPE = /^\w+(?:\([^)]*\))?!?$/;

export function withoutClosingReferences(subject: string, fallback: string): string {
  const cleaned = subject
    .replace(
      CLOSING_REFERENCE,
      (_match, _lead: string, keyword: string, separator: string, offset: number) =>
        offset === 0 && separator.includes(':') ? `${keyword}: ` : '',
    )
    .replace(/\(\s*\)|\[\s*\]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[\s,;:]+$/, '')
    .replace(/^(?:[\s,;:\u2013\u2014]|-(?!\d))+/, '')
    .trim();
  const closes = subject.search(CLOSING_REFERENCE) !== -1;
  const unusable = closes && (BARE_TYPE.test(cleaned) || /^[^\p{L}\p{N}-]/u.test(cleaned));
  return cleaned && !unusable ? cleaned : fallback;
}

export function parseCommitSubject(text: string, fallback: string): string {
  const subject = lastMatch(text, /^commit:[^\S\r\n]*(.*)$/gim)
    ?.replace(/^`+|`+$/g, '')
    .trim();
  return subject || fallback;
}
