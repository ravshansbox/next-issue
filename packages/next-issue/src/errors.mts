export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function hasCode(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException).code === code;
}
