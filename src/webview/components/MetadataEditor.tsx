import React, { useState } from "react";
import { useStore } from "../store/useStore";
import { highlightFiles, openFile } from "../utils/vscodeApi";

export default function MetadataEditor() {
  const node = useStore((s) =>
    s.nodes.find((n) => n.id === s.selectedNodeId)
  );
  const updateNodeMetadata = useStore((s) => s.updateNodeMetadata);
  const updateNodeData = useStore((s) => s.updateNodeData);
  const deleteNode = useStore((s) => s.deleteNode);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [newConstraint, setNewConstraint] = useState("");
  const [newFile, setNewFile] = useState("");

  if (!node) {
    return (
      <div className="p-4 text-gray-500 text-sm">
        Select a node to view metadata.
      </div>
    );
  }

  const { metadata } = node.data;
  const nodeId = node.id;

  return (
    <div className="p-4 space-y-4 overflow-y-auto h-full">
      <h2 className="text-sm font-semibold text-gray-200">Node Metadata</h2>

      {/* Label */}
      <div>
        <label className="text-xs text-gray-400 block mb-1">Label</label>
        <input
          type="text"
          value={node.data.label}
          onChange={(e) => updateNodeData(nodeId, { label: e.target.value })}
          className="w-full bg-[#2d2d2d] border border-gray-600 rounded px-2 py-1.5 text-xs text-gray-200"
        />
      </div>

      {/* Status */}
      <div className="flex gap-4 text-xs text-gray-400">
        <span>
          Status:{" "}
          <span className="text-gray-200">{metadata.status}</span>
        </span>
        <span>
          Locked:{" "}
          <span className="text-gray-200">
            {metadata.specLocked ? "Yes" : "No"}
          </span>
        </span>
      </div>

      {/* System Prompt */}
      <div>
        <label className="text-xs text-gray-400 block mb-1">
          System Prompt
        </label>
        <textarea
          value={metadata.system_prompt}
          onChange={(e) =>
            updateNodeMetadata(nodeId, { system_prompt: e.target.value })
          }
          rows={6}
          className="w-full bg-[#2d2d2d] border border-gray-600 rounded px-2 py-1.5 text-xs text-gray-200 resize-y"
        />
      </div>

      {/* Constraints */}
      <div>
        <label className="text-xs text-gray-400 block mb-1">Constraints</label>
        <div className="space-y-1">
          {metadata.constraints.map((c, i) => (
            <div key={i} className="flex gap-1 items-center">
              <span className="flex-1 text-xs text-gray-300 bg-[#2d2d2d] px-2 py-1 rounded truncate">
                {c}
              </span>
              <button
                onClick={() => {
                  const updated = metadata.constraints.filter(
                    (_, j) => j !== i
                  );
                  updateNodeMetadata(nodeId, { constraints: updated });
                }}
                className="text-red-400 text-xs hover:text-red-300 px-1"
              >
                ×
              </button>
            </div>
          ))}
          <div className="flex gap-1">
            <input
              type="text"
              value={newConstraint}
              onChange={(e) => setNewConstraint(e.target.value)}
              placeholder="Add constraint..."
              className="flex-1 bg-[#2d2d2d] border border-gray-600 rounded px-2 py-1 text-xs text-gray-200"
              onKeyDown={(e) => {
                if (e.key === "Enter" && newConstraint.trim()) {
                  updateNodeMetadata(nodeId, {
                    constraints: [
                      ...metadata.constraints,
                      newConstraint.trim(),
                    ],
                  });
                  setNewConstraint("");
                }
              }}
            />
          </div>
        </div>
      </div>

      {/* Context Splicing Rules */}
      <div>
        <label className="text-xs text-gray-400 block mb-1">
          Context Splicing Rules
        </label>
        <textarea
          value={metadata.context_splicing_rules}
          onChange={(e) =>
            updateNodeMetadata(nodeId, {
              context_splicing_rules: e.target.value,
            })
          }
          rows={2}
          className="w-full bg-[#2d2d2d] border border-gray-600 rounded px-2 py-1.5 text-xs text-gray-200 resize-y"
        />
      </div>

      {/* Linked Files */}
      <div>
        <label className="text-xs text-gray-400 block mb-1">
          Linked Files
        </label>
        <div className="space-y-1">
          {metadata.linked_files.map((f, i) => (
            <div key={i} className="flex gap-1 items-center">
              <button
                onClick={() => openFile(f)}
                className="flex-1 text-xs text-blue-300 hover:text-blue-200 bg-[#2d2d2d] px-2 py-1 rounded truncate text-left"
              >
                {f}
              </button>
              <button
                onClick={() => {
                  const updated = metadata.linked_files.filter(
                    (_, j) => j !== i
                  );
                  updateNodeMetadata(nodeId, { linked_files: updated });
                }}
                className="text-red-400 text-xs hover:text-red-300 px-1"
              >
                ×
              </button>
            </div>
          ))}
          <div className="flex gap-1">
            <input
              type="text"
              value={newFile}
              onChange={(e) => setNewFile(e.target.value)}
              placeholder="Add file path..."
              className="flex-1 bg-[#2d2d2d] border border-gray-600 rounded px-2 py-1 text-xs text-gray-200"
              onKeyDown={(e) => {
                if (e.key === "Enter" && newFile.trim()) {
                  updateNodeMetadata(nodeId, {
                    linked_files: [...metadata.linked_files, newFile.trim()],
                  });
                  setNewFile("");
                }
              }}
            />
          </div>
          {metadata.linked_files.length > 0 && (
            <button
              onClick={() => highlightFiles(metadata.linked_files)}
              className="text-[10px] text-gray-500 hover:text-gray-300"
            >
              Reveal in Explorer
            </button>
          )}
        </div>
      </div>

      {/* Danger Zone */}
      <div className="border-t border-red-900/30 pt-4 mt-4">
        <label className="text-xs text-red-400 block mb-2">Danger Zone</label>
        {deleteConfirm ? (
          <div className="flex gap-2">
            <button
              onClick={() => {
                deleteNode(nodeId);
                setDeleteConfirm(false);
              }}
              className="px-3 py-1 text-xs bg-red-600 rounded text-white"
            >
              Confirm Delete
            </button>
            <button
              onClick={() => setDeleteConfirm(false)}
              className="px-3 py-1 text-xs bg-gray-600 rounded text-white"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            onClick={() => setDeleteConfirm(true)}
            className="px-3 py-1 text-xs border border-red-600 text-red-400 rounded hover:bg-red-600/20"
          >
            Delete Node
          </button>
        )}
      </div>
    </div>
  );
}
