import { create } from "zustand";
import {
  NodeChange,
  EdgeChange,
  Connection,
  applyNodeChanges,
  applyEdgeChanges,
  addEdge,
  MarkerType,
} from "reactflow";
import { v4 as uuidv4 } from "uuid";
import {
  ContextNode,
  ContextEdge,
  ContextNodeData,
  NodeMetadata,
  NodeRole,
  NodeStatus,
  ChatMessage,
} from "../types";
import { saveDb } from "../utils/vscodeApi";
import { createDefaultSocraticOpening } from "../utils/llmClient";

// ─── Schema Migration ─────────────────────────────────────────
function normalizeNode(raw: unknown): ContextNode {
  const n = (raw ?? {}) as Record<string, unknown>;
  const d = (n.data ?? {}) as Record<string, unknown>;
  const m = (d.metadata ?? {}) as Record<string, unknown>;

  const linked_files: string[] = Array.isArray(m.linked_files)
    ? (m.linked_files as string[])
    : Array.isArray((m as Record<string, unknown>).files)
      ? ((m as Record<string, unknown>).files as string[])
      : [];

  const normalizedMeta: NodeMetadata = {
    system_prompt:
      typeof m.system_prompt === "string" ? (m.system_prompt as string) : "",
    constraints: Array.isArray(m.constraints)
      ? (m.constraints as string[])
      : [],
    context_splicing_rules:
      typeof m.context_splicing_rules === "string"
        ? (m.context_splicing_rules as string)
        : "",
    allowed_tools: Array.isArray(m.allowed_tools)
      ? (m.allowed_tools as string[])
      : [],
    linked_files,
    status: ["draft", "active", "merged"].includes(m.status as string)
      ? (m.status as NodeStatus)
      : "draft",
    specLocked: Boolean(m.specLocked),
  };

  const VALID_ROLES = [
    "Planner",
    "UI/UX Designer",
    "Software Engineer",
    "ML Engineer",
    "Security",
    "QA",
  ];
  const normalizedData: ContextNodeData = {
    label: typeof d.label === "string" ? (d.label as string) : "Untitled",
    role: VALID_ROLES.includes(d.role as string)
      ? (d.role as NodeRole)
      : "Software Engineer",
    metadata: normalizedMeta,
    chatHistory: Array.isArray(d.chatHistory)
      ? (d.chatHistory as ChatMessage[])
      : [],
  };

  return { ...n, data: normalizedData } as ContextNode;
}

// ─── Store Interface ──────────────────────────────────────────
interface ContextTreeState {
  nodes: ContextNode[];
  edges: ContextEdge[];
  selectedNodeId: string | null;
  workspaceRoot: string | null;
  isMergeMode: boolean;
  mergeSelectionIds: string[];

  hydrate: (nodes: ContextNode[], edges: ContextEdge[]) => void;
  onNodesChange: (changes: NodeChange[]) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  onConnect: (connection: Connection) => void;
  addNode: (parentId: string | null, role?: NodeRole) => ContextNode;
  deleteNode: (id: string) => void;
  deleteEdges: (ids: string[]) => void;
  updateNodeData: (id: string, data: Partial<ContextNodeData>) => void;
  updateNodeMetadata: (id: string, metadata: Partial<NodeMetadata>) => void;
  selectNode: (id: string | null) => void;
  getSelectedNode: () => ContextNode | undefined;
  appendChatMessage: (nodeId: string, message: ChatMessage) => void;
  updateLastAssistantMessage: (nodeId: string, content: string) => void;
  lockSpecFromAI: (nodeId: string, metadata: Partial<NodeMetadata>) => void;
  forkNode: (nodeId: string) => ContextNode | undefined;
  rollbackNode: (nodeId: string, messageIndex: number) => void;
  toggleMergeMode: () => void;
  toggleMergeSelection: (id: string) => void;
  clearMergeSelection: () => void;
  setWorkspaceRoot: (root: string | null) => void;
  persistDb: () => void;
}

export const useStore = create<ContextTreeState>((set, get) => ({
  nodes: [],
  edges: [],
  selectedNodeId: null,
  workspaceRoot: null,
  isMergeMode: false,
  mergeSelectionIds: [],

  hydrate: (nodes, edges) => {
    set({
      nodes: nodes.map(normalizeNode),
      edges: edges.map((e) => ({
        ...e,
        markerEnd: { type: MarkerType.ArrowClosed },
      })),
    });
  },

  onNodesChange: (changes) => {
    set((s) => ({ nodes: applyNodeChanges(changes, s.nodes) as ContextNode[] }));
    get().persistDb();
  },

  onEdgesChange: (changes) => {
    set((s) => ({ edges: applyEdgeChanges(changes, s.edges) }));
    get().persistDb();
  },

  onConnect: (connection) => {
    set((s) => ({
      edges: addEdge(
        {
          ...connection,
          animated: true,
          markerEnd: { type: MarkerType.ArrowClosed },
        },
        s.edges
      ),
    }));
    get().persistDb();
  },

  addNode: (parentId, role = "Software Engineer") => {
    const state = get();
    const parentNode = state.nodes.find((n) => n.id === parentId);

    const siblingCount = parentId
      ? state.edges.filter((e) => e.source === parentId).length
      : state.nodes.filter(
          (n) => !state.edges.some((e) => e.target === n.id)
        ).length;

    const id = uuidv4();
    const position = parentNode
      ? {
          x: parentNode.position.x + siblingCount * 320,
          y: parentNode.position.y + 220,
        }
      : { x: 100 + siblingCount * 320, y: 60 };

    const newNode: ContextNode = {
      id,
      type: "contextNode",
      position,
      data: {
        label: role,
        role,
        metadata: {
          system_prompt: "",
          constraints: [],
          context_splicing_rules: "",
          allowed_tools: [],
          linked_files: [],
          status: "draft",
          specLocked: false,
        },
        chatHistory: [createDefaultSocraticOpening(role)],
      },
    };

    const newEdge: ContextEdge | null = parentId
      ? {
          id: `e-${parentId}-${id}`,
          source: parentId,
          target: id,
          animated: true,
          markerEnd: { type: MarkerType.ArrowClosed },
        }
      : null;

    set((s) => ({
      nodes: [...s.nodes, newNode],
      edges: newEdge ? [...s.edges, newEdge] : s.edges,
      selectedNodeId: id,
    }));
    get().persistDb();
    return newNode;
  },

  deleteNode: (id) => {
    set((s) => ({
      nodes: s.nodes.filter((n) => n.id !== id),
      edges: s.edges.filter((e) => e.source !== id && e.target !== id),
      selectedNodeId: s.selectedNodeId === id ? null : s.selectedNodeId,
    }));
    get().persistDb();
  },

  deleteEdges: (ids) => {
    set((s) => ({
      edges: s.edges.filter((e) => !ids.includes(e.id)),
    }));
    get().persistDb();
  },

  updateNodeData: (id, data) => {
    set((s) => ({
      nodes: s.nodes.map((n) =>
        n.id !== id ? n : { ...n, data: { ...n.data, ...data } }
      ),
    }));
    get().persistDb();
  },

  updateNodeMetadata: (id, metadata) => {
    set((s) => ({
      nodes: s.nodes.map((n) =>
        n.id !== id
          ? n
          : {
              ...n,
              data: {
                ...n.data,
                metadata: { ...n.data.metadata, ...metadata },
              },
            }
      ),
    }));
    get().persistDb();
  },

  selectNode: (id) => {
    set({ selectedNodeId: id });
  },

  getSelectedNode: () => {
    const s = get();
    return s.nodes.find((n) => n.id === s.selectedNodeId);
  },

  appendChatMessage: (nodeId, message) => {
    set((s) => ({
      nodes: s.nodes.map((n) =>
        n.id !== nodeId
          ? n
          : {
              ...n,
              data: {
                ...n.data,
                chatHistory: [...n.data.chatHistory, message],
              },
            }
      ),
    }));
    get().persistDb();
  },

  updateLastAssistantMessage: (nodeId, content) => {
    set((s) => ({
      nodes: s.nodes.map((n) => {
        if (n.id !== nodeId) return n;
        const history = [...n.data.chatHistory];
        for (let i = history.length - 1; i >= 0; i--) {
          if (history[i].role === "assistant") {
            history[i] = { ...history[i], content };
            break;
          }
        }
        return { ...n, data: { ...n.data, chatHistory: history } };
      }),
    }));
    get().persistDb();
  },

  lockSpecFromAI: (nodeId, metadata) => {
    set((s) => ({
      nodes: s.nodes.map((n) =>
        n.id !== nodeId
          ? n
          : {
              ...n,
              data: {
                ...n.data,
                metadata: {
                  ...n.data.metadata,
                  ...metadata,
                  status: "active" as const,
                  specLocked: true,
                },
              },
            }
      ),
    }));
    get().persistDb();
  },

  forkNode: (nodeId) => {
    const original = get().nodes.find((n) => n.id === nodeId);
    if (!original) return undefined;

    const newId = uuidv4();
    const clonedData: ContextNodeData = JSON.parse(
      JSON.stringify(original.data)
    );
    clonedData.label = `${clonedData.label} (fork)`;
    clonedData.metadata.status = "draft";
    clonedData.metadata.specLocked = false;

    const forkedNode: ContextNode = {
      id: newId,
      type: "contextNode",
      position: {
        x: original.position.x + 340,
        y: original.position.y,
      },
      data: clonedData,
    };

    const parentEdge = get().edges.find((e) => e.target === nodeId);
    const forkEdge: ContextEdge | null = parentEdge
      ? {
          id: `e-${parentEdge.source}-${newId}`,
          source: parentEdge.source,
          target: newId,
          animated: true,
          style: { strokeDasharray: "5,5" },
          markerEnd: { type: MarkerType.ArrowClosed },
        }
      : null;

    set((s) => ({
      nodes: [...s.nodes, forkedNode],
      edges: forkEdge ? [...s.edges, forkEdge] : s.edges,
      selectedNodeId: newId,
    }));
    get().persistDb();
    return forkedNode;
  },

  rollbackNode: (nodeId, messageIndex) => {
    set((s) => ({
      nodes: s.nodes.map((n) =>
        n.id !== nodeId
          ? n
          : {
              ...n,
              data: {
                ...n.data,
                chatHistory: n.data.chatHistory.slice(0, messageIndex + 1),
              },
            }
      ),
    }));
    get().persistDb();
  },

  toggleMergeMode: () => {
    set((s) => ({
      isMergeMode: !s.isMergeMode,
      mergeSelectionIds: [],
    }));
  },

  toggleMergeSelection: (id) => {
    set((s) => {
      const ids = s.mergeSelectionIds;
      if (ids.includes(id)) {
        return { mergeSelectionIds: ids.filter((i) => i !== id) };
      }
      if (ids.length >= 2) return {};
      return { mergeSelectionIds: [...ids, id] };
    });
  },

  clearMergeSelection: () => {
    set({ mergeSelectionIds: [] });
  },

  setWorkspaceRoot: (root) => {
    set({ workspaceRoot: root });
  },

  persistDb: () => {
    const { nodes, edges } = get();
    saveDb(nodes, edges);
  },
}));
