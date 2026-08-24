export type Severity = "blocking" | "minor";

export type Finding = {
  severity: Severity;
  detail: string;
};

export type Verdict = {
  verdict: "approve" | "request_changes";
  summary: string;
  findings: Finding[];
};

export const VERDICT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    verdict: {
      type: "string",
      enum: ["approve", "request_changes"],
      description: "approve when no blocking problem is left",
    },
    summary: { type: "string", description: "Short summary of the review" },
    findings: {
      type: "array",
      description: "One entry per problem. Empty when nothing is wrong.",
      items: {
        type: "object",
        properties: {
          severity: {
            type: "string",
            enum: ["blocking", "minor"],
            description:
              "blocking for a wrong result, a missing part of the issue, a regression or a broken convention; minor for taste and style",
          },
          detail: { type: "string", description: "What is wrong and where" },
        },
        required: ["severity", "detail"],
      },
    },
  },
  required: ["verdict", "summary", "findings"],
};

export function readVerdict(value: unknown): Verdict | undefined {
  const verdict = value as Verdict | undefined;
  if (verdict === undefined || typeof verdict.summary !== "string" || !Array.isArray(verdict.findings)) {
    return undefined;
  }
  return verdict;
}

export function blockingFindings(verdict: Verdict): Finding[] {
  return verdict.findings.filter((finding) => finding.severity === "blocking");
}

export function isApproved(verdict: Verdict): boolean {
  return verdict.verdict === "approve" || blockingFindings(verdict).length === 0;
}

export function formatVerdict(verdict: Verdict): string {
  const head = isApproved(verdict) ? "Review: approved" : "Review: changes requested";
  const lines = verdict.findings.map((finding) => `- **${finding.severity}** ${finding.detail}`);
  return [`### ${head}`, verdict.summary, lines.join("\n")].filter((part) => part.length > 0).join("\n\n");
}

export function formatFindings(findings: Finding[]): string {
  return findings.map((finding) => `- ${finding.detail}`).join("\n");
}

export function fingerprint(findings: Finding[]): string {
  return findings
    .map((finding) => finding.detail.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim())
    .sort()
    .join("|");
}
