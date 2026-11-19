export function joinFilled(parts: string[], separator: string): string {
  return parts.filter((part) => part !== '').join(separator);
}

export function paragraphs(parts: string[]): string {
  return joinFilled(parts, '\n\n');
}

export function lines(output: string): string[] {
  return output.split('\n').filter((line) => line.length > 0);
}

export function truncate(text: string, max: number, ellipsis: string): string {
  return text.length > max ? `${text.slice(0, max - ellipsis.length)}${ellipsis}` : text;
}

export function keepTail(text: string, limit: number | undefined): string {
  return limit !== undefined && text.length > limit ? text.slice(-limit) : text;
}

const COMMENT_LIMIT = 65536;

export const AGENT_PREFIX = '### next-issue ·';

export function agentHeading(agent: string, outcome: string): string {
  return `${AGENT_PREFIX} ${agent}: ${outcome}`;
}

export const COMMENT_CUT = '\n\nThis comment was too long for GitHub and was cut.';

export function fitComment(comment: string, cut: string): string {
  if (comment.length <= COMMENT_LIMIT) {
    return comment;
  }
  const end = COMMENT_LIMIT - cut.length;
  const splitsPair = /[\uD800-\uDBFF]/.test(comment.charAt(end - 1));
  return `${comment.slice(0, splitsPair ? end - 1 : end)}${cut}`;
}

const COMMENT_OUTPUT_CHARS = 3000;

/** A backtick fence longer than any backtick run in the text, and at least three long. */
export function fenceFor(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  return '`'.repeat(Math.max(3, longest + 1));
}

export function outputBlock(output: string, limit = COMMENT_OUTPUT_CHARS): string {
  const kept = keepTail(output.trim(), limit);
  if (kept === '') {
    return '';
  }
  const fence = fenceFor(kept);
  return `\n\n${fence}\n${kept}\n${fence}\n`;
}

const CLOSING_REFERENCE =
  /(\s*[,;]?\s*(?:and\s+)?)\b(close[sd]?|fix(?:e[sd])?|resolve[sd]?)(\s*:\s*|\s+)(?:[\w.-]+\/[\w.-]+#\d+|#\d+|GH-\d+|https?:\/\/\S+\/(?:issues|pull)\/\d+)(?!\w)/gi;

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
