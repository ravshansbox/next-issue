const MARKER = /^(commit|summary|unrelated|resolved|done|question):[^\S\r\n]*(.*)$/i;

const PLACEHOLDERS = new Set(['', 'none', 'n/a', '-']);

function isPlaceholder(value: string): boolean {
  return PLACEHOLDERS.has(value.replace(/[.!\s]+$/, '').toLowerCase());
}

function unwrap(line: string): string {
  return line.replace(/^(`+)\s*(.*?)\s*\1$/, '$2');
}

function markerValues(lines: string[], tag: string): string[] {
  return lines.flatMap((line) => {
    const match = MARKER.exec(unwrap(line));
    return match && match[1]!.toLowerCase() === tag ? [match[2]!.trim()] : [];
  });
}

function isMarker(line: string): boolean {
  return MARKER.test(unwrap(line));
}

function replyLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

function isFence(line: string): boolean {
  return /^\s*(`{3,}|~{3,})[^`]*$/.test(line);
}

function closingLines(text: string): string[] {
  const lines = replyLines(text).filter((line) => line.trim() !== '' && !isFence(line));
  let start = lines.length;
  while (start > 0 && isMarker(lines[start - 1]!)) {
    start -= 1;
  }
  return lines.slice(start);
}

function parseTagged(lines: string[], tag: string): string | undefined {
  const note = markerValues(lines, tag).at(-1);
  return note === undefined || isPlaceholder(note) ? undefined : note;
}

export function parseUnrelated(text: string): string | undefined {
  return parseTagged(closingLines(text), 'unrelated');
}

export function parseResolved(text: string): string | undefined {
  return parseTagged(closingLines(text), 'resolved');
}

export function parseDone(text: string): string | undefined {
  return parseTagged(replyLines(text), 'done');
}

export function parseSummary(text: string): string | undefined {
  return parseTagged(replyLines(text), 'summary');
}

export function parseQuestions(text: string): string[] {
  return markerValues(replyLines(text), 'question')
    .map((question) => question.replace(/^\d+[.)]\s*/, '').trim())
    .filter((question) => !isPlaceholder(question));
}

export function parseCommitSubject(text: string, fallback: string): string {
  const subject = markerValues(replyLines(text), 'commit')
    .at(-1)
    ?.replace(/^`+|`+$/g, '')
    .trim();
  return subject || fallback;
}
