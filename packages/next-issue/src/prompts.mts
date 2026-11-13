import type { Issue } from './github.mts';
import type { ReviewRound } from './state.mts';
import { paragraphs } from './text.mts';

const COMMIT_RULES = [
  'Do not run git, gh or any push command. The harness commits for you.',
  'End your final message with one line in the form `commit: <conventional commit subject>`.',
].join('\n');

function issueBlock(issue: Issue, comments: string[]): string {
  return paragraphs([
    `# Issue #${issue.number}: ${issue.title}`,
    issue.body.length > 0 ? issue.body : '(no description)',
    comments.length > 0 ? `## Comments\n${comments.join('\n\n')}` : '',
  ]);
}

function replyBlock(reply: string[]): string {
  return reply.length > 0
    ? [
        '## Answer of a person to the hand-over',
        'The last run handed the issue to a person. A person with write access to the repository answered as below. Follow this guidance.',
        reply.join('\n\n'),
      ].join('\n\n')
    : '';
}

export function implementPrompt(issue: Issue, comments: string[], reply: string[] = []): string {
  return paragraphs([
    'You are the implementer. Solve the issue below in this worktree.',
    issueBlock(issue, comments),
    replyBlock(reply),
    '## Rules',
    'Read the repository conventions first. Keep the change minimal and focused on the issue.',
    'Add or update tests when the repository has a test suite.',
    'For a behaviour change, write the test first and run it before the change. Then quote its failing output in your final message.',
    COMMIT_RULES,
  ]);
}

export function hookPrompt(issue: Issue, comments: string[], role: string, output: string): string {
  return paragraphs([
    `You are the ${role}. The harness could not commit your work for the issue below, because a git hook failed.`,
    issueBlock(issue, comments),
    `## Hook output\n${output}`,
    '## Rules',
    'Fix what the hook reports and keep the rest of the work in this worktree. Do not skip or weaken the hook.',
    COMMIT_RULES,
  ]);
}

export function notesBlock(path: string, notes: string | undefined, writable: boolean): string {
  const kept = notes?.trim() ?? '';
  return paragraphs([
    kept === ''
      ? ''
      : `## Shared notes\nEarlier agents left these notes for this repository.\n\n${kept}`,
    writable
      ? [
          `When you learn something that the next issue needs, such as a test command, a tool quirk or deliberate behaviour, add a short note to ${path}.`,
          'Keep the file short: keep only what still holds, and remove a note that no longer holds.',
        ].join('\n')
      : '',
  ]);
}

export function capDiff(diff: string, maxChars: number): string {
  return diff.length <= maxChars
    ? diff
    : `${diff.slice(0, maxChars)}\n... The diff is cut here, after ${maxChars} characters.`;
}

function reviewScope(earlier: string[]): string {
  return earlier.length === 0
    ? [
        'Check correctness, scope, repository conventions and test cover.',
        'Raise a finding when a behaviour change has no failing run of its test in the reply of the implementer.',
      ].join('\n')
    : [
        'This is a later round. Judge two things only:',
        'whether the earlier findings below are now fixed, and whether the new commits broke something.',
        'Do not raise a new point of taste. Do not repeat a finding that is fixed.',
        'A `The fixer disputed every finding of this round` line answers all of the findings of that round, not one of them.',
        'Withdraw every finding of that round if the dispute is correct. Repeat them all if the dispute is wrong.',
        `## Earlier findings\n${earlier.join('\n')}`,
      ].join('\n');
}

export function reviewPrompt(
  issue: Issue,
  comments: string[],
  diff: string,
  earlier: string[],
  reply?: string,
): string {
  const role = earlier.length === 0 ? 'implementer' : 'fixer';
  return [
    'You are the reviewer. Judge whether the diff solves the issue correctly.',
    issueBlock(issue, comments),
    '## Diff',
    '```diff',
    diff,
    '```',
    `## Reply of the ${role}\n${reply ?? '(no reply)'}`,
    '## Rules',
    'Read files and run commands to prove what you say: the tests, the type check or the linter.',
    'The worktree is ready to use. Do not change a file. Do not write with git or gh.',
    'The harness discards each change that you make, so a change is only lost work.',
    reviewScope(earlier),
    'Mark a finding blocking only for a wrong result, a missing part of the issue, a regression or a broken convention.',
    'End your final message with the result as a json block in a ```json fence, in the form {"summary": "<short summary>", "findings": [{"severity": "blocking" or "minor", "detail": "<what is wrong and where>"}]}.',
    'Give one entry per finding, and an empty list when nothing is wrong. The findings decide the outcome, so a problem that you leave out counts as no problem.',
  ].join('\n\n');
}

export type FixKind = 'checks' | 'review' | 'conflict';

const UNRELATED_RULE = [
  'The checks can fail for a reason this change did not cause: a test that is already broken on the base branch, one that exercises code the diff does not touch, or one that fails only under load.',
  'Establish that before you fix anything. If the failure is not yours, change nothing and end your final message with one line in the form `unrelated: <one sentence on what fails and why it is not this change>`.',
  'A person then reads it. Do not weaken, skip or re-record a test to make the checks pass.',
].join('\n');

const DISPUTE_RULE = [
  'A finding can be wrong: it can miss a convention of this repository, ask for work that the issue does not want, or describe behaviour that the code does not have.',
  'Establish that before you change anything. If every finding is wrong, change nothing and end your final message with one line in the form `unrelated: <one sentence on why the findings are wrong>`.',
  'If only some of the findings are wrong, fix the correct ones and change nothing for the wrong ones. Write no `unrelated` line in that round. The next round holds only the findings that are left, and you can dispute them there.',
  'The reviewer reads that line in the next round. Do not make a change that you hold to be wrong only to end the round.',
].join('\n');

const CONFLICT_RULE = [
  'The harness merged the base branch into this branch, and git left conflict markers in the files listed under Detail.',
  'Resolve each conflict so that both the change of this issue and the change on the base branch survive, and remove every conflict marker.',
  'Leave the merge in progress. The harness commits the merge and pushes it.',
].join('\n');

const KIND_RULES: Record<FixKind, string> = {
  checks: UNRELATED_RULE,
  review: [
    DISPUTE_RULE,
    'For a behaviour change, run its test before the change and quote its failing output in your final message.',
  ].join('\n'),
  conflict: CONFLICT_RULE,
};

function earlierBlock(earlier: string[]): string {
  return earlier.length > 0
    ? [
        '## Earlier rounds',
        earlier.join('\n'),
        'Keep those earlier fixes. Do not undo work that a later round did not question.',
      ].join('\n')
    : '';
}

export function fixPrompt(
  issue: Issue,
  reason: string,
  detail: string,
  earlier: string[],
  kind: FixKind,
  reply: string[] = [],
): string {
  return paragraphs([
    `You are the fixer. Correct the work for issue #${issue.number}: ${issue.title}.`,
    `## Reason\n${reason}`,
    `## Detail\n${detail}`,
    earlierBlock(earlier),
    replyBlock(reply),
    '## Rules',
    'Fix the cause, not the symptom. Keep the change minimal.',
    KIND_RULES[kind],
    COMMIT_RULES,
  ]);
}

export function history(rounds: ReviewRound[]): string[] {
  return rounds.map((round) => {
    const head = `Round ${round.round}:\n${round.findings}`;
    return round.dispute === undefined
      ? head
      : `${head}\nThe fixer disputed every finding of this round: ${round.dispute}`;
  });
}
