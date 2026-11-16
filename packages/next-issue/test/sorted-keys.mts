export function keysSorted(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.every(keysSorted);
  }
  if (typeof value === 'object' && value !== null) {
    const keys = Object.keys(value);
    return keys.join() === [...keys].sort().join() && Object.values(value).every(keysSorted);
  }
  return true;
}
