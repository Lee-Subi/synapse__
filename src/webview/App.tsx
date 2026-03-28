import React, { useEffect, useState } from "react";
import { ReactFlowProvider } from "reactflow";
import { useStore } from "./store/useStore";
import { loadDb, onMessage, getWorkspaceRoot } from "./utils/vscodeApi";
import GraphCanvas from "./components/GraphCanvas";
import ChatPanel from "./components/ChatPanel";
import MetadataEditor from "./components/MetadataEditor";
import MergePanel from "./components/MergePanel";
import SettingsPanel from "./components/SettingsPanel";

type Tab = "chat" | "metadata" | "merge" | "settings";

const TABS: { id: Tab; icon: string; label: string }[] = [
  { id: "chat", icon: "💬", label: "Chat" },
  { id: "metadata", icon: "🗂", label: "Metadata" },
  { id: "merge", icon: "⊕", label: "Merge" },
  { id: "settings", icon: "⚙", label: "Settings" },
];

export default function App() {
  const hydrate = useStore((s) => s.hydrate);
  const setWorkspaceRoot = useStore((s) => s.setWorkspaceRoot);
  const [activeTab, setActiveTab] = useState<Tab>("chat");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const unsub = onMessage((msg) => {
      switch (msg.type) {
        case "DB_LOADED":
          hydrate(msg.payload.nodes || [], msg.payload.edges || []);
          setReady(true);
          break;
        case "WORKSPACE_ROOT":
          setWorkspaceRoot(msg.payload);
          break;
      }
    });

    // Request initial data
    loadDb();
    getWorkspaceRoot();

    return unsub;
  }, [hydrate, setWorkspaceRoot]);

  if (!ready) {
    return (
      <div className="h-screen w-screen flex items-center justify-center text-gray-500">
        Loading Context Tree...
      </div>
    );
  }

  return (
    <ReactFlowProvider>
      <div className="h-screen w-screen flex">
        {/* Graph Canvas */}
        <GraphCanvas />

        {/* Right Sidebar */}
        <div className="w-80 flex-shrink-0 border-l border-gray-700 flex flex-col bg-[#1e1e1e]">
          {/* Tab Bar */}
          <div className="flex border-b border-gray-700">
            {TABS.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex-1 py-2 text-center text-sm transition-colors ${
                  activeTab === tab.id
                    ? "text-white border-b-2 border-blue-500"
                    : "text-gray-500 hover:text-gray-300"
                }`}
                title={tab.label}
              >
                {tab.icon}
              </button>
            ))}
          </div>

          {/* Tab Content */}
          <div className="flex-1 overflow-hidden">
            {activeTab === "chat" && <ChatPanel />}
            {activeTab === "metadata" && <MetadataEditor />}
            {activeTab === "merge" && <MergePanel />}
            {activeTab === "settings" && <SettingsPanel />}
          </div>
        </div>
      </div>
    </ReactFlowProvider>
  );
}
