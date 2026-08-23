import type { Issue } from "./github.mts";

const COMMIT_RULES = [
  "Do not run git, gh or any push command. The harness commits for you.",
  "End your final message with one line in the form `commit: <conventional commit subject>`.",
].join("\n");

function issueBlock(issue: Issue, comments: string[]): string {
  return [
    `# Issue #${issue.number}: ${issue.title}`,
    issue.body.length > 0 ? issue.body : "(no description)",
    comments.length > 0 ? `## Comments\n${comments.join("\n\n")}` : "",
  ]
    .filter((part) => part.length > 0)
    .join("\n\n");
}

export function implementPrompt(issue: Issue, comments: string[]): string {
  return [
    "You are the implementer. Solve the issue below in this worktree.",
    issueBlock(issue, comments),
    "## Rules",
    "Read the repository conventions first. Keep the change minimal and focused on the issue.",
    "Add or update tests when the repository has a test suite.",
    COMMIT_RULES,
  ].join("\n\n");
}

export function reviewPrompt(issue: Issue, comments: string[], diff: string): string {
  return [
    "You are the reviewer. Judge whether the diff solves the issue correctly.",
    issueBlock(issue, comments),
    "## Diff",
    "```diff",
    diff,
    "```",
    "## Rules",
    "Read files for context when you must. Do not change any file.",
    "Check correctness, scope, repository conventions and test cover.",
    "Report the result with the submit_review tool. Call it exactly once.",
  ].join("\n\n");
}

export function fixPrompt(issue: Issue, reason: string, detail: string): string {
  return [
    `You are the fixer. Correct the work for issue #${issue.number}: ${issue.title}.`,
    `## Reason\n${reason}`,
    `## Detail\n${detail}`,
    "## Rules",
    "Fix the cause, not the symptom. Keep the change minimal.",
    COMMIT_RULES,
  ].join("\n\n");
}

export function parseCommitSubject(text: string, fallback: string): string {
  const match = /^commit:\s*(.+)$/im.exec(text);
  const subject = match?.[1]?.trim();
  return subject && subject.length > 0 ? subject : fallback;
}
