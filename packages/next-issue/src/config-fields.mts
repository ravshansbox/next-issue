export const CONFIG_FILE = 'next-issue.config.json';

export function record(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${CONFIG_FILE}: ${what} must be an object.`);
  }
  return value as Record<string, unknown>;
}

export function rejectUnknown(
  value: Record<string, unknown>,
  known: readonly string[],
  what: string,
): void {
  for (const key of Object.keys(value)) {
    if (!known.includes(key)) {
      throw new Error(`${CONFIG_FILE} holds an unknown ${what}: ${key}`);
    }
  }
}

export function whole(value: unknown, field: string, least: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < least) {
    throw new Error(`${CONFIG_FILE}: ${field} must be a whole number of ${least} or more.`);
  }
  return value;
}

export function text(value: unknown, field: string, allowEmpty: boolean): string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    throw new Error(
      `${CONFIG_FILE}: ${field} must be ${allowEmpty ? 'text' : 'text that is not empty'}.`,
    );
  }
  return value;
}
