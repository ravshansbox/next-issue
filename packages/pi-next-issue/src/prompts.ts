import type { Finding, Issue, Verdict } from './runner.ts';

const COMMIT_RULES = [
  'Do not run git, gh or any push command. The harness commits for you.',
  'End your final message with one line in the form `commit: <conventional commit subject>`.',
].join('\n');

function issueBlock(issue: Issue, comments: string[]): string {
  return [
    `# Issue #${issue.number}: ${issue.title}`,
    issue.body.length > 0 ? issue.body : '(no description)',
    comments.length > 0 ? `## Comments\n${comments.join('\n\n')}` : '',
  ]
    .filter((part) => part.length > 0)
    .join('\n\n');
}

export function implementPrompt(issue: Issue, comments: string[]): string {
  return [
    'You are the implementer. Solve the issue below in this worktree.',
    issueBlock(issue, comments),
    '## Rules',
    'Read the repository conventions first. Keep the change minimal and focused on the issue.',
    'Add or update tests when the repository has a test suite.',
    COMMIT_RULES,
  ].join('\n\n');
}

export function reviewPrompt(
  issue: Issue,
  comments: string[],
  diff: string,
  earlier: string[],
): string {
  const scope =
    earlier.length === 0
      ? 'Check correctness, scope, repository conventions and test cover.'
      : [
          'This is a later round. Judge only whether the earlier findings below are fixed and whether the new commits broke something.',
          'Do not raise a new point of taste. Withdraw a finding when the fixer disputed it correctly.',
          `## Earlier rounds\n${earlier.join('\n\n')}`,
        ].join('\n');
  return [
    'You are the reviewer. Judge whether the diff solves the issue correctly.',
    issueBlock(issue, comments),
    '## Diff',
    '```diff',
    diff,
    '```',
    '## Rules',
    'Read files and run commands to prove what you say: the tests, the type check or the linter.',
    'Do not change a file. Do not write with git or gh. The harness discards each change that you make.',
    scope,
    'Mark a finding blocking only for a wrong result, a missing part of the issue, a regression or a broken convention.',
    'Finish by calling the submit_verdict tool once with a short summary and one entry per finding.',
  ].join('\n\n');
}

export function fixPrompt(issue: Issue, reason: string, detail: string, earlier: string[]): string {
  return [
    `You are the fixer. Correct the work for issue #${issue.number}: ${issue.title}.`,
    `## Reason\n${reason}`,
    `## Detail\n${detail}`,
    earlier.length > 0
      ? `## Earlier rounds\n${earlier.join('\n\n')}\n\nKeep those earlier fixes.`
      : '',
    '## Rules',
    'Fix the cause, not the symptom. Keep the change minimal. Do not weaken, skip or delete a test to make it pass.',
    'If the problem is not caused by this change, or every finding is wrong, change nothing and end your final message with one line in the form `unrelated: <one sentence on why>`.',
    COMMIT_RULES,
  ]
    .filter((part) => part.length > 0)
    .join('\n\n');
}

function lastLine(text: string, key: string): string | undefined {
  const match = [...text.matchAll(new RegExp(`^${key}:\\s*(.+)$`, 'gim'))].at(-1);
  const value = match?.[1]
    ?.trim()
    .replace(/^`+|`+$/g, '')
    .trim();
  return value !== undefined && value.length > 0 ? value : undefined;
}

export function parseCommitSubject(text: string, fallback: string): string {
  return lastLine(text, 'commit') ?? fallback;
}

export function parseUnrelated(text: string): string | undefined {
  return lastLine(text, 'unrelated');
}

export function cap(text: string, maxChars: number): string {
  return text.length <= maxChars
    ? text
    : `${text.slice(0, maxChars)}\n... cut after ${maxChars} characters.`;
}

export function formatVerdict(verdict: Verdict, open: Finding[]): string {
  const head = open.length === 0 ? 'Review: approved' : 'Review: changes requested';
  const lines = verdict.findings.map((finding) => `- **${finding.severity}** ${finding.detail}`);
  return [`### ${head}`, verdict.summary, lines.join('\n')]
    .filter((part) => part.length > 0)
    .join('\n\n');
}

export function formatFindings(findings: Finding[]): string {
  return findings.map((finding) => `- ${finding.detail}`).join('\n');
}
