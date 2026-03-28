import { ContextNodeData, CompilerMergeResult, LLMConfig } from "../types";
import { callLLM } from "./llmClient";

export function buildMergePrompt(
  nodeA: ContextNodeData,
  nodeB: ContextNodeData
): Array<{ role: string; content: string }> {
  const formatHistory = (data: ContextNodeData) =>
    data.chatHistory
      .filter((m) => m.role !== "system")
      .map((m) => `[${m.role.toUpperCase()}]: ${m.content}`)
      .join("\n");

  return [
    {
      role: "system",
      content: `You are a Compiler AI that merges two isolated Context Tree nodes into one unified node.

## Node A: "${nodeA.label}" (${nodeA.role})
### Spec:
${JSON.stringify(nodeA.metadata, null, 2)}
### Chat History:
${formatHistory(nodeA)}

## Node B: "${nodeB.label}" (${nodeB.role})
### Spec:
${JSON.stringify(nodeB.metadata, null, 2)}
### Chat History:
${formatHistory(nodeB)}

Analyze ALL conflicts between these two nodes and produce a unified merge.
Output ONLY a valid JSON object (no markdown, no fences):
{
  "conflict_analysis": "Comprehensive analysis of every logic conflict and resolution strategy",
  "merged_spec": {
    "system_prompt": "Unified AI operating instructions for the merged node",
    "constraints": ["Consolidated hard constraints from both nodes"],
    "context_splicing_rules": "Unified rules for context combination",
    "allowed_tools": ["Merged set of allowed tool names"],
    "linked_files": ["Combined list of relevant file paths"],
    "status": "merged",
    "specLocked": true
  },
  "resolved_code": "The final unified code block or execution plan that resolves both nodes"
}`,
    },
    {
      role: "user",
      content: "Merge these two nodes. Output strict JSON only.",
    },
  ];
}

export async function runCompilerMerge(
  nodeA: ContextNodeData,
  nodeB: ContextNodeData,
  config: LLMConfig
): Promise<CompilerMergeResult> {
  const messages = buildMergePrompt(nodeA, nodeB);
  const raw = await callLLM(messages, config, config.provider === "openai");

  // Strip any accidental markdown fences
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();

  let parsed: CompilerMergeResult;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error(`Compiler AI returned invalid JSON:\n${raw}`);
  }

  // Validate schema
  if (
    typeof parsed.conflict_analysis !== "string" ||
    !parsed.merged_spec ||
    typeof parsed.merged_spec.system_prompt !== "string" ||
    !Array.isArray(parsed.merged_spec.constraints) ||
    typeof parsed.resolved_code !== "string"
  ) {
    throw new Error(
      `Compiler AI returned incomplete schema:\n${JSON.stringify(parsed, null, 2)}`
    );
  }

  return parsed;
}
