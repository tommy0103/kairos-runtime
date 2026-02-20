import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@mariozechner/pi-ai";
import { resolveSafePath, SAFE_TOOLS_ROOT } from "./pathSafety";

const DEFAULT_MAX_RESULTS = 200;
const MAX_ALLOWED_RESULTS = 1000;

interface ListFilesSafeDetails {
  path: string;
  absolutePath: string;
  count: number;
}

export function createListFilesSafeTool(): AgentTool<any, ListFilesSafeDetails> {
  return {
    name: "list_files_safe",
    label: "List safe files",
    description: `List files/directories only under ${SAFE_TOOLS_ROOT}.`,
    parameters: Type.Object({
      path: Type.Optional(
        Type.String({
          description: "Relative directory path under src/agent/memory_files. Default current root.",
        })
      ),
      recursive: Type.Optional(
        Type.Boolean({
          description: "Whether to list recursively. Default false.",
        })
      ),
      contains: Type.Optional(
        Type.String({
          description: "Optional substring filter on relative path.",
        })
      ),
      maxResults: Type.Optional(
        Type.Number({
          description: "Maximum entries. Default 200, max 1000.",
        })
      ),
    }),
    execute: async (_toolCallId, params) => {
      const rootRelativePath = params.path ?? ".";
      const absolutePath = resolveSafePath(rootRelativePath);
      const recursive = params.recursive ?? false;
      const contains = params.contains?.trim().toLowerCase();
      const maxResults = Math.min(
        Math.max(Math.floor(params.maxResults ?? DEFAULT_MAX_RESULTS), 1),
        MAX_ALLOWED_RESULTS
      );

      const results: string[] = [];
      const queue: string[] = [absolutePath];
      while (queue.length > 0 && results.length < maxResults) {
        const currentDir = queue.shift();
        if (!currentDir) {
          continue;
        }
        const entries = await readdir(currentDir, { withFileTypes: true });
        for (const entry of entries) {
          const entryPath = resolveSafePath(relative(SAFE_TOOLS_ROOT, join(currentDir, entry.name)));
          const rel = relative(SAFE_TOOLS_ROOT, entryPath) || ".";
          const rendered = entry.isDirectory() ? `${rel}/` : rel;
          if (!contains || rendered.toLowerCase().includes(contains)) {
            results.push(rendered);
            if (results.length >= maxResults) {
              break;
            }
          }
          if (recursive && entry.isDirectory()) {
            queue.push(entryPath);
          }
        }
      }

      return {
        content: [{ type: "text", text: results.join("\n") || "(empty)" }],
        details: {
          path: rootRelativePath,
          absolutePath,
          count: results.length,
        },
      };
    },
  };
}
