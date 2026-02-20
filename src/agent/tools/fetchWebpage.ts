import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@mariozechner/pi-ai";

interface FetchWebpageToolDetails {
  sourceUrl: string;
}

function toJinaUrl(rawUrl: string): string {
  const normalized = rawUrl.trim();
  const parsed = new URL(normalized);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only http/https URLs are supported.");
  }
  const withoutProtocol = normalized.replace(/^https?:\/\//i, "");
  return `https://r.jina.ai/${withoutProtocol}`;
}

export function createFetchWebpageTool(): AgentTool<any, FetchWebpageToolDetails> {
  return {
    name: "fetch_webpage",
    label: "Fetch webpage",
    description:
      "Fetch webpage content through r.jina.ai by passing a normal URL.",
    parameters: Type.Object({
      url: Type.String({
        description: "Target webpage URL, e.g. https://example.com/page",
      }),
    }),
    execute: async (_toolCallId, params, signal) => {
      const jinaUrl = toJinaUrl(params.url);
      const response = await fetch(jinaUrl, { signal });
      if (!response.ok) {
        throw new Error(
          `Failed to fetch webpage via r.jina.ai: ${response.status} ${response.statusText}`
        );
      }
      const text = await response.text();
      return {
        content: [{ type: "text", text }],
        details: {
          sourceUrl: params.url,
        },
      };
    },
  };
}
