export type Severity = 'blocking' | 'minor';

export type Finding = {
  severity: Severity;
  detail: string;
};

export type Verdict = {
  summary: string;
  findings: Finding[];
};

const SEVERITIES: string[] = ['blocking', 'minor'];

export function readVerdict(value: unknown): Verdict | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const { summary, findings } = value as Record<string, unknown>;
  if (typeof summary !== 'string' || !Array.isArray(findings)) {
    return undefined;
  }
  const checked: Finding[] = [];
  for (const item of findings) {
    if (typeof item !== 'object' || item === null) {
      return undefined;
    }
    const { severity, detail } = item as Record<string, unknown>;
    if (
      typeof severity !== 'string' ||
      !SEVERITIES.includes(severity) ||
      typeof detail !== 'string'
    ) {
      return undefined;
    }
    checked.push({ severity: severity as Severity, detail });
  }
  return { summary, findings: checked };
}

const JSON_BLOCK = /```json[^\n]*\n([\s\S]*?)```/g;

export function parseVerdict(text: string): Verdict | undefined {
  const last = [...text.matchAll(JSON_BLOCK)].at(-1);
  if (last === undefined) {
    return undefined;
  }
  try {
    return readVerdict(JSON.parse(last[1]!));
  } catch {
    return undefined;
  }
}

export function blockingFindings(verdict: Verdict): Finding[] {
  return verdict.findings.filter((finding) => finding.severity === 'blocking');
}

export function openFindings(verdict: Verdict, lastRound: boolean): Finding[] {
  return lastRound ? blockingFindings(verdict) : verdict.findings;
}

const LEFT =
  'The findings above stay as they are: no blocking finding is open and the review budget is spent.';

export function formatVerdict(verdict: Verdict, open: Finding[]): string {
  const approved = open.length === 0;
  const head = approved ? 'Review: approved' : 'Review: changes requested';
  const lines = verdict.findings.map((finding) => `- **${finding.severity}** ${finding.detail}`);
  const note = approved && verdict.findings.length > 0 ? LEFT : '';
  return [`### ${head}`, verdict.summary, lines.join('\n'), note]
    .filter((part) => part.length > 0)
    .join('\n\n');
}

export function formatFindings(findings: Finding[]): string {
  return findings.map((finding) => `- ${finding.detail}`).join('\n');
}
