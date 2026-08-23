import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export type Verdict = {
  verdict: "approve" | "request_changes";
  summary: string;
  findings: string[];
};

export function createVerdictTool(): { tool: ReturnType<typeof defineTool>; read: () => Verdict | undefined } {
  let result: Verdict | undefined;
  const tool = defineTool({
    name: "submit_review",
    label: "Submit review",
    description: "Report the review result. Call this exactly once, as the last action.",
    parameters: Type.Object({
      verdict: Type.Union([Type.Literal("approve"), Type.Literal("request_changes")], {
        description: "approve when the change is correct and complete",
      }),
      summary: Type.String({ description: "Short summary of the review" }),
      findings: Type.Array(Type.String(), {
        description: "One entry per problem. Empty when the verdict is approve.",
      }),
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

export function formatVerdict(verdict: Verdict): string {
  const head = verdict.verdict === "approve" ? "Review: approved" : "Review: changes requested";
  const findings = verdict.findings.map((finding) => `- ${finding}`).join("\n");
  return [`### ${head}`, verdict.summary, findings].filter((part) => part.length > 0).join("\n\n");
}
