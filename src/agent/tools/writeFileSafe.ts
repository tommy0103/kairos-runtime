import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@mariozechner/pi-ai";
import { resolveSafePath, SAFE_TOOLS_ROOT } from "./pathSafety";

const MAX_CONTENT_CHARS = 200_000;

interface WriteFileSafeDetails {
  path: string;
  absolutePath: string;
  mode: "overwrite" | "append";
  chars: number;
}

export function createWriteFileSafeTool(): AgentTool<any, WriteFileSafeDetails> {
  return {
    name: "write_file_safe",
    label: "Write safe file",
    description: `Write UTF-8 content only under ${SAFE_TOOLS_ROOT}.`,
    parameters: Type.Object({
      path: Type.String({
        description: "Relative file path under src/agent/tools.",
      }),
      content: Type.String({
        description: "UTF-8 content to write.",
      }),
      mode: Type.Optional(
        Type.Union([Type.Literal("overwrite"), Type.Literal("append")], {
          description: "Write mode: overwrite (default) or append.",
        })
      ),
    }),
    execute: async (_toolCallId, params) => {
      if (params.content.length > MAX_CONTENT_CHARS) {
        throw new Error(`Content too large. Max characters: ${MAX_CONTENT_CHARS}.`);
      }
      const absolutePath = resolveSafePath(params.path);
      const mode: "overwrite" | "append" = params.mode ?? "overwrite";
      await mkdir(dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, params.content, {
        encoding: "utf8",
        flag: mode === "append" ? "a" : "w",
      });
      return {
        content: [{ type: "text", text: `Wrote ${params.content.length} chars.` }],
        details: {
          path: params.path,
          absolutePath,
          mode,
          chars: params.content.length,
        },
      };
    },
  };
}
