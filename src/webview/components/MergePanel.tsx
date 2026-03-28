import React, { useState } from "react";
import { v4 as uuidv4 } from "uuid";
import { MarkerType } from "reactflow";
import { useStore } from "../store/useStore";
import { ChatMessage, ContextNode, ContextEdge } from "../types";
import { getLLMConfig } from "./SettingsPanel";
import { runCompilerMerge } from "../utils/mergerLogic";

export default function MergePanel() {
  const isMergeMode = useStore((s) => s.isMergeMode);
  const mergeIds = useStore((s) => s.mergeSelectionIds);
  const nodes = useStore((s) => s.nodes);
  const toggleMergeMode = useStore((s) => s.toggleMergeMode);
  const clearMergeSelection = useStore((s) => s.clearMergeSelection);
  const [isMerging, setIsMerging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  const nodeA = nodes.find((n) => n.id === mergeIds[0]);
  const nodeB = nodes.find((n) => n.id === mergeIds[1]);

  const handleMerge = async () => {
    if (!nodeA || !nodeB) return;
    const config = getLLMConfig();
    if (!config.apiKey) {
      setError("Please configure your API key in Settings.");
      return;
    }

    setIsMerging(true);
    setError(null);
    setResult(null);

    try {
      const mergeResult = await runCompilerMerge(
        nodeA.data,
        nodeB.data,
        config
      );

      // Create merged node
      const mergedId = uuidv4();
      const position = {
        x: (nodeA.position.x + nodeB.position.x) / 2,
        y: Math.max(nodeA.position.y, nodeB.position.y) + 240,
      };

      // Build merged chat history
      const separator: ChatMessage = {
        id: uuidv4(),
        role: "system",
        content: "─── Merge Point ───",
        timestamp: Date.now(),
      };
      const analysisMsg: ChatMessage = {
        id: uuidv4(),
        role: "system",
        content: `📊 Conflict Analysis:\n${mergeResult.conflict_analysis}\n\n📝 Resolved Code:\n${mergeResult.resolved_code}`,
        timestamp: Date.now(),
      };

      const mergedNode: ContextNode = {
        id: mergedId,
        type: "contextNode",
        position,
        data: {
          label: `Merge: ${nodeA.data.label} + ${nodeB.data.label}`,
          role: nodeA.data.role,
          metadata: mergeResult.merged_spec,
          chatHistory: [
            ...nodeA.data.chatHistory,
            separator,
            ...nodeB.data.chatHistory,
            analysisMsg,
          ],
        },
      };

      const edgeA: ContextEdge = {
        id: `e-${nodeA.id}-${mergedId}`,
        source: nodeA.id,
        target: mergedId,
        animated: true,
        markerEnd: { type: MarkerType.ArrowClosed },
      };

      const edgeB: ContextEdge = {
        id: `e-${nodeB.id}-${mergedId}`,
        source: nodeB.id,
        target: mergedId,
        animated: true,
        markerEnd: { type: MarkerType.ArrowClosed },
      };

      useStore.setState((s) => ({
        nodes: [...s.nodes, mergedNode],
        edges: [...s.edges, edgeA, edgeB],
        selectedNodeId: mergedId,
        isMergeMode: false,
        mergeSelectionIds: [],
      }));
      useStore.getState().persistDb();

      setResult(
        `Merged successfully!\n\nConflict Analysis:\n${mergeResult.conflict_analysis}`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsMerging(false);
    }
  };

  if (!isMergeMode) {
    return (
      <div className="p-4 text-gray-500 text-sm">
        <p>Enable Merge Mode from the toolbar to select two nodes.</p>
        <button
          onClick={toggleMergeMode}
          className="mt-2 px-3 py-1.5 text-xs bg-[#2d2d2d] border border-gray-600 rounded hover:bg-[#3d3d3d] text-gray-200"
        >
          ⊕ Enter Merge Mode
        </button>
      </div>
    );
  }

  return (
    <div className="p-4 space-y-4">
      <h2 className="text-sm font-semibold text-yellow-300">
        Merge Mode Active
      </h2>
      <p className="text-xs text-gray-400">
        Click two nodes on the canvas to select them for merging.
      </p>

      {/* Selection status */}
      <div className="space-y-2">
        <div
          className={`text-xs px-2 py-1.5 rounded ${nodeA ? "bg-green-600/20 text-green-300" : "bg-gray-700 text-gray-500"}`}
        >
          Node A: {nodeA ? nodeA.data.label : "Not selected"}
        </div>
        <div
          className={`text-xs px-2 py-1.5 rounded ${nodeB ? "bg-green-600/20 text-green-300" : "bg-gray-700 text-gray-500"}`}
        >
          Node B: {nodeB ? nodeB.data.label : "Not selected"}
        </div>
      </div>

      {/* Actions */}
      <div className="flex gap-2">
        <button
          onClick={handleMerge}
          disabled={!nodeA || !nodeB || isMerging}
          className="flex-1 px-3 py-1.5 text-xs bg-yellow-600 hover:bg-yellow-700 rounded text-white disabled:opacity-40"
        >
          {isMerging ? "Running Compiler AI..." : "Run Compiler AI →"}
        </button>
        <button
          onClick={() => {
            clearMergeSelection();
            toggleMergeMode();
          }}
          className="px-3 py-1.5 text-xs bg-gray-600 rounded text-white"
        >
          Exit
        </button>
      </div>

      {/* Error */}
      {error && (
        <div className="text-xs text-red-400 bg-red-900/20 p-2 rounded">
          {error}
        </div>
      )}

      {/* Result */}
      {result && (
        <div className="text-xs text-green-300 bg-green-900/20 p-2 rounded whitespace-pre-wrap">
          {result}
        </div>
      )}
    </div>
  );
}
