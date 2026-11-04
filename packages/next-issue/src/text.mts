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
