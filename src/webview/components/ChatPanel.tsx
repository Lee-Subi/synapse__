import React, { useState, useRef, useEffect, useCallback } from "react";
import { v4 as uuidv4 } from "uuid";
import { useStore } from "../store/useStore";
import { ChatMessage, ContextNode, FILESYSTEM_TOOLS } from "../types";
import { getLLMConfig } from "./SettingsPanel";
import {
  buildSocraticSystemPrompt,
  buildSpecGenPrompt,
  buildActiveSystemPrompt,
  buildSyncPrompt,
  callLLM,
  streamChat,
  discoverFilePaths,
  ToolExecutor,
  createDefaultSocraticOpening,
} from "../utils/llmClient";
import {
  requestFileRead,
  requestFileWrite,
  requestTerminalCommand,
  requestFileSearch,
  showError,
} from "../utils/vscodeApi";

// ─── Tool Executor ────────────────────────────────────────────
const toolExecutor: ToolExecutor = async (name, args) => {
  switch (name) {
    case "read_local_file": {
      const res = await requestFileRead(args.path as string);
      return res.content;
    }
    case "create_or_edit_local_file": {
      await requestFileWrite(args.path as string, args.content as string);
      return `File written: ${args.path}`;
    }
    case "run_terminal_command": {
      const res = await requestTerminalCommand(
        args.command as string,
        args.cwd as string | undefined
      );
      return res.output;
    }
    case "search_files": {
      const res = await requestFileSearch(
        args.pattern as string,
        args.directory as string | undefined
      );
      return res.files.join("\n") || "No matches found";
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
};

export default function ChatPanel() {
  const selectedNodeId = useStore((s) => s.selectedNodeId);
  const node = useStore((s) =>
    s.nodes.find((n) => n.id === s.selectedNodeId)
  );
  const nodes = useStore((s) => s.nodes);
  const edges = useStore((s) => s.edges);
  const appendChatMessage = useStore((s) => s.appendChatMessage);
  const updateLastAssistantMessage = useStore(
    (s) => s.updateLastAssistantMessage
  );
  const lockSpecFromAI = useStore((s) => s.lockSpecFromAI);
  const updateNodeMetadata = useStore((s) => s.updateNodeMetadata);
  const updateNodeData = useStore((s) => s.updateNodeData);
  const rollbackNode = useStore((s) => s.rollbackNode);
  const workspaceRoot = useStore((s) => s.workspaceRoot);

  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [isLocking, setIsLocking] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [rollbackPending, setRollbackPending] = useState<number | null>(null);
  const [toolActivity, setToolActivity] = useState<string[]>([]);
  const [apiKeyBanner, setApiKeyBanner] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const streamAccRef = useRef("");

  const scrollToBottom = useCallback(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [node?.data.chatHistory.length, scrollToBottom]);

  // Legacy drafts saved with empty chat: seed role-based opening (no LLM required)
  useEffect(() => {
    if (
      !node ||
      node.data.metadata.status !== "draft" ||
      node.data.chatHistory.length > 0
    ) {
      return;
    }
    appendChatMessage(node.id, createDefaultSocraticOpening(node.data.role));
  }, [
    node?.id,
    node?.data.metadata.status,
    node?.data.chatHistory.length,
    node?.data.role,
    appendChatMessage,
  ]);

  // Auto-read linked files on activation
  useEffect(() => {
    if (
      node &&
      node.data.metadata.status === "active" &&
      node.data.metadata.specLocked &&
      node.data.chatHistory.length > 0
    ) {
      const lastMsg = node.data.chatHistory[node.data.chatHistory.length - 1];
      if (
        lastMsg.role === "system" &&
        lastMsg.content.includes("Spec locked")
      ) {
        autoReadLinkedFiles(node);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node?.data.metadata.specLocked]);

  const autoReadLinkedFiles = async (n: ContextNode) => {
    const files = n.data.metadata.linked_files;
    if (files.length === 0) return;

    for (const f of files) {
      try {
        await requestFileRead(f);
      } catch {
        // skip unreadable
      }
    }
  };

  const getParentNodes = () => {
    if (!selectedNodeId) return [];
    const parentEdges = edges.filter((e) => e.target === selectedNodeId);
    return parentEdges
      .map((e) => nodes.find((n) => n.id === e.source))
      .filter(Boolean)
      .map((n) => n!.data);
  };

  const handleSendMessage = async (text: string) => {
    if (!node || !selectedNodeId || isStreaming) return;

    const config = getLLMConfig();
    if (!config.apiKey) {
      setApiKeyBanner(true);
      showError(
        "Add an API key in the Settings tab (⚙) to run the interview with the model."
      );
      return;
    }
    setApiKeyBanner(false);

    const userMsg: ChatMessage = {
      id: uuidv4(),
      role: "user",
      content: text,
      timestamp: Date.now(),
    };
    appendChatMessage(selectedNodeId, userMsg);

    // Prepare assistant placeholder
    const assistantMsg: ChatMessage = {
      id: uuidv4(),
      role: "assistant",
      content: "",
      timestamp: Date.now(),
    };
    appendChatMessage(selectedNodeId, assistantMsg);
    setIsStreaming(true);
    streamAccRef.current = "";
    setToolActivity([]);

    try {
      // Must read fresh state: `node` from render is stale after appendChatMessage,
      // otherwise the latest user turn is never sent to the LLM and history won't save correctly per node.
      const currentNode = useStore
        .getState()
        .nodes.find((n) => n.id === selectedNodeId);
      if (!currentNode) return;

      let historyForApi = currentNode.data.chatHistory.filter(
        (m) => m.role !== "system"
      );
      const last = historyForApi[historyForApi.length - 1];
      if (
        last?.role === "assistant" &&
        last.content === ""
      ) {
        historyForApi = historyForApi.slice(0, -1);
      }

      const isDraft = currentNode.data.metadata.status === "draft";

      const allMessages: Array<Record<string, unknown>> = [];

      if (isDraft) {
        // Socratic mode
        allMessages.push({
          role: "system",
          content: buildSocraticSystemPrompt(currentNode.data.role),
        });
        for (const m of historyForApi) {
          allMessages.push({ role: m.role, content: m.content });
        }
      } else {
        // Active agent mode
        const parentData = getParentNodes();
        allMessages.push({
          role: "system",
          content: buildActiveSystemPrompt(
            currentNode.data,
            parentData,
            workspaceRoot
          ),
        });
        for (const m of historyForApi) {
          allMessages.push({ role: m.role, content: m.content });
        }
      }

      const tools = isDraft ? undefined : FILESYSTEM_TOOLS;
      const executor = isDraft ? undefined : toolExecutor;

      await streamChat({
        messages: allMessages,
        config,
        tools,
        toolExecutor: executor,
        onChunk: (chunk) => {
          streamAccRef.current += chunk;
          updateLastAssistantMessage(selectedNodeId, streamAccRef.current);
        },
        onToolCall: (name, args) => {
          setToolActivity((prev) => [
            ...prev,
            `🔧 ${name}(${JSON.stringify(args).slice(0, 80)}...)`,
          ]);
        },
      });
    } catch (err) {
      updateLastAssistantMessage(
        selectedNodeId,
        `Error: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      setIsStreaming(false);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim()) return;
    const text = input.trim();
    setInput("");
    handleSendMessage(text);
  };

  const handleLockSpec = async () => {
    if (!node || !selectedNodeId) return;
    const config = getLLMConfig();
    if (!config.apiKey) {
      setApiKeyBanner(true);
      showError(
        "Configure an API key in the Settings tab (⚙) before locking the spec."
      );
      return;
    }

    setIsLocking(true);
    try {
      const messages = buildSpecGenPrompt(
        node.data.role,
        node.data.chatHistory
      );
      const raw = await callLLM(messages, config, config.provider === "openai");
      const cleaned = raw
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```\s*$/, "")
        .trim();
      const spec = JSON.parse(cleaned);

      lockSpecFromAI(selectedNodeId, spec);

      const sysMsg: ChatMessage = {
        id: uuidv4(),
        role: "system",
        content:
          "🔒 Spec locked — node is now active. The agent will operate within the generated specification.",
        timestamp: Date.now(),
      };
      appendChatMessage(selectedNodeId, sysMsg);
    } catch (err) {
      const errMsg: ChatMessage = {
        id: uuidv4(),
        role: "system",
        content: `Failed to lock spec: ${err instanceof Error ? err.message : String(err)}`,
        timestamp: Date.now(),
      };
      appendChatMessage(selectedNodeId, errMsg);
    } finally {
      setIsLocking(false);
    }
  };

  const handleSyncSpec = async () => {
    if (!node || !selectedNodeId) return;
    const config = getLLMConfig();
    if (!config.apiKey) {
      setApiKeyBanner(true);
      showError("Configure an API key in the Settings tab (⚙) before syncing.");
      return;
    }

    setIsSyncing(true);
    try {
      const messages = buildSyncPrompt(
        node.data.role,
        node.data.chatHistory,
        node.data.metadata
      );
      const raw = await callLLM(messages, config, config.provider === "openai");
      const cleaned = raw
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```\s*$/, "")
        .trim();
      const newSpec = JSON.parse(cleaned);

      // Auto-discover file paths
      const discovered = discoverFilePaths(node.data.chatHistory);
      const existingFiles = new Set(newSpec.linked_files || []);
      for (const p of discovered) {
        if (!existingFiles.has(p)) {
          newSpec.linked_files.push(p);
        }
      }

      updateNodeData(selectedNodeId, { metadata: { ...node.data.metadata, ...newSpec } });

      // Broadcast to children
      const childEdges = edges.filter((e) => e.source === selectedNodeId);
      for (const edge of childEdges) {
        const childMsg: ChatMessage = {
          id: uuidv4(),
          role: "system",
          content:
            "⚠️ Parent context updated — re-run sync or manually review inherited constraints.",
          timestamp: Date.now(),
        };
        appendChatMessage(edge.target, childMsg);
      }

      const sysMsg: ChatMessage = {
        id: uuidv4(),
        role: "system",
        content:
          "🔄 Spec synced — metadata rewritten from full chat history (recent messages take precedence).",
        timestamp: Date.now(),
      };
      appendChatMessage(selectedNodeId, sysMsg);
    } catch (err) {
      const errMsg: ChatMessage = {
        id: uuidv4(),
        role: "system",
        content: `Sync failed: ${err instanceof Error ? err.message : String(err)}`,
        timestamp: Date.now(),
      };
      appendChatMessage(selectedNodeId, errMsg);
    } finally {
      setIsSyncing(false);
    }
  };

  const handleRollback = (index: number) => {
    if (!selectedNodeId) return;
    rollbackNode(selectedNodeId, index);
    setRollbackPending(null);
  };

  if (!node) {
    return (
      <div className="p-4 text-gray-500 text-sm">
        Select a node to start chatting.
      </div>
    );
  }

  const isDraft = node.data.metadata.status === "draft";
  const userMessageCount = node.data.chatHistory.filter(
    (m) => m.role === "user"
  ).length;
  const canLockSpec = userMessageCount >= 1;

  return (
    <div className="flex flex-col h-full">
      {apiKeyBanner && (
        <div className="px-3 py-2 bg-amber-900/40 border-b border-amber-700/50 text-[11px] text-amber-100/90">
          Open the <span className="font-semibold">Settings</span> tab (⚙) and
          paste your API key. The opening question above works offline; the
          model needs a key for follow-up turns, Lock Spec, and Sync.
        </div>
      )}
      {/* Header */}
      <div className="px-4 py-2 border-b border-gray-700 flex items-center justify-between">
        <div>
          <span className="text-sm font-medium text-gray-200">
            {node.data.label}
          </span>
          <span className="text-xs text-gray-500 ml-2">
            {isDraft ? "Socratic Interview" : "Agent Chat"}
          </span>
        </div>
        <div className="flex gap-2">
          {isDraft && !node.data.metadata.specLocked && (
            <button
              type="button"
              onClick={handleLockSpec}
              disabled={isLocking || !canLockSpec}
              title={
                canLockSpec
                  ? "Generate JSON spec from this interview"
                  : "Send at least one answer in the chat before locking"
              }
              className="px-2 py-1 text-xs bg-amber-600 hover:bg-amber-700 rounded text-white disabled:opacity-40"
            >
              {isLocking ? "Generating..." : "📐 Lock Spec"}
            </button>
          )}
          {!isDraft && node.data.metadata.specLocked && (
            <button
              onClick={handleSyncSpec}
              disabled={isSyncing}
              className="px-2 py-1 text-xs bg-blue-600 hover:bg-blue-700 rounded text-white disabled:opacity-40"
            >
              {isSyncing ? "Syncing..." : "🔄 Sync Context to Spec"}
            </button>
          )}
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {node.data.chatHistory.map((msg, i) => (
          <div
            key={msg.id}
            className={`group relative ${
              msg.role === "user"
                ? "ml-8"
                : msg.role === "system"
                  ? "mx-4"
                  : "mr-8"
            }`}
          >
            <div
              className={`rounded-lg px-3 py-2 text-sm ${
                msg.role === "user"
                  ? "bg-blue-600/20 text-blue-100"
                  : msg.role === "system"
                    ? "bg-gray-700/50 text-gray-400 text-xs italic"
                    : "bg-[#2d2d2d] text-gray-200"
              }`}
            >
              <div className="whitespace-pre-wrap break-words">
                {msg.content || (isStreaming && i === node.data.chatHistory.length - 1 ? "..." : "")}
              </div>
            </div>

            {/* Rollback button */}
            {msg.role !== "system" && !isStreaming && (
              <div className="absolute -left-6 top-1 opacity-0 group-hover:opacity-100 transition-opacity">
                {rollbackPending === i ? (
                  <div className="flex gap-1">
                    <button
                      onClick={() => handleRollback(i)}
                      className="text-[10px] px-1 bg-red-600 rounded text-white"
                    >
                      Confirm
                    </button>
                    <button
                      onClick={() => setRollbackPending(null)}
                      className="text-[10px] px-1 bg-gray-600 rounded text-white"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => setRollbackPending(i)}
                    className="text-[10px] text-gray-500 hover:text-gray-300"
                    title="Rollback here"
                  >
                    ↩
                  </button>
                )}
              </div>
            )}
          </div>
        ))}

        {/* Tool activity */}
        {toolActivity.length > 0 && (
          <div className="text-[10px] text-gray-500 space-y-0.5 border-l-2 border-gray-700 pl-2">
            {toolActivity.map((t, i) => (
              <div key={i}>{t}</div>
            ))}
          </div>
        )}

        <div ref={chatEndRef} />
      </div>

      {/* Input */}
      <form
        onSubmit={handleSubmit}
        className="p-3 border-t border-gray-700 flex gap-2"
      >
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={isDraft ? "Answer the interview..." : "Ask the agent..."}
          disabled={isStreaming}
          className="flex-1 bg-[#2d2d2d] border border-gray-600 rounded px-3 py-1.5 text-sm text-gray-200 placeholder-gray-500 disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={isStreaming || !input.trim()}
          className="px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-700 rounded text-white disabled:opacity-40"
        >
          Send
        </button>
      </form>
    </div>
  );
}
