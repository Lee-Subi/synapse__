/* eslint-disable @typescript-eslint/no-explicit-any */

interface VsCodeApi {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

let _api: VsCodeApi | null = null;

export function getVsCodeApi(): VsCodeApi {
  if (!_api) {
    _api = acquireVsCodeApi();
  }
  return _api;
}

// ─── Pending bridge requests (30s timeout) ────────────────────
const pendingReqs = new Map<
  string,
  { resolve: (v: any) => void; reject: (e: Error) => void }
>();

function genId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function sendAndWait<T>(type: string, payload?: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = genId();
    const timer = setTimeout(() => {
      pendingReqs.delete(id);
      reject(new Error(`Bridge timeout for ${type} (id: ${id})`));
    }, 30_000);

    pendingReqs.set(id, {
      resolve: (v: T) => {
        clearTimeout(timer);
        pendingReqs.delete(id);
        resolve(v);
      },
      reject: (e: Error) => {
        clearTimeout(timer);
        pendingReqs.delete(id);
        reject(e);
      },
    });

    getVsCodeApi().postMessage({ type, id, payload });
  });
}

// Listen for extension → webview messages
window.addEventListener("message", (event: MessageEvent) => {
  const msg = event.data;
  if (!msg || !msg.type) return;

  // Handle bridge responses with IDs
  if (msg.id && pendingReqs.has(msg.id)) {
    const entry = pendingReqs.get(msg.id)!;
    if (msg.type.includes("ERROR")) {
      entry.reject(new Error(JSON.stringify(msg.payload)));
    } else {
      entry.resolve(msg.payload);
    }
    return;
  }

  // Dispatch non-ID messages to listeners
  for (const cb of listeners) {
    cb(msg);
  }
});

type Listener = (msg: any) => void;
const listeners: Listener[] = [];

export function onMessage(cb: Listener): () => void {
  listeners.push(cb);
  return () => {
    const idx = listeners.indexOf(cb);
    if (idx >= 0) listeners.splice(idx, 1);
  };
}

// ─── High-level helpers ───────────────────────────────────────
export function postMessage(type: string, payload?: unknown) {
  getVsCodeApi().postMessage({ type, payload });
}

export function loadDb(): void {
  postMessage("LOAD_DB");
}

export function saveDb(nodes: unknown[], edges: unknown[]): void {
  postMessage("SAVE_DB", { nodes, edges });
}

export function requestFileRead(path: string): Promise<{ path: string; content: string }> {
  return sendAndWait("REQUEST_FILE_READ", { path });
}

export function requestFileWrite(
  path: string,
  content: string
): Promise<{ path: string }> {
  return sendAndWait("REQUEST_FILE_WRITE", { path, content });
}

export function requestTerminalCommand(
  command: string,
  cwd?: string
): Promise<{ output: string }> {
  return sendAndWait("REQUEST_TERMINAL_COMMAND", { command, cwd });
}

export function requestFileSearch(
  pattern: string,
  directory?: string
): Promise<{ files: string[] }> {
  return sendAndWait("REQUEST_FILE_SEARCH", { pattern, directory });
}

export function getWorkspaceRoot(): void {
  postMessage("GET_WORKSPACE_ROOT");
}

export function openFile(path: string): void {
  postMessage("OPEN_FILE", { path });
}

export function highlightFiles(paths: string[]): void {
  postMessage("HIGHLIGHT_FILES", { paths });
}

export function showError(message: string): void {
  postMessage("SHOW_ERROR", { message });
}

export function showInfo(message: string): void {
  postMessage("SHOW_INFO", { message });
}

export interface AggregateRepoPayload {
  targetRelative: string;
  copies: Array<{ src: string; destRelative: string }>;
}

export interface AggregateRepoResult {
  root: string;
  copied: number;
  skipped: Array<{ src: string; reason: string }>;
  manifestPath: string;
}

export function requestAggregateRepo(
  payload: AggregateRepoPayload
): Promise<AggregateRepoResult> {
  return sendAndWait("REQUEST_AGGREGATE_REPO", payload);
}

export type RunProductLaunch =
  | { cwd: string; script: string }
  | { error: string };

export interface CollectAndRunResult extends AggregateRepoResult {
  run: RunProductLaunch;
  /** Paths merged into src/utils from agent name_N.ts files */
  merge?: string[];
}

export function requestCollectAndRun(
  payload: AggregateRepoPayload
): Promise<CollectAndRunResult> {
  return sendAndWait("REQUEST_COLLECT_AND_RUN", payload);
}

export interface RunProductResult {
  root: string;
  run: RunProductLaunch;
}

export function requestRunProduct(targetRelative: string): Promise<RunProductResult> {
  return sendAndWait("REQUEST_RUN_PRODUCT", { targetRelative });
}
