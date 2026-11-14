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

const CLOSING_REFERENCE =
  /(\s*[,;]?\s*(?:and\s+)?)\b(close[sd]?|fix(?:e[sd])?|resolve[sd]?)(\s*:\s*|\s+)(?:[\w.-]+\/[\w.-]+#\d+|#\d+|https?:\/\/\S+\/(?:issues|pull)\/\d+)/gi;

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
    .trim();
  return cleaned || fallback;
}

export function parseCommitSubject(text: string, fallback: string): string {
  const subject = lastMatch(text, /^commit:[^\S\r\n]*(.*)$/gim)
    ?.replace(/^`+|`+$/g, '')
    .trim();
  return subject || fallback;
}
