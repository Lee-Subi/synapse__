import { Node, Edge } from "reactflow";

// ─── Node Role & Status ───────────────────────────────────────
export type NodeRole =
  | "Planner"
  | "UI/UX Designer"
  | "Software Engineer"
  | "ML Engineer"
  | "Security"
  | "QA";

export type NodeStatus = "draft" | "active" | "merged";

// ─── Chat ─────────────────────────────────────────────────────
export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
}

// ─── Node Metadata (The Spec) ─────────────────────────────────
export interface NodeMetadata {
  system_prompt: string;
  constraints: string[];
  context_splicing_rules: string;
  allowed_tools: string[];
  linked_files: string[];
  status: NodeStatus;
  specLocked: boolean;
}

// ─── Node Data ────────────────────────────────────────────────
export interface ContextNodeData {
  label: string;
  role: NodeRole;
  metadata: NodeMetadata;
  chatHistory: ChatMessage[];
}

// ─── React Flow Aliases ───────────────────────────────────────
export type ContextNode = Node<ContextNodeData>;
export type ContextEdge = Edge;

export interface ContextTreeDb {
  nodes: ContextNode[];
  edges: ContextEdge[];
}

// ─── Compiler Merge ───────────────────────────────────────────
export interface CompilerMergeResult {
  conflict_analysis: string;
  merged_spec: NodeMetadata;
  resolved_code: string;
}

// ─── LLM Config ───────────────────────────────────────────────
export interface LLMConfig {
  provider: "openai" | "anthropic";
  apiKey: string;
  model?: string;
}

// ─── OpenAI Tool Definitions ──────────────────────────────────
export interface OpenAIToolParameter {
  type: string;
  description: string;
}

export interface OpenAIToolFunction {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, OpenAIToolParameter>;
    required: string[];
  };
}

export interface OpenAITool {
  type: "function";
  function: OpenAIToolFunction;
}

export const FILESYSTEM_TOOLS: OpenAITool[] = [
  {
    type: "function",
    function: {
      name: "read_local_file",
      description:
        "Read the complete UTF-8 contents of a local file from the user's filesystem.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Absolute filesystem path to the file",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_or_edit_local_file",
      description:
        "Create a new file or fully overwrite an existing file. ALWAYS use this tool when writing code.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Absolute destination path",
          },
          content: {
            type: "string",
            description: "Complete file content (the entire file, not a diff)",
          },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_terminal_command",
      description:
        "Execute a shell command in the workspace root and return stdout + stderr.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "Shell command to execute",
          },
          cwd: {
            type: "string",
            description: "Working directory (defaults to workspace root)",
          },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_files",
      description:
        "Search for a text pattern across files in a directory. Returns matching file paths.",
      parameters: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description: "Text pattern to search for",
          },
          directory: {
            type: "string",
            description:
              "Directory to search in (defaults to workspace root)",
          },
        },
        required: ["pattern"],
      },
    },
  },
];

// ─── Message Protocol ─────────────────────────────────────────
export type WebviewMessageType =
  | "LOAD_DB"
  | "SAVE_DB"
  | "HIGHLIGHT_FILES"
  | "OPEN_FILE"
  | "GET_WORKSPACE_ROOT"
  | "GENERATE_UUID"
  | "SHOW_ERROR"
  | "SHOW_INFO"
  | "REQUEST_FILE_READ"
  | "REQUEST_FILE_WRITE"
  | "REQUEST_TERMINAL_COMMAND"
  | "REQUEST_FILE_SEARCH"
  | "REQUEST_AGGREGATE_REPO"
  | "REQUEST_COLLECT_AND_RUN"
  | "REQUEST_RUN_PRODUCT";

export type ExtensionMessageType =
  | "DB_LOADED"
  | "WORKSPACE_ROOT"
  | "UUID_GENERATED"
  | "FILE_READ_SUCCESS"
  | "FILE_READ_ERROR"
  | "FILE_WRITE_SUCCESS"
  | "FILE_WRITE_ERROR"
  | "TERMINAL_COMMAND_SUCCESS"
  | "TERMINAL_COMMAND_ERROR"
  | "FILE_SEARCH_SUCCESS"
  | "FILE_SEARCH_ERROR"
  | "AGGREGATE_REPO_SUCCESS"
  | "AGGREGATE_REPO_ERROR"
  | "COLLECT_AND_RUN_SUCCESS"
  | "COLLECT_AND_RUN_ERROR"
  | "RUN_PRODUCT_SUCCESS"
  | "RUN_PRODUCT_ERROR";
