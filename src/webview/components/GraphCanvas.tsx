import React, { useCallback, useState } from "react";
import ReactFlow, {
  MiniMap,
  Background,
  BackgroundVariant,
  MarkerType,
  Panel,
} from "reactflow";
import "reactflow/dist/style.css";
import { useStore } from "../store/useStore";
import ContextNodeCard, { ROLE_CONFIG } from "./ContextNodeCard";
import { NodeRole } from "../types";
import { buildAggregateCopyList } from "../utils/gatherAgentFiles";
import {
  requestAggregateRepo,
  requestCollectAndRun,
  requestRunProduct,
  showError,
  showInfo,
  highlightFiles,
} from "../utils/vscodeApi";

const nodeTypes = { contextNode: ContextNodeCard };

/** Must match extension aggregate target */
const CONSOLIDATED_REL = "agent-output/consolidated";

const ALL_ROLES: NodeRole[] = [
  "Planner",
  "UI/UX Designer",
  "Software Engineer",
  "ML Engineer",
  "Security",
  "QA",
];

export default function GraphCanvas() {
  const nodes = useStore((s) => s.nodes);
  const edges = useStore((s) => s.edges);
  const onNodesChange = useStore((s) => s.onNodesChange);
  const onEdgesChange = useStore((s) => s.onEdgesChange);
  const onConnect = useStore((s) => s.onConnect);
  const addNode = useStore((s) => s.addNode);
  const selectedNodeId = useStore((s) => s.selectedNodeId);
  const selectNode = useStore((s) => s.selectNode);
  const forkNode = useStore((s) => s.forkNode);
  const isMergeMode = useStore((s) => s.isMergeMode);
  const toggleMergeMode = useStore((s) => s.toggleMergeMode);
  const workspaceRoot = useStore((s) => s.workspaceRoot);

  const [showRolePicker, setShowRolePicker] = useState(false);
  const [toolbarBusy, setToolbarBusy] = useState(false);

  const handleAddNode = useCallback(
    (role: NodeRole) => {
      addNode(selectedNodeId, role);
      setShowRolePicker(false);
    },
    [addNode, selectedNodeId]
  );

  const handleFork = useCallback(() => {
    if (selectedNodeId) forkNode(selectedNodeId);
  }, [forkNode, selectedNodeId]);

  const handleAggregateToRepo = useCallback(async () => {
    const root = useStore.getState().workspaceRoot;
    if (!root) {
      showError(
        "Open a folder in VS Code/Cursor (File → Open Folder) so we know where to write."
      );
      return;
    }
    const allNodes = useStore.getState().nodes;
    if (allNodes.length === 0) {
      showError("Add at least one node before collecting files.");
      return;
    }
    const copies = buildAggregateCopyList(allNodes);
    if (copies.length === 0) {
      showError(
        "No file paths found. Link files in each node's metadata or mention absolute paths in chat."
      );
      return;
    }
    setToolbarBusy(true);
    try {
      const res = await requestAggregateRepo({
        targetRelative: CONSOLIDATED_REL,
        copies,
      });
      const skipNote =
        res.skipped.length > 0
          ? ` (${res.skipped.length} missing or skipped)`
          : "";
      showInfo(
        `Copied ${res.copied} file(s) into consolidated repo.${skipNote}`
      );
      highlightFiles([res.manifestPath]);
    } catch (e) {
      showError(e instanceof Error ? e.message : String(e));
    } finally {
      setToolbarBusy(false);
    }
  }, []);

  const handleCollectAndRun = useCallback(async () => {
    const root = useStore.getState().workspaceRoot;
    if (!root) {
      showError(
        "Open a folder in VS Code/Cursor (File → Open Folder) so we know where to write."
      );
      return;
    }
    const allNodes = useStore.getState().nodes;
    if (allNodes.length === 0) {
      showError("Add at least one node before collecting files.");
      return;
    }
    const copies = buildAggregateCopyList(allNodes);
    if (copies.length === 0) {
      showError(
        "No file paths found. Link files in each node's metadata or mention absolute paths in chat."
      );
      return;
    }
    setToolbarBusy(true);
    try {
      const res = await requestCollectAndRun({
        targetRelative: CONSOLIDATED_REL,
        copies,
      });
      const skipNote =
        res.skipped.length > 0
          ? ` (${res.skipped.length} missing or skipped)`
          : "";
      highlightFiles([res.manifestPath]);
      if ("error" in res.run) {
        const mergeNote =
          res.merge && res.merge.length > 0
            ? ` Merged ${res.merge.length} file(s) into src/utils.`
            : "";
        showInfo(
          `Copied ${res.copied} file(s).${skipNote}${mergeNote} ${res.run.error}`
        );
      } else {
        const mergeNote =
          res.merge && res.merge.length > 0
            ? ` Merged ${res.merge.length} → src/utils.`
            : "";
        showInfo(
          `Copied ${res.copied} file(s).${skipNote}${mergeNote} Terminal: npm run ${res.run.script}`
        );
      }
    } catch (e) {
      showError(e instanceof Error ? e.message : String(e));
    } finally {
      setToolbarBusy(false);
    }
  }, []);

  const handleRunProductOnly = useCallback(async () => {
    if (!useStore.getState().workspaceRoot) {
      showError("Open a workspace folder first.");
      return;
    }
    setToolbarBusy(true);
    try {
      const res = await requestRunProduct(CONSOLIDATED_REL);
      if ("error" in res.run) {
        showError(res.run.error);
      } else {
        showInfo(`Terminal: npm run ${res.run.script} → ${res.run.cwd}`);
      }
    } catch (e) {
      showError(e instanceof Error ? e.message : String(e));
    } finally {
      setToolbarBusy(false);
    }
  }, []);

  const miniMapColor = useCallback((node: { data?: { role?: string } }) => {
    const role = node?.data?.role as NodeRole | undefined;
    return role && ROLE_CONFIG[role] ? ROLE_CONFIG[role].hex : "#666";
  }, []);

  return (
    <div className="flex-1 h-full relative">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        nodeTypes={nodeTypes}
        onPaneClick={() => selectNode(null)}
        defaultEdgeOptions={{
          animated: true,
          markerEnd: { type: MarkerType.ArrowClosed },
        }}
        fitView
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
        <MiniMap
          nodeColor={miniMapColor}
          maskColor="rgba(0,0,0,0.6)"
          style={{ background: "#111" }}
        />

        <Panel position="top-left" className="flex gap-2">
          {/* Add Node */}
          <div className="relative">
            <button
              onClick={() => setShowRolePicker(!showRolePicker)}
              className="px-3 py-1.5 text-xs bg-[#2d2d2d] border border-gray-600 rounded hover:bg-[#3d3d3d] text-gray-200"
            >
              + Add Node ▾
            </button>
            {showRolePicker && (
              <div className="absolute top-full left-0 mt-1 bg-[#252525] border border-gray-600 rounded shadow-lg z-50 min-w-[180px]">
                {ALL_ROLES.map((role) => (
                  <button
                    key={role}
                    onClick={() => handleAddNode(role)}
                    className="w-full text-left px-3 py-1.5 text-xs text-gray-200 hover:bg-[#3d3d3d] flex items-center gap-2"
                  >
                    <span>{ROLE_CONFIG[role].icon}</span>
                    <span>{role}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Fork */}
          <button
            onClick={handleFork}
            disabled={!selectedNodeId}
            className="px-3 py-1.5 text-xs bg-[#2d2d2d] border border-gray-600 rounded hover:bg-[#3d3d3d] text-gray-200 disabled:opacity-40"
          >
            ⑂ Fork
          </button>

          {/* Merge Mode */}
          <button
            onClick={toggleMergeMode}
            className={`px-3 py-1.5 text-xs border rounded ${
              isMergeMode
                ? "bg-yellow-500/20 border-yellow-500 text-yellow-300"
                : "bg-[#2d2d2d] border-gray-600 text-gray-200 hover:bg-[#3d3d3d]"
            }`}
          >
            ⊕ Merge {isMergeMode ? "(ON)" : ""}
          </button>

          <button
            type="button"
            onClick={handleAggregateToRepo}
            disabled={toolbarBusy || !workspaceRoot || nodes.length === 0}
            title={
              workspaceRoot
                ? "Copy all linked / chat-mentioned files into agent-output/consolidated (one folder per node)"
                : "Open a workspace folder first"
            }
            className="px-3 py-1.5 text-xs bg-[#2d2d2d] border border-gray-600 rounded hover:bg-[#3d3d3d] text-gray-200 disabled:opacity-40"
          >
            {toolbarBusy ? "…" : "📦 Collect to repo"}
          </button>

          <button
            type="button"
            onClick={handleCollectAndRun}
            disabled={toolbarBusy || !workspaceRoot || nodes.length === 0}
            title="Copy → merge *_N.ts into src/utils → npm install → build/tsc → npm run dev (see Synapse output if a step fails)"
            className="px-3 py-1.5 text-xs bg-emerald-900/50 border border-emerald-700/60 rounded hover:bg-emerald-800/50 text-emerald-100 disabled:opacity-40"
          >
            {toolbarBusy ? "…" : "▶ Collect & run"}
          </button>

          <button
            type="button"
            onClick={handleRunProductOnly}
            disabled={toolbarBusy || !workspaceRoot}
            title="npm install && npm run — uses workspace root package.json first (full repo), else agent-output/consolidated"
            className="px-3 py-1.5 text-xs bg-[#2d2d2d] border border-gray-600 rounded hover:bg-[#3d3d3d] text-gray-200 disabled:opacity-40"
          >
            {toolbarBusy ? "…" : "▶ Run product"}
          </button>
        </Panel>
      </ReactFlow>
    </div>
  );
}
