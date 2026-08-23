import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

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

export function createVerdictTool(): { tool: ReturnType<typeof defineTool>; read: () => Verdict | undefined } {
  let result: Verdict | undefined;
  const tool = defineTool({
    name: "submit_review",
    label: "Submit review",
    description: "Report the review result. Call this exactly once, as the last action.",
    parameters: Type.Object({
      verdict: Type.Union([Type.Literal("approve"), Type.Literal("request_changes")], {
        description: "approve when no blocking problem is left",
      }),
      summary: Type.String({ description: "Short summary of the review" }),
      findings: Type.Array(
        Type.Object({
          severity: Type.Union([Type.Literal("blocking"), Type.Literal("minor")], {
            description:
              "blocking for a wrong result, a missing part of the issue, a regression or a broken convention; minor for taste and style",
          }),
          detail: Type.String({ description: "What is wrong and where" }),
        }),
        { description: "One entry per problem. Empty when nothing is wrong." },
      ),
    }),
    execute: async (_id, params) => {
      result = {
        verdict: params.verdict,
        summary: params.summary,
        findings: params.findings,
      };
      return { content: [{ type: "text", text: "Review recorded." }], details: {} };
    },
  });
  return { tool, read: () => result };
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
