import { v4 as uuidv4 } from "uuid";
import {
  LLMConfig,
  OpenAITool,
  FILESYSTEM_TOOLS,
  ChatMessage,
  NodeMetadata,
  NodeRole,
  ContextNodeData,
} from "../types";

// ─── Tool Executor Type ───────────────────────────────────────
export type ToolExecutor = (
  toolName: string,
  args: Record<string, unknown>
) => Promise<string>;

// ─── Config helpers ───────────────────────────────────────────
function getModel(config: LLMConfig): string {
  if (config.model) return config.model;
  return config.provider === "openai" ? "gpt-4o" : "claude-3-5-sonnet-20241022";
}

// ─── Non-streaming call (for spec gen, sync, merge) ───────────
export async function callLLM(
  messages: Array<{ role: string; content: string }>,
  config: LLMConfig,
  jsonMode = false
): Promise<string> {
  if (config.provider === "openai") {
    return callOpenAI(messages, config, jsonMode);
  }
  return callAnthropic(messages, config);
}

async function callOpenAI(
  messages: Array<{ role: string; content: string }>,
  config: LLMConfig,
  jsonMode: boolean
): Promise<string> {
  const body: Record<string, unknown> = {
    model: getModel(config),
    messages,
    temperature: 0.3,
  };
  if (jsonMode) body.response_format = { type: "json_object" };

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenAI error: ${res.status} ${err}`);
  }

  const data = await res.json();
  return data.choices[0].message.content || "";
}

async function callAnthropic(
  messages: Array<{ role: string; content: string }>,
  config: LLMConfig
): Promise<string> {
  // Separate system from messages
  const systemMsgs = messages.filter((m) => m.role === "system");
  const nonSystem = messages.filter((m) => m.role !== "system");
  const system = systemMsgs.map((m) => m.content).join("\n\n");

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": config.apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: getModel(config),
      max_tokens: 4096,
      system,
      messages: nonSystem.map((m) => ({ role: m.role, content: m.content })),
      temperature: 0.3,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Anthropic error: ${res.status} ${err}`);
  }

  const data = await res.json();
  const textBlock = data.content?.find(
    (b: { type: string }) => b.type === "text"
  );
  return textBlock?.text || "";
}

// ─── Streaming with tool calling ──────────────────────────────
const MAX_TOOL_ROUNDS = 8;

interface StreamOptions {
  messages: Array<Record<string, unknown>>;
  config: LLMConfig;
  tools?: OpenAITool[];
  toolExecutor?: ToolExecutor;
  onChunk: (text: string) => void;
  onToolCall?: (name: string, args: Record<string, unknown>) => void;
}

export async function streamChat(opts: StreamOptions): Promise<string> {
  if (opts.config.provider === "openai") {
    return runOpenAIStream(opts, 0);
  }
  return runAnthropicStream(opts, 0);
}

// ─── OpenAI Streaming ─────────────────────────────────────────
interface ToolCallDelta {
  id: string;
  name: string;
  arguments: string;
}

async function runOpenAIStream(
  opts: StreamOptions,
  round: number
): Promise<string> {
  if (round >= MAX_TOOL_ROUNDS) return "";

  const body: Record<string, unknown> = {
    model: getModel(opts.config),
    messages: opts.messages,
    stream: true,
    temperature: 0.7,
  };
  if (opts.tools && opts.tools.length > 0) {
    body.tools = opts.tools;
  }

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${opts.config.apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenAI stream error: ${res.status} ${err}`);
  }

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let fullText = "";
  const toolCalls: Map<number, ToolCallDelta> = new Map();
  let finishReason = "";
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data: ")) continue;
      const payload = trimmed.slice(6);
      if (payload === "[DONE]") continue;

      try {
        const json = JSON.parse(payload);
        const choice = json.choices?.[0];
        if (!choice) continue;

        if (choice.finish_reason) finishReason = choice.finish_reason;

        const delta = choice.delta;
        if (delta?.content) {
          fullText += delta.content;
          opts.onChunk(delta.content);
        }

        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            if (!toolCalls.has(idx)) {
              toolCalls.set(idx, {
                id: tc.id || "",
                name: tc.function?.name || "",
                arguments: "",
              });
            }
            const entry = toolCalls.get(idx)!;
            if (tc.id) entry.id = tc.id;
            if (tc.function?.name) entry.name = tc.function.name;
            if (tc.function?.arguments)
              entry.arguments += tc.function.arguments;
          }
        }
      } catch {
        // skip malformed
      }
    }
  }

  // If tool calls and we have an executor
  if (
    finishReason === "tool_calls" &&
    toolCalls.size > 0 &&
    opts.toolExecutor
  ) {
    const tcArray = Array.from(toolCalls.values());

    const assistantMsg: Record<string, unknown> = {
      role: "assistant",
      content: fullText || null,
      tool_calls: tcArray.map((tc) => ({
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: tc.arguments },
      })),
    };

    const nextMessages = [...opts.messages, assistantMsg];

    for (const tc of tcArray) {
      const args = JSON.parse(tc.arguments || "{}");
      opts.onToolCall?.(tc.name, args);
      let result: string;
      try {
        result = await opts.toolExecutor(tc.name, args);
      } catch (err) {
        result = `Tool error: ${err}`;
      }
      nextMessages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: result,
      });
    }

    const continuation = await runOpenAIStream(
      { ...opts, messages: nextMessages },
      round + 1
    );
    return (fullText ? fullText + "\n" : "") + continuation;
  }

  return fullText;
}

// ─── Anthropic Streaming ──────────────────────────────────────
async function runAnthropicStream(
  opts: StreamOptions,
  round: number
): Promise<string> {
  if (round >= MAX_TOOL_ROUNDS) return "";

  // Separate system messages
  const systemMsgs: string[] = [];
  const convMessages: Array<Record<string, unknown>> = [];

  for (const m of opts.messages) {
    if (m.role === "system") {
      systemMsgs.push(m.content as string);
    } else {
      convMessages.push(m);
    }
  }

  // Convert tools to Anthropic format
  const anthropicTools = (opts.tools || []).map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters,
  }));

  const body: Record<string, unknown> = {
    model: getModel(opts.config),
    max_tokens: 4096,
    stream: true,
    messages: convMessages,
    temperature: 0.7,
  };
  if (systemMsgs.length > 0) body.system = systemMsgs.join("\n\n");
  if (anthropicTools.length > 0) body.tools = anthropicTools;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": opts.config.apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Anthropic stream error: ${res.status} ${err}`);
  }

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let fullText = "";
  let buffer = "";
  let stopReason = "";

  // Tool use tracking
  interface ToolUseBlock {
    id: string;
    name: string;
    inputJson: string;
  }
  const toolUseBlocks: Map<number, ToolUseBlock> = new Map();
  let currentBlockIdx = -1;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data: ")) continue;
      const payload = trimmed.slice(6);

      try {
        const json = JSON.parse(payload);

        switch (json.type) {
          case "content_block_start": {
            currentBlockIdx = json.index ?? currentBlockIdx + 1;
            if (json.content_block?.type === "tool_use") {
              toolUseBlocks.set(currentBlockIdx, {
                id: json.content_block.id,
                name: json.content_block.name,
                inputJson: "",
              });
            }
            break;
          }
          case "content_block_delta": {
            const idx = json.index ?? currentBlockIdx;
            if (json.delta?.type === "text_delta") {
              fullText += json.delta.text;
              opts.onChunk(json.delta.text);
            } else if (json.delta?.type === "input_json_delta") {
              const block = toolUseBlocks.get(idx);
              if (block) block.inputJson += json.delta.partial_json;
            }
            break;
          }
          case "message_delta": {
            if (json.delta?.stop_reason) stopReason = json.delta.stop_reason;
            break;
          }
        }
      } catch {
        // skip
      }
    }
  }

  // Handle tool use
  if (
    (stopReason === "tool_use" || toolUseBlocks.size > 0) &&
    opts.toolExecutor
  ) {
    const toolResults: Array<{ type: string; tool_use_id: string; content: string }> = [];
    const contentBlocks: Array<Record<string, unknown>> = [];

    if (fullText) {
      contentBlocks.push({ type: "text", text: fullText });
    }

    for (const [, block] of toolUseBlocks) {
      const args = JSON.parse(block.inputJson || "{}");
      contentBlocks.push({
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: args,
      });

      opts.onToolCall?.(block.name, args);
      let result: string;
      try {
        result = await opts.toolExecutor(block.name, args);
      } catch (err) {
        result = `Tool error: ${err}`;
      }
      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: result,
      });
    }

    const nextMessages = [
      ...convMessages,
      { role: "assistant", content: contentBlocks },
      { role: "user", content: toolResults },
    ];

    // Rebuild opts with system messages at front
    const fullMessages: Array<Record<string, unknown>> = [
      ...systemMsgs.map((s) => ({ role: "system" as const, content: s })),
      ...nextMessages,
    ];

    const continuation = await runAnthropicStream(
      { ...opts, messages: fullMessages },
      round + 1
    );
    return (fullText ? fullText + "\n" : "") + continuation;
  }

  return fullText;
}

// ─── Default Socratic opening (no API call; seeds UI immediately) ──
export const DEFAULT_SOCRATIC_OPENINGS: Record<NodeRole, string> = {
  Planner:
    "Welcome. As your Planner interviewer: what is the single most important outcome this initiative must deliver, and what would you consider a clear failure?",
  "UI/UX Designer":
    "Welcome. As your UI/UX interviewer: who is the primary user, and what is the one job-to-be-done this experience must nail on day one?",
  "Software Engineer":
    "Welcome. As your Software Engineer interviewer: what stack or platform constraints are non-negotiable, and what technical risk worries you most?",
  "ML Engineer":
    "Welcome. As your ML interviewer: what decision should this system make in production, and what mistake would be unacceptable?",
  Security:
    "Welcome. As your Security interviewer: what assets or data must be protected first, and which threat actor worries you most?",
  QA:
    "Welcome. As your QA interviewer: what must always be true before you consider a release shippable?",
};

export function createDefaultSocraticOpening(role: NodeRole): ChatMessage {
  return {
    id: uuidv4(),
    role: "assistant",
    content: DEFAULT_SOCRATIC_OPENINGS[role],
    timestamp: Date.now(),
  };
}

// ─── Socratic System Prompt Builder ───────────────────────────
const ROLE_PROBES: Record<NodeRole, string[]> = {
  Planner: [
    "Core objectives & success definition",
    "Target audience & pain points",
    "Feature prioritization (MVP vs nice-to-have)",
    "Dependencies & risk vectors",
    "Success metrics (KPIs/OKRs)",
  ],
  "UI/UX Designer": [
    "Design system & component library",
    "Key user flows & decision points",
    "Accessibility (WCAG level) & device targets",
    "Interaction patterns & state transitions",
    "Handoff format (Figma tokens, CSS variables, Storybook)",
  ],
  "Software Engineer": [
    "Tech stack constraints",
    "Architecture pattern (monolith/microservices/serverless)",
    "Data flow & entity relationships",
    "External API/service contracts",
    "Testing strategy & error handling",
  ],
  "ML Engineer": [
    "Model type & problem framing",
    "Training data availability, quality & labeling",
    "Evaluation metrics (accuracy, latency, cost)",
    "Deployment target (edge/cloud, batch/realtime)",
    "MLOps (versioning, drift monitoring, retraining)",
  ],
  Security: [
    "Threat model & adversary profile",
    "Compliance frameworks (GDPR, SOC2, HIPAA, PCI-DSS)",
    "Auth/authz design (RBAC/ABAC, SSO/OIDC)",
    "OWASP Top 10 surface analysis",
    "Incident response & forensics SLA",
  ],
  QA: [
    "Test coverage targets & critical paths",
    "Test pyramid (unit/integration/contract/e2e/perf)",
    "Environment topology & data seeding strategy",
    "Acceptance criteria format (BDD/Gherkin, sign-off)",
    "CI trigger strategy & flaky test SLA",
  ],
};

export function buildSocraticSystemPrompt(role: NodeRole): string {
  const probes = ROLE_PROBES[role];
  return `You are an expert ${role} conducting a Socratic interview to gather requirements for an AI agent specification.

## Your Domain Probes
${probes.map((p, i) => `${i + 1}. ${p}`).join("\n")}

## Protocol Rules
- Ask ONE highly specific, expert-level question at a time
- Never generate code, plans, or specs during the interview
- Ask meaningful follow-ups that probe deeper priorities and exact failure modes
- Goal: gather enough information to produce a precise, actionable spec
- After covering all domain areas thoroughly, let the user know they can lock the spec`;
}

// ─── Spec Generation Prompt ───────────────────────────────────
export function buildSpecGenPrompt(
  role: NodeRole,
  chatHistory: ChatMessage[]
): Array<{ role: string; content: string }> {
  const transcript = chatHistory
    .filter((m) => m.role !== "system")
    .map((m) => `[${m.role.toUpperCase()}]: ${m.content}`)
    .join("\n\n");

  return [
    {
      role: "system",
      content: `You are a JSON spec generator for the Context Tree system.
Based on the interview transcript below, produce a strict JSON specification.

Node Context:
- Role: ${role}

Interview Transcript:
${transcript}

Output ONLY a valid JSON object matching this schema (no markdown, no fences):
{
  "system_prompt": "Comprehensive AI operating instructions synthesized from the interview",
  "constraints": ["Each hard rule or limitation — one string per constraint"],
  "context_splicing_rules": "How this node's context combines with parent/sibling nodes",
  "allowed_tools": ["Specific tools or capabilities needed"],
  "linked_files": ["Absolute file paths mentioned, or empty array"],
  "status": "active",
  "specLocked": true
}`,
    },
    {
      role: "user",
      content: "Generate the JSON spec based on the interview above.",
    },
  ];
}

// ─── Active Node System Prompt Builder ────────────────────────
export function buildActiveSystemPrompt(
  nodeData: ContextNodeData,
  parentNodes: ContextNodeData[],
  workspaceRoot: string | null = null
): string {
  const { metadata } = nodeData;
  let prompt = metadata.system_prompt;

  prompt += `\n\n## Filesystem Access
You have direct access to the user's local filesystem via tool calls.
When writing code: ALWAYS use \`create_or_edit_local_file\` — never output raw fenced code blocks.
When inspecting existing code before editing: use \`read_local_file\` first.
Every path must be a real absolute filesystem path. On macOS, user home directories look like \`/Users/<name>/...\` — do not invent Linux-style \`/home/...\` paths unless you know they exist on this machine.`;

  if (workspaceRoot) {
    prompt += `\n\n## Default directory for new files
The editor has this workspace folder open (use this root for new files unless the user gives another absolute path):
\`${workspaceRoot}\`
Prefer creating files under this tree, e.g. \`${workspaceRoot}/agent-output/<filename>\`. Parent directories are created automatically when needed.`;
  } else {
    prompt += `\n\n## Default directory for new files
No workspace folder is open in the editor. Ask the user which absolute directory to use for new files (for example under their home directory), then use that full path in tool calls.`;
  }

  if (parentNodes.length > 0) {
    prompt += `\n\n## Inherited Parent Context`;
    parentNodes.forEach((parent, i) => {
      prompt += `\n### Parent ${i + 1}: "${parent.label}" (${parent.role})
- System Prompt: ${parent.metadata.system_prompt}
- Constraints: ${JSON.stringify(parent.metadata.constraints)}
- Context Splicing Rules: ${parent.metadata.context_splicing_rules}`;
    });
    prompt += `\nYour output MUST be compatible with all parent constraints above.`;
  }

  prompt += `\n\n## This Node's Locked Spec
- Constraints: ${JSON.stringify(metadata.constraints)}
- Context Splicing: ${metadata.context_splicing_rules}
- Allowed Tools: ${JSON.stringify(metadata.allowed_tools)}
- Linked Files: ${JSON.stringify(metadata.linked_files)}
Stay strictly within this spec. Never violate any constraint.`;

  return prompt;
}

// ─── Spec Sync Prompt ─────────────────────────────────────────
export function buildSyncPrompt(
  role: NodeRole,
  chatHistory: ChatMessage[],
  currentMetadata: NodeMetadata
): Array<{ role: string; content: string }> {
  const transcript = chatHistory
    .filter((m) => m.role !== "system")
    .map((m, i) => `[MSG ${i + 1}][${m.role.toUpperCase()}]: ${m.content}`)
    .join("\n\n");

  const currentSpec = {
    system_prompt: currentMetadata.system_prompt,
    constraints: currentMetadata.constraints,
    context_splicing_rules: currentMetadata.context_splicing_rules,
    allowed_tools: currentMetadata.allowed_tools,
    linked_files: currentMetadata.linked_files,
  };

  return [
    {
      role: "system",
      content: `You are a JSON spec synchronizer for the Context Tree system.
Rewrite the JSON metadata spec for this node based on its ENTIRE conversation history.

CRITICAL WEIGHTING RULE: Give SIGNIFICANTLY HIGHER WEIGHT to the most recent messages.
If recent messages contradict, override, or refine older constraints or decisions,
the NEWER information ALWAYS wins. Old constraints must be replaced when superseded.

Node Context:
- Role: ${role}

Full Conversation History (oldest → newest):
${transcript}

Current Spec (baseline):
${JSON.stringify(currentSpec, null, 2)}

Output ONLY a valid JSON object (no markdown, no fences):
{
  "system_prompt": "...",
  "constraints": [...],
  "context_splicing_rules": "...",
  "allowed_tools": [...],
  "linked_files": [...],
  "status": "active",
  "specLocked": true
}`,
    },
    {
      role: "user",
      content: "Synchronize the spec based on the full conversation history.",
    },
  ];
}

// ─── File Path Discovery ──────────────────────────────────────
export function discoverFilePaths(chatHistory: ChatMessage[]): string[] {
  const regex =
    /[A-Za-z]:[\\/][\w\\/\-.]+|\/[\w/\-.]+\.\w+/g;
  const paths = new Set<string>();
  for (const msg of chatHistory) {
    const matches = msg.content.match(regex);
    if (matches) matches.forEach((p) => paths.add(p));
  }
  return Array.from(paths);
}

// ─── Get filesystem tools for LLM ────────────────────────────
export function getFilesystemTools(): OpenAITool[] {
  return FILESYSTEM_TOOLS;
}
