import {
  agentLoop,
  type AgentContext,
  type AgentMessage,
  type AgentTool,
} from "@mariozechner/pi-agent-core";
import type { Message, Model } from "@mariozechner/pi-ai";
import { consumePendingEvolutedTool } from "../tools/evolute";

export interface AgentLoopMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface AgentLoopGenerateOptions {
  model?: string;
  temperature?: number;
  imageUrls?: string[];
}

export interface AgentLoopRunner {
  streamEvents: (
    messages: AgentLoopMessage[],
    options?: AgentLoopGenerateOptions
  ) => AsyncGenerator<AgentLoopStreamEvent, void, unknown>;
  streamText: (
    messages: AgentLoopMessage[],
    options?: AgentLoopGenerateOptions
  ) => AsyncGenerator<string, void, unknown>;
  applyToolsToActiveLoops: () => void;
}

export type AgentLoopStreamEvent =
  | {
      type: "message_update";
      role: "assistant";
      delta: string;
    }
  | {
      type: "tool_execution_start";
      toolName: string;
      toolCallId?: string;
    }
  | {
      type: "tool_execution_end";
      toolName: string;
      toolCallId?: string;
      result?: unknown;
    }
  | {
      type: "completed";
    }
  | {
      type: "failed";
      error: string;
    };

export interface CreateAgentLoopRunnerOptions {
  apiKey: string;
  baseURL: string;
  defaultModel: string;
  getCurrentTools: () => AgentTool<any>[];
  registerDynamicTool: (tool: AgentTool<any>) => Promise<void>;
  unregisterTool: (name: string) => Promise<boolean>;
}

const DEFAULT_PROVIDER = "openai";
const FORCE_UA = process.env.OPENAI_FORCE_USER_AGENT?.trim();

function createCompatibleModel(modelId: string, baseURL: string): Model<"openai-completions"> {
  return {
    id: modelId,
    name: modelId,
    api: "openai-completions",
    provider: DEFAULT_PROVIDER,
    baseUrl: baseURL,
    reasoning: false,
    input: ["text", "image"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 128000,
    maxTokens: 4096,
    headers: FORCE_UA ? { "User-Agent": FORCE_UA } : undefined,
  };
}

function extractSystemPrompt(messages: AgentLoopMessage[]): string {
  return messages
    .filter((item) => item.role === "system")
    .map((item) => item.content)
    .join("\n")
    .trim();
}

function extractAssistantTextFromMessages(messages: AgentMessage[]): string {
  for (const message of [...messages].reverse()) {
    if ((message as any)?.role !== "assistant") {
      continue;
    }
    const content = (message as { content?: unknown }).content;
    if (typeof content === "string" && content) {
      return content;
    }
    if (!Array.isArray(content)) {
      continue;
    }
    const text = (content as Array<{ type?: string; text?: string }>)
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text as string)
      .join("");
    if (text) {
      return text;
    }
  }
  return "";
}

function syncToolsInPlace(context: AgentContext, tools: AgentTool<any>[]) {
  if (!Array.isArray(context.tools)) {
    context.tools = [...tools];
    return;
  }
  context.tools.splice(0, context.tools.length, ...tools);
}

function isLlmMessage(message: AgentMessage): message is Message {
  const role = (message as any)?.role;
  return role === "user" || role === "assistant" || role === "toolResult";
}

interface ApoptosisToolResult {
  details?: {
    targetToolName?: string;
  };
}

function extractApoptosisTargetToolName(result: unknown): string | null {
  const targetToolName = (result as ApoptosisToolResult | undefined)?.details?.targetToolName;
  if (typeof targetToolName !== "string") {
    return null;
  }
  const normalized = targetToolName.trim();
  return normalized.length > 0 ? normalized : null;
}

async function downloadImageAsBase64(url: string): Promise<string | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    const base64 = buf.toString("base64");
    const contentType = detectImageMime(buf, res.headers.get("content-type"), url);
    return `data:${contentType};base64,${base64}`;
  } catch {
    return null;
  }
}

function detectImageMime(buf: Buffer, headerType: string | null, url: string): string {
  if (buf[0] === 0xFF && buf[1] === 0xD8) return "image/jpeg";
  if (buf[0] === 0x89 && buf[1] === 0x50) return "image/png";
  if (buf[0] === 0x47 && buf[1] === 0x49) return "image/gif";
  if (buf[0] === 0x52 && buf[1] === 0x49) return "image/webp";

  if (headerType && headerType.startsWith("image/")) return headerType;

  const ext = url.split("?")[0].split(".").pop()?.toLowerCase();
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "png") return "image/png";
  if (ext === "gif") return "image/gif";
  if (ext === "webp") return "image/webp";

  return "image/jpeg";
}

async function callVisionApi(
  imageRefs: string[],
  apiKey: string,
  baseURL: string,
  modelId: string,
): Promise<string | null> {
  const endpoint = `${baseURL.replace(/\/+$/, "")}/chat/completions`;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      ...(FORCE_UA ? { "User-Agent": FORCE_UA } : {}),
    },
    body: JSON.stringify({
      model: modelId,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "Describe this image concisely. Include visible text, objects, and notable details. Use Chinese if appropriate." },
          ...imageRefs.map((u) => ({ type: "image_url", image_url: { url: u } })),
        ],
      }],
      max_tokens: 800,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.warn(`[vision] HTTP ${res.status}: ${body}`);
    return null;
  }
  const json: any = await res.json();
  return json?.choices?.[0]?.message?.content ?? null;
}

async function preprocessVisionContent(
  imageUrls: string[],
  apiKey: string,
  baseURL: string,
  modelId: string,
): Promise<string | null> {
  try {
    const base64Urls = await Promise.all(imageUrls.map(downloadImageAsBase64));
    const valid = base64Urls.filter((u): u is string => u !== null);
    if (!valid.length) {
      console.warn("[vision] failed to download images for base64 encoding");
      return null;
    }
    return await callVisionApi(valid, apiKey, baseURL, modelId);
  } catch (err) {
    console.warn("[vision] preprocessing failed:", err);
    return null;
  }
}

export function createAgentLoopRunner(options: CreateAgentLoopRunnerOptions): AgentLoopRunner {
  const activeAgentLoops = new Set<AgentContext>();

  const applyToolsToActiveLoops = () => {
    const tools = options.getCurrentTools();
    for (const activeAgentLoop of activeAgentLoops) {
      syncToolsInPlace(activeAgentLoop, tools);
    }
  };

  const streamEvents: AgentLoopRunner["streamEvents"] = async function* (
    messages,
    generateOptions = {}
  ) {
    const { imageUrls, ...genOpts } = generateOptions;
    const model = createCompatibleModel(genOpts.model ?? options.defaultModel, options.baseURL);
    if (imageUrls?.length) {
      const description = await preprocessVisionContent(
        imageUrls, options.apiKey, options.baseURL, model.id,
      );
      if (description) {
        let lastUserIdx = -1;
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i].role === "user") { lastUserIdx = i; break; }
        }
        if (lastUserIdx >= 0) {
          messages = messages.map((m, i) =>
            i === lastUserIdx
              ? { ...m, content: m.content.replace(/\[photo\]/g, `[图片内容: ${description}]`) }
              : m
          );
        }
      }
    }

    const systemPrompt = extractSystemPrompt(messages);

    const loopContext: AgentContext = {
      systemPrompt,
      messages: [],
      tools: options.getCurrentTools(),
    };
    const abortController = new AbortController();
    activeAgentLoops.add(loopContext);

    let currentMessageHasToolCall = false;
    let currentMessageTextBuffer = "";
    let globalMessageHasEmitted = false;
    try {
      const stream = agentLoop(
        messages as AgentMessage[],
        loopContext,
        {
          model,
          apiKey: options.apiKey,
          temperature: genOpts.temperature,
          convertToLlm: async (agentMessages) => agentMessages.filter(isLlmMessage),
        },
        abortController.signal
      );

      for await (const event of stream) {
        if (event.type === "message_update") {
          const assistantEvent = event.assistantMessageEvent;
          if (assistantEvent.type === "text_delta" && assistantEvent.delta) {
            currentMessageTextBuffer += assistantEvent.delta;
            continue;
          }
          if (assistantEvent.type === "text_end" && assistantEvent.content) {
            if (!currentMessageTextBuffer) {
              currentMessageTextBuffer = assistantEvent.content;
            }
            continue;
          }
          if (
            assistantEvent.type === "toolcall_start" ||
            assistantEvent.type === "toolcall_delta" ||
            assistantEvent.type === "toolcall_end"
          ) {
            currentMessageHasToolCall = true;
          }
          continue;
        }

        if (event.type === "message_end") {
          const message = event.message as {
            role?: string;
            content?: Array<{ type?: string; text?: string }>;
          };
          if (message.role !== "assistant") {
            currentMessageHasToolCall = false;
            currentMessageTextBuffer = "";
            continue;
          }
          if (!currentMessageHasToolCall) {
            let output = currentMessageTextBuffer;
            if (!output && Array.isArray(message.content)) {
              output = message.content
                .filter((block) => block.type === "text" && typeof block.text === "string")
                .map((block) => block.text as string)
                .join("");
            }
            if (output) {
              globalMessageHasEmitted = true;
              yield {
                type: "message_update",
                role: "assistant",
                delta: output,
              };
            }
          }
          currentMessageHasToolCall = false;
          currentMessageTextBuffer = "";
          continue;
        }

        if (event.type === "tool_execution_end") {
          if (event.toolName === "evolute") {
            const pendingTool = consumePendingEvolutedTool(event.toolCallId);
            if (pendingTool) {
              await options.registerDynamicTool(pendingTool);
            } else {
              console.warn(
                `[evolute] pending tool not found for toolCallId=${String(event.toolCallId)}`
              );
            }
            const latestTools = options.getCurrentTools();
            syncToolsInPlace(loopContext, latestTools);
          } else if (event.toolName === "apoptosis") {
            const targetToolName = extractApoptosisTargetToolName(event.result);
            if (targetToolName) {
              await options.unregisterTool(targetToolName);
              const latestTools = options.getCurrentTools();
              syncToolsInPlace(loopContext, latestTools);
            }
          }
          console.log("tool_execution_end", event.result);
          yield {
            type: "tool_execution_end",
            toolName: event.toolName,
            toolCallId: event.toolCallId,
            result: event.result,
          };
          continue;
        }

        if (event.type === "tool_execution_start") {
          console.log("tool_execution_start", event);
          yield {
            type: "tool_execution_start",
            toolName: event.toolName,
            toolCallId: event.toolCallId,
          };
          continue;
        }
      }

      if (!globalMessageHasEmitted) {
        const newMessages = await stream.result();
        const fallbackText = extractAssistantTextFromMessages(newMessages);
        console.log(
          `[loopRunner] fallback extraction: found=${Boolean(fallbackText)} length=${fallbackText.length}`
        );
        if (fallbackText) {
          yield {
            type: "message_update",
            role: "assistant",
            delta: fallbackText,
          };
        }
      }
      yield { type: "completed" };
    } catch (error) {
      yield {
        type: "failed",
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      abortController.abort();
      activeAgentLoops.delete(loopContext);
      loopContext.messages.splice(0, loopContext.messages.length);
    }
  };

  const streamText: AgentLoopRunner["streamText"] = async function* (
    messages,
    generateOptions = {}
  ) {
    for await (const event of streamEvents(messages, generateOptions)) {
      if (event.type === "message_update" && event.delta) {
        yield event.delta;
        continue;
      }
      if (event.type === "failed") {
        throw new Error(event.error);
      }
    }
  };

  return {
    streamEvents,
    streamText,
    applyToolsToActiveLoops,
  };
}

