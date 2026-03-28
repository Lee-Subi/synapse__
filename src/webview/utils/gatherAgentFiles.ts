import { ContextNode } from "../types";
import { discoverFilePaths } from "./llmClient";

function slugPart(label: string): string {
  return label
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 40) || "node";
}

function basename(p: string): string {
  const norm = p.replace(/\\/g, "/");
  const parts = norm.split("/");
  return parts[parts.length - 1] || p;
}

/** Paths from spec linked_files plus paths mentioned in chat (heuristic). */
export function collectPathsForNode(node: ContextNode): string[] {
  const set = new Set<string>();
  for (const p of node.data.metadata.linked_files) {
    if (p && typeof p === "string") set.add(p.trim());
  }
  for (const p of discoverFilePaths(node.data.chatHistory)) {
    if (p) set.add(p);
  }
  return Array.from(set);
}

/**
 * One folder per agent node under the target root; preserves files per node.
 */
export function buildAggregateCopyList(
  nodes: ContextNode[]
): Array<{ src: string; destRelative: string }> {
  const out: Array<{ src: string; destRelative: string }> = [];
  for (const n of nodes) {
    const slug = `${slugPart(n.data.label)}__${n.id.slice(0, 8)}`;
    const usedNames = new Set<string>();
    for (const src of collectPathsForNode(n)) {
      if (!src) continue;
      let base = basename(src);
      if (!base) base = "file";
      let destBase = base;
      let i = 0;
      while (usedNames.has(destBase)) {
        i += 1;
        const dot = base.lastIndexOf(".");
        if (dot > 0) {
          destBase = `${base.slice(0, dot)}_${i}${base.slice(dot)}`;
        } else {
          destBase = `${base}_${i}`;
        }
      }
      usedNames.add(destBase);
      out.push({ src, destRelative: `${slug}/${destBase}` });
    }
  }
  return out;
}
