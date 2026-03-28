import React, { memo } from "react";
import { Handle, Position, NodeProps } from "reactflow";
import { ContextNodeData, NodeRole } from "../types";
import { useStore } from "../store/useStore";

const ROLE_CONFIG: Record<
  NodeRole,
  { border: string; badge: string; icon: string; hex: string }
> = {
  Planner: {
    border: "border-blue-500",
    badge: "bg-blue-500/15 text-blue-300",
    icon: "🗺️",
    hex: "#3b82f6",
  },
  "UI/UX Designer": {
    border: "border-pink-500",
    badge: "bg-pink-500/15 text-pink-300",
    icon: "🎨",
    hex: "#ec4899",
  },
  "Software Engineer": {
    border: "border-green-500",
    badge: "bg-green-500/15 text-green-300",
    icon: "💻",
    hex: "#22c55e",
  },
  "ML Engineer": {
    border: "border-amber-500",
    badge: "bg-amber-500/15 text-amber-300",
    icon: "🤖",
    hex: "#f59e0b",
  },
  Security: {
    border: "border-red-500",
    badge: "bg-red-500/15 text-red-300",
    icon: "🛡️",
    hex: "#ef4444",
  },
  QA: {
    border: "border-teal-500",
    badge: "bg-teal-500/15 text-teal-300",
    icon: "🧪",
    hex: "#14b8a6",
  },
};

const STATUS_DOT: Record<string, string> = {
  draft: "bg-gray-400",
  active: "bg-green-400",
  merged: "bg-purple-400",
};

function ContextNodeCard({ id, data, selected }: NodeProps<ContextNodeData>) {
  const { role, label, metadata, chatHistory } = data;
  const config = ROLE_CONFIG[role];
  const selectNode = useStore((s) => s.selectNode);
  const isMergeMode = useStore((s) => s.isMergeMode);
  const mergeIds = useStore((s) => s.mergeSelectionIds);
  const toggleMerge = useStore((s) => s.toggleMergeSelection);
  const isMergeSelected = mergeIds.includes(id);

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isMergeMode) {
      toggleMerge(id);
    } else {
      selectNode(id);
    }
  };

  return (
    <div
      onClick={handleClick}
      className={`
        relative rounded-lg border-2 ${config.border}
        bg-[#1e1e1e] px-3 py-2 min-w-[200px] max-w-[260px]
        cursor-pointer transition-shadow
        ${selected ? "shadow-lg shadow-white/10 ring-1 ring-white/20" : ""}
        ${isMergeSelected ? "ring-2 ring-yellow-400" : ""}
      `}
    >
      <Handle
        type="target"
        position={Position.Top}
        className="!bg-gray-500 !w-2 !h-2"
      />

      {/* Header */}
      <div className="flex items-center justify-between mb-1">
        <span className={`text-xs px-1.5 py-0.5 rounded ${config.badge}`}>
          {config.icon} {role}
        </span>
        <div className="flex items-center gap-1">
          <span
            className={`w-2 h-2 rounded-full ${STATUS_DOT[metadata.status]}`}
          />
          <span className="text-[10px] text-gray-500">{metadata.status}</span>
        </div>
      </div>

      {/* Label */}
      <div className="text-sm font-medium text-gray-200 truncate">{label}</div>

      {/* Stats */}
      <div className="text-[10px] text-gray-500 mt-1">
        {chatHistory.length} msgs · {metadata.linked_files.length} files
        {metadata.specLocked && " · 🔒"}
      </div>

      <Handle
        type="source"
        position={Position.Bottom}
        className="!bg-gray-500 !w-2 !h-2"
      />
    </div>
  );
}

export default memo(ContextNodeCard);
export { ROLE_CONFIG };
