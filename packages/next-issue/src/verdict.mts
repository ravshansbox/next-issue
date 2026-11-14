import { isRecord } from './records.mts';
import { paragraphs } from './text.mts';

type Severity = 'blocking' | 'minor';

export type Finding = {
  severity: Severity;
  detail: string;
};

export type Verdict = {
  summary: string;
  findings: Finding[];
};

function isSeverity(value: unknown): value is Severity {
  return value === 'blocking' || value === 'minor';
}

function readFinding(item: unknown): Finding | undefined {
  if (!isRecord(item)) {
    return undefined;
  }
  const { severity, detail } = item;
  if (!isSeverity(severity) || typeof detail !== 'string') {
    return undefined;
  }
  return { severity, detail };
}

export function readVerdict(value: unknown): Verdict | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const { summary, findings } = value;
  if (typeof summary !== 'string' || !Array.isArray(findings)) {
    return undefined;
  }
  const checked: Finding[] = [];
  for (const item of findings) {
    const finding = readFinding(item);
    if (finding === undefined) {
      return undefined;
    }
    checked.push(finding);
  }
  return { summary, findings: checked };
}

const JSON_FENCE = /```json[^\n]*\n/g;
const FENCE = '```';

function parseJson(text: string): { value: unknown } | undefined {
  try {
    return { value: JSON.parse(text) };
  } catch {
    return undefined;
  }
}

export function parseVerdict(text: string): Verdict | undefined {
  const last = [...text.matchAll(JSON_FENCE)].at(-1);
  if (last === undefined) {
    return undefined;
  }
  const start = last.index + last[0].length;
  for (let end = text.indexOf(FENCE, start); end !== -1; end = text.indexOf(FENCE, end + 1)) {
    const parsed = parseJson(text.slice(start, end));
    if (parsed !== undefined) {
      return readVerdict(parsed.value);
    }
  }
  return undefined;
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
  return paragraphs([`### ${head}`, verdict.summary, lines.join('\n'), note]);
}

export function formatFindings(findings: Finding[]): string {
  return findings.map((finding) => `- ${finding.detail}`).join('\n');
}
