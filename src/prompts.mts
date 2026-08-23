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

export function reviewPrompt(
  issue: Issue,
  comments: string[],
  diff: string,
  round: number,
  earlier: string[],
): string {
  const scope =
    round === 1
      ? "Check correctness, scope, repository conventions and test cover."
      : [
          "This is a later round. Judge two things only:",
          "whether the earlier findings below are now fixed, and whether the new commits broke something.",
          "Do not raise a new point of taste. Do not repeat a finding that is fixed.",
          `## Earlier findings\n${earlier.join("\n")}`,
        ].join("\n");
  return [
    "You are the reviewer. Judge whether the diff solves the issue correctly.",
    issueBlock(issue, comments),
    "## Diff",
    "```diff",
    diff,
    "```",
    "## Rules",
    "Read files for context when you must. Do not change any file.",
    scope,
    "Mark a finding blocking only for a wrong result, a missing part of the issue, a regression or a broken convention.",
    "Report the result with the submit_review tool. Call it exactly once.",
  ].join("\n\n");
}

export function fixPrompt(
  issue: Issue,
  reason: string,
  detail: string,
  earlier: string[],
): string {
  return [
    `You are the fixer. Correct the work for issue #${issue.number}: ${issue.title}.`,
    `## Reason\n${reason}`,
    `## Detail\n${detail}`,
    earlier.length > 0
      ? [
          "## Earlier rounds",
          earlier.join("\n"),
          "Keep those earlier fixes. Do not undo work that a later round did not question.",
        ].join("\n")
      : "",
    "## Rules",
    "Fix the cause, not the symptom. Keep the change minimal.",
    COMMIT_RULES,
  ]
    .filter((part) => part.length > 0)
    .join("\n\n");
}

export function parseCommitSubject(text: string, fallback: string): string {
  const match = /^commit:\s*(.+)$/im.exec(text);
  const subject = match?.[1]?.trim();
  return subject && subject.length > 0 ? subject : fallback;
}
