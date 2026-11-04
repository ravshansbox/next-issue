export function joinFilled(parts: string[], separator: string): string {
  return parts.filter((part) => part !== '').join(separator);
}

export function paragraphs(parts: string[]): string {
  return joinFilled(parts, '\n\n');
}

export function lines(output: string): string[] {
  return output.split('\n').filter((line) => line.length > 0);
}
