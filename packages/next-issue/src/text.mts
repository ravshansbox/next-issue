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

export function fitComment(comment: string, cut: string): string {
  if (comment.length <= COMMENT_LIMIT) {
    return comment;
  }
  const end = COMMENT_LIMIT - cut.length;
  const splitsPair = /[\uD800-\uDBFF]/.test(comment.charAt(end - 1));
  return `${comment.slice(0, splitsPair ? end - 1 : end)}${cut}`;
}
