function lastMatch(text: string, pattern: RegExp): string | undefined {
  return [...text.matchAll(pattern)].at(-1)?.[1]?.trim();
}

export function parseUnrelated(text: string): string | undefined {
  const note = lastMatch(text, /^unrelated:\s*(.+)$/gim);
  return note === '' ? undefined : note;
}

export function parseResolved(text: string): string | undefined {
  const note = lastMatch(text, /^resolved:\s*(.+)$/gim);
  return note === '' ? undefined : note;
}

export function parseCommitSubject(text: string, fallback: string): string {
  const subject = lastMatch(text, /^commit:\s*(.+)$/gim)
    ?.replace(/^`+|`+$/g, '')
    .trim();
  return subject || fallback;
}
