import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@mariozechner/pi-ai";

const ALLOWED_ROOT = `${process.env.HOME ?? "/home/tomiya"}/memoh-lite`;
const MAX_FILE_BYTES = 200_000;

interface ReadFileSafeDetails {
  requestedPath: string;
  resolvedPath: string;
  byteLength: number;
}

function resolveInsideAllowedRoot(inputPath: string): string {
  const resolved = path.resolve(ALLOWED_ROOT, inputPath);
  const relative = path.relative(ALLOWED_ROOT, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Path is outside allowed root.");
  }
  return resolved;
}

export function createReadFileSafeTool(): AgentTool<any, ReadFileSafeDetails> {
  return {
    name: "read_file_safe",
    label: "Read file safely",
    description:
      "Read a UTF-8 text file under project root with file-size and path safety checks.",
    parameters: Type.Object({
      path: Type.String({
        description: "File path relative to project root (memoh-lite).",
      }),
    }),
    execute: async (_toolCallId, params) => {
      const resolvedPath = resolveInsideAllowedRoot(params.path);
      const fileStat = await stat(resolvedPath);
      if (!fileStat.isFile()) {
        throw new Error("Target path is not a file.");
      }
      if (fileStat.size > MAX_FILE_BYTES) {
        throw new Error(
          `File is too large (${fileStat.size} bytes). Limit is ${MAX_FILE_BYTES} bytes.`
        );
      }
      const text = await readFile(resolvedPath, "utf8");
      return {
        content: [{ type: "text", text }],
        details: {
          requestedPath: params.path,
          resolvedPath,
          byteLength: Buffer.byteLength(text, "utf8"),
        },
      };
    },
  };
}
