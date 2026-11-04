export function joinFilled(parts: string[], separator: string): string {
  return parts.filter((part) => part !== '').join(separator);
}

export function paragraphs(parts: string[]): string {
  return joinFilled(parts, '\n\n');
}
