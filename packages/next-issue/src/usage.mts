export type Usage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
};

export type RoleTotals = Usage & {
  calls: number;
  ms: number;
};

export type Totals = {
  roles: Record<string, RoleTotals>;
  counts: Record<string, number>;
  total: Usage;
};

export function emptyUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
}

export function addUsage(target: Usage, source: Usage): void {
  target.input += source.input;
  target.output += source.output;
  target.cacheRead += source.cacheRead;
  target.cacheWrite += source.cacheWrite;
  target.total += source.total;
}

export function emptyRoleTotals(): RoleTotals {
  return { ...emptyUsage(), calls: 0, ms: 0 };
}

function subtractUsage(target: Usage, source: Usage): void {
  target.input -= source.input;
  target.output -= source.output;
  target.cacheRead -= source.cacheRead;
  target.cacheWrite -= source.cacheWrite;
  target.total -= source.total;
}

export function rolesSince(
  totals: Map<string, RoleTotals>,
  since?: Totals,
): { roles: Record<string, RoleTotals>; total: Usage } {
  const total = emptyUsage();
  const roles: Record<string, RoleTotals> = {};
  for (const [role, value] of totals) {
    const earlier = since?.roles[role] ?? emptyRoleTotals();
    if (value.calls === earlier.calls) {
      continue;
    }
    const usage = { ...value, calls: value.calls - earlier.calls, ms: value.ms - earlier.ms };
    subtractUsage(usage, earlier);
    roles[role] = usage;
    addUsage(total, usage);
  }
  return { roles, total };
}

export function countsSince(counts: Map<string, number>, since?: Totals): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [kind, value] of counts) {
    const count = value - (since?.counts[kind] ?? 0);
    if (count > 0) {
      result[kind] = count;
    }
  }
  return result;
}
