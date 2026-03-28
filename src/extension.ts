import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

type AggregateCopy = { src: string; destRelative: string };

type AggregateResult = {
  root: string;
  copied: number;
  skipped: Array<{ src: string; reason: string }>;
  manifestPath: string;
};

function aggregateAgentFiles(
  ws: string,
  targetRelative: string,
  copies: AggregateCopy[]
): AggregateResult {
  const root = path.join(ws, targetRelative);
  const skipped: Array<{ src: string; reason: string }> = [];
  let copied = 0;
  fs.mkdirSync(root, { recursive: true });
  for (const { src, destRelative } of copies) {
    if (!fs.existsSync(src)) {
      skipped.push({ src, reason: "source missing" });
      continue;
    }
    const stat = fs.statSync(src);
    if (!stat.isFile()) {
      skipped.push({ src, reason: "not a regular file" });
      continue;
    }
    const dest = path.join(root, destRelative);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    copied += 1;
  }
  const manifestPath = path.join(root, "MANIFEST.md");
  const lines = [
    "# Consolidated agent outputs",
    "",
    `Workspace: \`${ws}\``,
    `Target: \`${targetRelative}\``,
    `Generated: ${new Date().toISOString()}`,
    "",
    "| Source | Destination | Status |",
    "|--------|-------------|--------|",
  ];
  for (const { src, destRelative } of copies) {
    const dest = path.join(root, destRelative);
    const ok = fs.existsSync(dest);
    lines.push(
      `| \`${src}\` | \`${destRelative}\` | ${ok ? "copied" : "skipped"} |`
    );
  }
  if (skipped.length > 0) {
    lines.push("", "## Skip reasons", "");
    for (const s of skipped) {
      lines.push(`- \`${s.src}\`: ${s.reason}`);
    }
  }
  lines.push(
    "",
    "To commit this folder:",
    "```bash",
    `cd "${root}"`,
    "git status",
    "git add .",
    'git commit -m "Consolidate agent outputs"',
    "```"
  );
  fs.writeFileSync(manifestPath, lines.join("\n"), "utf-8");
  try {
    const { execSync } = require("child_process");
    execSync("git init", { cwd: root, encoding: "utf-8", timeout: 10000 });
  } catch {
    // git unavailable
  }
  return { root, copied, skipped, manifestPath };
}

/** First directory under startDir whose package.json parses (skips node_modules). */
function findPackageJsonDir(startDir: string, depth: number): string | null {
  if (depth > 10) return null;
  const pkgPath = path.join(startDir, "package.json");
  if (fs.existsSync(pkgPath)) {
    try {
      JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      return startDir;
    } catch {
      /* invalid json */
    }
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(startDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const dirs = entries
    .filter(
      (e) =>
        e.isDirectory() &&
        e.name !== "node_modules" &&
        !e.name.startsWith(".")
    )
    .map((e) => e.name)
    .sort();
  for (const name of dirs) {
    const found = findPackageJsonDir(path.join(startDir, name), depth + 1);
    if (found) return found;
  }
  return null;
}

/** Prefer dev-server style scripts; then any non-test/lint-only script. */
function pickNpmScript(pkg: { scripts?: Record<string, string> }): string | null {
  const s = pkg.scripts || {};
  const preferred = [
    "dev",
    "start",
    "serve",
    "preview",
    "start:dev",
    "dev:server",
    "develop",
    "watch",
    "server",
    "web",
    "app",
    "start:app",
    "vite",
    "next",
    "next:dev",
    "react-start",
  ];
  for (const name of preferred) {
    if (s[name]) return name;
  }
  const avoid = new Set([
    "test",
    "lint",
    "eslint",
    "format",
    "prettier",
    "typecheck",
    "tsc",
    "build",
    "ci",
    "postinstall",
    "prepublishOnly",
    "prepare",
  ]);
  for (const name of Object.keys(s).sort()) {
    if (avoid.has(name)) continue;
    if (/^(test|lint|format|typecheck|check|pre|post)/i.test(name)) continue;
    return name;
  }
  return null;
}

function describeScripts(pkg: { scripts?: Record<string, string> }): string {
  const keys = Object.keys(pkg.scripts || {});
  if (keys.length === 0) return "No scripts are defined.";
  return `Your scripts: ${keys.map((k) => `"${k}"`).join(", ")}.`;
}

type RunProductResult =
  | { cwd: string; script: string }
  | { error: string };

let synapseOutput: vscode.OutputChannel | null = null;

function getSynapseOutput(): vscode.OutputChannel {
  if (!synapseOutput) {
    synapseOutput = vscode.window.createOutputChannel("Synapse");
  }
  return synapseOutput;
}

function synapseLog(title: string, body: string, reveal = true) {
  const ch = getSynapseOutput();
  ch.appendLine(`\n=== ${title} (${new Date().toISOString()}) ===\n${body}\n`);
  if (reveal) {
    ch.show(true);
  }
}

/**
 * Copy agent files named like `budgetCalc_1.ts` into `src/utils/budgetCalc.ts`
 * so the main app compiles against one canonical module set.
 */
function mergeConsolidatedIntoSrc(
  workspaceRoot: string,
  consolidatedRelative: string
): { merged: string[]; note: string } {
  const consolidatedRoot = path.join(workspaceRoot, consolidatedRelative);
  const utilsDir = path.join(workspaceRoot, "src", "utils");
  if (!fs.existsSync(consolidatedRoot)) {
    return { merged: [], note: "Consolidated folder missing — nothing merged." };
  }
  if (!fs.existsSync(utilsDir)) {
    fs.mkdirSync(utilsDir, { recursive: true });
  }
  const merged: string[] = [];
  function walk(dir: string) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === "node_modules") continue;
        walk(full);
      } else if (/\.tsx?$/.test(ent.name) && !ent.name.endsWith(".d.ts")) {
        const m = /^(.+)_(\d+)\.(ts|tsx)$/.exec(ent.name);
        if (m) {
          const destBase = `${m[1]}.${m[3]}`;
          const dest = path.join(utilsDir, destBase);
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.copyFileSync(full, dest);
          merged.push(dest);
        }
      }
    }
  }
  walk(consolidatedRoot);
  const note =
    merged.length > 0
      ? `Merged ${merged.length} file(s) from agent outputs into src/utils (pattern: name_N.ts → name.ts).`
      : "No files matched name_N.ts / name_N.tsx under consolidated — skipped merge.";
  return { merged, note };
}

/** If package.json has no scripts but tsconfig exists, add minimal tsc scripts. */
function readPackageJsonScripts(
  dir: string
): { scripts?: Record<string, string> } | null {
  const pkgPath = path.join(dir, "package.json");
  if (!fs.existsSync(pkgPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
  } catch {
    return null;
  }
}

function ensurePackageJsonScriptsForTs(workspaceRoot: string): boolean {
  const pkgPath = path.join(workspaceRoot, "package.json");
  const tsconfigPath = path.join(workspaceRoot, "tsconfig.json");
  if (!fs.existsSync(pkgPath) || !fs.existsSync(tsconfigPath)) return false;
  let pkg: { scripts?: Record<string, string> };
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
  } catch {
    return false;
  }
  const scripts = pkg.scripts || {};
  if (Object.keys(scripts).length > 0) return false;
  pkg.scripts = {
    build: "tsc",
    dev: "tsc --watch",
  };
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf-8");
  synapseLog(
    "package.json",
    'Added minimal scripts: "build": "tsc", "dev": "tsc --watch" (scripts were empty; tsconfig.json present).',
    false
  );
  return true;
}

function runNpmInstall(workspaceRoot: string): { ok: boolean; log: string } {
  try {
    const { execSync } = require("child_process");
    const out = execSync("npm install", {
      cwd: workspaceRoot,
      encoding: "utf-8",
      timeout: 600000,
      maxBuffer: 50 * 1024 * 1024,
    });
    return { ok: true, log: String(out).slice(-8000) };
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    return {
      ok: false,
      log: `${err.stderr || ""}\n${err.stdout || ""}\n${err.message || String(e)}`,
    };
  }
}

function runBuildOrTypecheck(workspaceRoot: string): { ok: boolean; log: string } {
  const pkg = readPackageJsonScripts(workspaceRoot);
  const { execSync } = require("child_process");
  const opts = {
    cwd: workspaceRoot,
    encoding: "utf-8" as const,
    timeout: 300000,
    maxBuffer: 20 * 1024 * 1024,
  };
  try {
    if (pkg?.scripts?.build) {
      execSync("npm run build", opts);
      return { ok: true, log: "npm run build OK" };
    }
    if (fs.existsSync(path.join(workspaceRoot, "tsconfig.json"))) {
      execSync("npx --yes tsc --noEmit", opts);
      return { ok: true, log: "npx tsc --noEmit OK" };
    }
    return {
      ok: true,
      log: "No build script and no tsconfig.json — skipped typecheck.",
    };
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    return {
      ok: false,
      log: `${err.stderr || ""}\n${err.stdout || ""}\n${err.message || String(e)}`,
    };
  }
}

function launchTerminalNpm(
  projectRoot: string,
  script: string,
  opts?: { skipInstall?: boolean }
): RunProductResult {
  const term = vscode.window.createTerminal({
    cwd: projectRoot,
    name: "Synapse: product",
  });
  term.show(true);
  const line = opts?.skipInstall
    ? `npm run ${script}`
    : `npm install && npm run ${script}`;
  term.sendText(line, true);
  return { cwd: projectRoot, script };
}

/**
 * Prefer the opened workspace folder (full repo: src/, tests/, root package.json).
 * If that has no runnable script, fall back to agent-output/consolidated subtree.
 */
function launchNpmProduct(
  workspaceRoot: string,
  consolidatedRelative: string,
  opts?: { skipInstall?: boolean }
): RunProductResult {
  const rootPkg = readPackageJsonScripts(workspaceRoot);
  if (rootPkg) {
    const script = pickNpmScript(rootPkg);
    if (script && rootPkg.scripts?.[script]) {
      return launchTerminalNpm(workspaceRoot, script, opts);
    }
  }

  const consolidatedRoot = path.join(workspaceRoot, consolidatedRelative);
  let consolidatedPkgDir: string | null = null;
  let consolidatedPkg: { scripts?: Record<string, string> } | null = null;
  if (fs.existsSync(consolidatedRoot)) {
    const nested = findPackageJsonDir(consolidatedRoot, 0);
    if (nested) {
      const pkg = readPackageJsonScripts(nested);
      if (pkg) {
        consolidatedPkgDir = nested;
        consolidatedPkg = pkg;
        const script = pickNpmScript(pkg);
        if (script && pkg.scripts?.[script]) {
          return launchTerminalNpm(nested, script, opts);
        }
      }
    }
  }

  if (rootPkg && consolidatedPkg && consolidatedPkgDir) {
    return {
      error: `No runnable npm script in workspace or consolidated. Workspace: ${describeScripts(rootPkg)} Consolidated (${consolidatedPkgDir}): ${describeScripts(consolidatedPkg)} Add e.g. "dev" or "start" to one of these package.json files.`,
    };
  }
  if (rootPkg) {
    return {
      error: `Could not pick a run script from workspace package.json. ${describeScripts(rootPkg)} Add e.g. "dev": "vite" or "start": "node dist/index.js".`,
    };
  }
  if (consolidatedPkg && consolidatedPkgDir) {
    return {
      error: `Could not pick a run script under agent-output/consolidated. ${describeScripts(consolidatedPkg)} Add a workspace root package.json with your main app, or add dev/start to consolidated.`,
    };
  }

  return {
    error:
      "No package.json at the workspace root, and no runnable Node project under agent-output/consolidated. Open the repo folder that contains your main package.json.",
  };
}

export function activate(context: vscode.ExtensionContext) {
  const cmd = vscode.commands.registerCommand("synapse.openContextTree", () => {
    const panel = vscode.window.createWebviewPanel(
      "contextTree",
      "Context Tree",
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(context.extensionUri, "dist", "webview"),
        ],
      }
    );

    const scriptUri = panel.webview.asWebviewUri(
      vscode.Uri.joinPath(context.extensionUri, "dist", "webview", "webview.js")
    );

    panel.webview.html = getWebviewHtml(
      scriptUri.toString(),
      panel.webview.cspSource
    );

    const getDbPath = (): string => {
      const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (ws) return path.join(ws, "context-tree-db.json");
      return path.join(context.globalStorageUri.fsPath, "context-tree-db.json");
    };

    panel.webview.onDidReceiveMessage(
      async (msg: { type: string; payload?: unknown; id?: string }) => {
        switch (msg.type) {
          case "LOAD_DB": {
            const dbPath = getDbPath();
            try {
              const raw = fs.readFileSync(dbPath, "utf-8");
              const data = JSON.parse(raw);
              panel.webview.postMessage({ type: "DB_LOADED", payload: data });
            } catch {
              panel.webview.postMessage({
                type: "DB_LOADED",
                payload: { nodes: [], edges: [] },
              });
            }
            break;
          }

          case "SAVE_DB": {
            const dbPath = getDbPath();
            const dir = path.dirname(dbPath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(dbPath, JSON.stringify(msg.payload, null, 2), "utf-8");
            break;
          }

          case "REQUEST_FILE_READ": {
            const p = (msg.payload as { path: string }).path;
            try {
              const content = fs.readFileSync(p, "utf-8");
              panel.webview.postMessage({
                type: "FILE_READ_SUCCESS",
                id: msg.id,
                payload: { path: p, content },
              });
            } catch (err: unknown) {
              panel.webview.postMessage({
                type: "FILE_READ_ERROR",
                id: msg.id,
                payload: { path: p, error: String(err) },
              });
            }
            break;
          }

          case "REQUEST_FILE_WRITE": {
            const { path: filePath, content } = msg.payload as {
              path: string;
              content: string;
            };
            try {
              const dir = path.dirname(filePath);
              if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
              fs.writeFileSync(filePath, content, "utf-8");
              // Auto-open written file in editor
              const doc = await vscode.workspace.openTextDocument(
                vscode.Uri.file(filePath)
              );
              await vscode.window.showTextDocument(doc, {
                preview: false,
                preserveFocus: true,
              });
              panel.webview.postMessage({
                type: "FILE_WRITE_SUCCESS",
                id: msg.id,
                payload: { path: filePath },
              });
            } catch (err: unknown) {
              panel.webview.postMessage({
                type: "FILE_WRITE_ERROR",
                id: msg.id,
                payload: { path: filePath, error: String(err) },
              });
            }
            break;
          }

          case "OPEN_FILE": {
            const filePath = (msg.payload as { path: string }).path;
            try {
              const doc = await vscode.workspace.openTextDocument(
                vscode.Uri.file(filePath)
              );
              await vscode.window.showTextDocument(doc);
            } catch {
              vscode.window.showErrorMessage(`Cannot open file: ${filePath}`);
            }
            break;
          }

          case "HIGHLIGHT_FILES": {
            const files = (msg.payload as { paths: string[] }).paths;
            for (const f of files) {
              try {
                await vscode.commands.executeCommand(
                  "revealInExplorer",
                  vscode.Uri.file(f)
                );
                break; // reveal first valid
              } catch {
                // skip invalid
              }
            }
            break;
          }

          case "GET_WORKSPACE_ROOT": {
            const root =
              vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
            panel.webview.postMessage({
              type: "WORKSPACE_ROOT",
              payload: root,
            });
            break;
          }

          case "GENERATE_UUID": {
            const id = crypto.randomUUID();
            panel.webview.postMessage({
              type: "UUID_GENERATED",
              id: msg.id,
              payload: id,
            });
            break;
          }

          case "SHOW_ERROR": {
            vscode.window.showErrorMessage(
              String((msg.payload as { message: string }).message)
            );
            break;
          }

          case "SHOW_INFO": {
            vscode.window.showInformationMessage(
              String((msg.payload as { message: string }).message)
            );
            break;
          }

          case "REQUEST_TERMINAL_COMMAND": {
            const { command, cwd } = msg.payload as {
              command: string;
              cwd?: string;
            };
            try {
              const { execSync } = require("child_process");
              const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
              const execCwd = cwd || ws || process.cwd();
              const output = execSync(command, {
                cwd: execCwd,
                encoding: "utf-8",
                timeout: 30000,
                maxBuffer: 1024 * 1024,
              });
              panel.webview.postMessage({
                type: "TERMINAL_COMMAND_SUCCESS",
                id: msg.id,
                payload: { output },
              });
            } catch (err: unknown) {
              const e = err as { stdout?: string; stderr?: string };
              panel.webview.postMessage({
                type: "TERMINAL_COMMAND_ERROR",
                id: msg.id,
                payload: {
                  error: String(err),
                  stdout: e.stdout || "",
                  stderr: e.stderr || "",
                },
              });
            }
            break;
          }

          case "REQUEST_AGGREGATE_REPO": {
            const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!ws) {
              panel.webview.postMessage({
                type: "AGGREGATE_REPO_ERROR",
                id: msg.id,
                payload: { error: "No workspace folder open." },
              });
              break;
            }
            const { targetRelative, copies } = msg.payload as {
              targetRelative: string;
              copies: AggregateCopy[];
            };
            try {
              const result = aggregateAgentFiles(ws, targetRelative, copies);
              panel.webview.postMessage({
                type: "AGGREGATE_REPO_SUCCESS",
                id: msg.id,
                payload: result,
              });
            } catch (err: unknown) {
              panel.webview.postMessage({
                type: "AGGREGATE_REPO_ERROR",
                id: msg.id,
                payload: { error: String(err) },
              });
            }
            break;
          }

          case "REQUEST_COLLECT_AND_RUN": {
            const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!ws) {
              panel.webview.postMessage({
                type: "COLLECT_AND_RUN_ERROR",
                id: msg.id,
                payload: { error: "No workspace folder open." },
              });
              break;
            }
            const { targetRelative, copies } = msg.payload as {
              targetRelative: string;
              copies: AggregateCopy[];
            };
            try {
              const result = aggregateAgentFiles(ws, targetRelative, copies);
              const merge = mergeConsolidatedIntoSrc(ws, targetRelative);
              synapseLog("Merge agent outputs → src/utils", merge.note);

              ensurePackageJsonScriptsForTs(ws);

              const install = runNpmInstall(ws);
              if (!install.ok) {
                synapseLog("npm install failed", install.log);
                panel.webview.postMessage({
                  type: "COLLECT_AND_RUN_SUCCESS",
                  id: msg.id,
                  payload: {
                    ...result,
                    merge: merge.merged,
                    run: {
                      error:
                        "npm install failed. Open the Output panel → channel “Synapse”.",
                    },
                  },
                });
                vscode.window.showErrorMessage(
                  "Collect & run: npm install failed — see Synapse output."
                );
                break;
              }
              synapseLog("npm install (tail)", install.log.slice(-6000));

              const build = runBuildOrTypecheck(ws);
              if (!build.ok) {
                synapseLog("Build / typecheck failed", build.log);
                panel.webview.postMessage({
                  type: "COLLECT_AND_RUN_SUCCESS",
                  id: msg.id,
                  payload: {
                    ...result,
                    merge: merge.merged,
                    run: {
                      error:
                        "Build or typecheck failed. Fix project errors, then use ▶ Run product. See Synapse output.",
                    },
                  },
                });
                vscode.window.showErrorMessage(
                  "Build/typecheck failed — see Synapse output."
                );
                break;
              }
              synapseLog("Build / typecheck", build.log);

              const run = launchNpmProduct(ws, targetRelative, {
                skipInstall: true,
              });
              panel.webview.postMessage({
                type: "COLLECT_AND_RUN_SUCCESS",
                id: msg.id,
                payload: { ...result, merge: merge.merged, run },
              });
              if ("error" in run) {
                vscode.window.showWarningMessage(
                  `Consolidated ${result.copied} file(s); build OK but run failed: ${run.error}`
                );
              } else {
                vscode.window.showInformationMessage(
                  `npm run ${run.script} started in ${run.cwd} (install + build already done).`
                );
              }
            } catch (err: unknown) {
              panel.webview.postMessage({
                type: "COLLECT_AND_RUN_ERROR",
                id: msg.id,
                payload: { error: String(err) },
              });
            }
            break;
          }

          case "REQUEST_RUN_PRODUCT": {
            const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!ws) {
              panel.webview.postMessage({
                type: "RUN_PRODUCT_ERROR",
                id: msg.id,
                payload: { error: "No workspace folder open." },
              });
              break;
            }
            const { targetRelative } = msg.payload as { targetRelative: string };
            try {
              ensurePackageJsonScriptsForTs(ws);

              const install = runNpmInstall(ws);
              if (!install.ok) {
                synapseLog("npm install failed", install.log);
                panel.webview.postMessage({
                  type: "RUN_PRODUCT_ERROR",
                  id: msg.id,
                  payload: {
                    error:
                      "npm install failed. See Synapse output channel.",
                  },
                });
                vscode.window.showErrorMessage(
                  "npm install failed — see Synapse output."
                );
                break;
              }

              const build = runBuildOrTypecheck(ws);
              if (!build.ok) {
                synapseLog("Build / typecheck failed", build.log);
                panel.webview.postMessage({
                  type: "RUN_PRODUCT_ERROR",
                  id: msg.id,
                  payload: {
                    error:
                      "Build/typecheck failed. See Synapse output.",
                  },
                });
                vscode.window.showErrorMessage(
                  "Build failed — see Synapse output."
                );
                break;
              }

              const run = launchNpmProduct(ws, targetRelative, {
                skipInstall: true,
              });
              const root = "error" in run ? ws : run.cwd;
              panel.webview.postMessage({
                type: "RUN_PRODUCT_SUCCESS",
                id: msg.id,
                payload: { root, run },
              });
              if ("error" in run) {
                vscode.window.showErrorMessage(run.error);
              } else {
                vscode.window.showInformationMessage(
                  `npm run ${run.script} → ${run.cwd}`
                );
              }
            } catch (err: unknown) {
              panel.webview.postMessage({
                type: "RUN_PRODUCT_ERROR",
                id: msg.id,
                payload: { error: String(err) },
              });
            }
            break;
          }

          case "REQUEST_FILE_SEARCH": {
            const { pattern, directory } = msg.payload as {
              pattern: string;
              directory?: string;
            };
            try {
              const { execSync } = require("child_process");
              const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
              const searchDir = directory || ws || process.cwd();
              const output = execSync(
                `grep -r -l --include="*" "${pattern.replace(/"/g, '\\"')}" "${searchDir}" 2>/dev/null || true`,
                { encoding: "utf-8", timeout: 15000, maxBuffer: 1024 * 1024 }
              );
              panel.webview.postMessage({
                type: "FILE_SEARCH_SUCCESS",
                id: msg.id,
                payload: { files: output.trim().split("\n").filter(Boolean) },
              });
            } catch (err: unknown) {
              panel.webview.postMessage({
                type: "FILE_SEARCH_ERROR",
                id: msg.id,
                payload: { error: String(err) },
              });
            }
            break;
          }
        }
      },
      undefined,
      context.subscriptions
    );
  });

  context.subscriptions.push(cmd);
}

export function deactivate() {
  synapseOutput?.dispose();
  synapseOutput = null;
}

function getWebviewHtml(scriptUri: string, cspSource: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none';
             script-src 'unsafe-eval' ${cspSource};
             style-src 'unsafe-inline' ${cspSource};
             font-src ${cspSource};
             connect-src https:;
             img-src ${cspSource} https: data:;" />
  <title>Context Tree</title>
</head>
<body>
  <div id="root"></div>
  <script src="${scriptUri}"></script>
</body>
</html>`;
}
