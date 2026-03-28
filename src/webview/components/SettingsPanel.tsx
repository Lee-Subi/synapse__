import React, { useState, useEffect } from "react";
import { LLMConfig } from "../types";

const STORAGE_KEY = "context-tree:llm-config";

function loadConfig(): LLMConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return { provider: "openai", apiKey: "", model: "" };
}

function saveConfig(config: LLMConfig) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
}

export function getLLMConfig(): LLMConfig {
  return loadConfig();
}

export default function SettingsPanel() {
  const [config, setConfig] = useState<LLMConfig>(loadConfig);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    saveConfig(config);
  }, [config]);

  const update = (patch: Partial<LLMConfig>) => {
    setConfig((c) => ({ ...c, ...patch }));
    setSaved(false);
  };

  return (
    <div className="p-4 space-y-4">
      <h2 className="text-sm font-semibold text-gray-200">LLM Settings</h2>

      {/* Provider */}
      <div>
        <label className="text-xs text-gray-400 block mb-1">Provider</label>
        <select
          value={config.provider}
          onChange={(e) =>
            update({ provider: e.target.value as "openai" | "anthropic" })
          }
          className="w-full bg-[#2d2d2d] border border-gray-600 rounded px-2 py-1.5 text-xs text-gray-200"
        >
          <option value="openai">OpenAI</option>
          <option value="anthropic">Anthropic</option>
        </select>
      </div>

      {/* API Key */}
      <div>
        <label className="text-xs text-gray-400 block mb-1">API Key</label>
        <input
          type="password"
          value={config.apiKey}
          onChange={(e) => update({ apiKey: e.target.value })}
          placeholder={
            config.provider === "openai" ? "sk-..." : "sk-ant-api03-..."
          }
          className="w-full bg-[#2d2d2d] border border-gray-600 rounded px-2 py-1.5 text-xs text-gray-200"
        />
      </div>

      {/* Model Override */}
      <div>
        <label className="text-xs text-gray-400 block mb-1">
          Model Override (optional)
        </label>
        <input
          type="text"
          value={config.model || ""}
          onChange={(e) => update({ model: e.target.value || undefined })}
          placeholder={
            config.provider === "openai"
              ? "gpt-4o"
              : "claude-3-5-sonnet-20241022"
          }
          className="w-full bg-[#2d2d2d] border border-gray-600 rounded px-2 py-1.5 text-xs text-gray-200"
        />
      </div>

      <button
        onClick={() => {
          saveConfig(config);
          setSaved(true);
          setTimeout(() => setSaved(false), 2000);
        }}
        className="w-full py-1.5 text-xs bg-blue-600 hover:bg-blue-700 rounded text-white"
      >
        {saved ? "Saved!" : "Save Settings"}
      </button>

      <p className="text-[10px] text-gray-500">
        Keys are stored in localStorage and never leave this webview.
      </p>
    </div>
  );
}
