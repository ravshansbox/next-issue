export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function hasCode(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException).code === code;
}

export function errorMatches(error: unknown, pattern: RegExp): boolean {
  return error instanceof Error && pattern.test(error.message);
}
