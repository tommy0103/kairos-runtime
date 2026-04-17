import {
  agentLoop,
  type AgentContext,
  type AgentMessage,
  type AgentTool,
} from "@mariozechner/pi-agent-core";
import type { Message, Model } from "@mariozechner/pi-ai";
import { createLlmFetcher, getLLMHeaders } from "../../../utils/llm-adapter";
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
      type: "send_message";
      delta: string;
      toolCallId?: string;
      awaitResponse?: boolean;
      replyTo?: string;
    }
  | {
      type: "send_file";
      items: Array<{
        source: string;
        type: "image" | "audio" | "file";
        mimeType?: string;
        fileName?: string;
      }>;
      caption?: string;
      toolCallId?: string;
      awaitResponse?: boolean;
      replyTo?: string;
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
const DEFAULT_SEND_MESSAGE_MODE = "strict";
const DEFAULT_STRICT_TEXT_FALLBACK = true;
const VISION_DEBUG_ENABLED = /^(1|true|yes)$/i.test(
  (process.env.VISION_DEBUG ?? "").trim()
);
type SendMessageMode = "strict" | "compat";

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
    headers: getLLMHeaders(),
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

interface SendMessageToolResult {
  details?: {
    text?: string;
    awaitResponse?: boolean;
    replyTo?: string;
  };
}

interface SendFileToolResult {
  details?: {
    items?: Array<{
      source?: string;
      type?: string;
      mimeType?: string;
      fileName?: string;
    }>;
    caption?: string;
    awaitResponse?: boolean;
    replyTo?: string;
  };
}

interface AgentEndMessage {
  role?: string;
  content?: Array<{ type?: string; text?: string }>;
  stopReason?: string;
  errorMessage?: string;
}

function extractApoptosisTargetToolName(result: unknown): string | null {
  const targetToolName = (result as ApoptosisToolResult | undefined)?.details?.targetToolName;
  if (typeof targetToolName !== "string") {
    return null;
  }
  const normalized = targetToolName.trim();
  return normalized.length > 0 ? normalized : null;
}

function resolveSendMessageMode(): SendMessageMode {
  const raw = process.env.ENCLAVE_SEND_MESSAGE_MODE?.trim().toLowerCase();
  if (raw === "compat") {
    return "compat";
  }
  return DEFAULT_SEND_MESSAGE_MODE;
}

function resolveStrictTextFallbackEnabled(): boolean {
  const raw = process.env.ENCLAVE_STRICT_TEXT_FALLBACK?.trim().toLowerCase();
  if (!raw) {
    return DEFAULT_STRICT_TEXT_FALLBACK;
  }
  if (raw === "0" || raw === "false" || raw === "no" || raw === "off") {
    return false;
  }
  return true;
}

function extractSendMessagePayload(result: unknown): {
  text: string;
  awaitResponse: boolean;
  replyTo?: string;
} | null {
  const details = (result as SendMessageToolResult | undefined)?.details;
  const text = typeof details?.text === "string" ? details.text.trim() : "";
  if (!text) {
    return null;
  }
  const replyTo = typeof details?.replyTo === "string" && details.replyTo.trim()
    ? details.replyTo.trim()
    : undefined;
  return {
    text,
    awaitResponse: details?.awaitResponse === true,
    replyTo,
  };
}

function extractSendFilePayload(result: unknown): {
  items: Array<{
    source: string;
    type: "image" | "audio" | "file";
    mimeType?: string;
    fileName?: string;
  }>;
  caption?: string;
  awaitResponse: boolean;
  replyTo?: string;
} | null {
  const details = (result as SendFileToolResult | undefined)?.details;
  if (!Array.isArray(details?.items) || details.items.length === 0) {
    return null;
  }

  const items: Array<{
    source: string;
    type: "image" | "audio" | "file";
    mimeType?: string;
    fileName?: string;
  }> = [];

  for (const item of details.items) {
    const source = typeof item?.source === "string" ? item.source.trim() : "";
    const type = item?.type;
    if (!source) {
      continue;
    }
    if (type !== "image" && type !== "audio" && type !== "file") {
      continue;
    }
    items.push({
      source,
      type,
      mimeType: typeof item?.mimeType === "string" && item.mimeType.trim()
        ? item.mimeType.trim()
        : undefined,
      fileName: typeof item?.fileName === "string" && item.fileName.trim()
        ? item.fileName.trim()
        : undefined,
    });
  }

  if (items.length === 0) {
    return null;
  }

  const caption = typeof details.caption === "string" && details.caption.trim()
    ? details.caption.trim()
    : undefined;
  const replyTo = typeof details.replyTo === "string" && details.replyTo.trim()
    ? details.replyTo.trim()
    : undefined;

  return {
    items,
    caption,
    awaitResponse: details.awaitResponse === true,
    replyTo,
  };
}

import fs from "node:fs/promises";

async function downloadImageAsBase64(url: string): Promise<string | null> {
  try {
    let buf: Buffer;
    let contentType: string;

    if (url.startsWith("file://")) {
      const filePath = url.slice(7);
      buf = await fs.readFile(filePath);
      contentType = detectImageMime(buf, null, url);
    } else if (/^https?:\/\//i.test(url)) {
      const res = await fetch(url);
      if (!res.ok) return null;
      buf = Buffer.from(await res.arrayBuffer());
      contentType = detectImageMime(buf, res.headers.get("content-type"), url);
    } else {
      // Userbot may pass plain local paths (for example /tmp/kairos-vision/xxx.jpg).
      buf = await fs.readFile(url);
      contentType = detectImageMime(buf, null, url);
    }

    const base64 = buf.toString("base64");
    return `data:${contentType};base64,${base64}`;
  } catch (err) {
    console.warn("[vision] downloadImageAsBase64 failed for", url, err);
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


interface VisionEndpointConfig {
  apiKey: string;
  baseURL: string;
  modelId: string;
}

function readEnvOverride(name: string): string | undefined {
  const raw = process.env[name];
  if (typeof raw !== "string") {
    return undefined;
  }
  const normalized = raw.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function resolveVisionEndpointConfig(options: {
  apiKey: string;
  baseURL: string;
  modelId: string;
}): VisionEndpointConfig {
  const apiKey =
    readEnvOverride("VISION_API_KEY") ??
    readEnvOverride("CUSTOM_EMOJI_TO_TEXT_API_KEY") ??
    options.apiKey;
  const baseURL =
    readEnvOverride("VISION_BASE_URL") ??
    readEnvOverride("CUSTOM_EMOJI_TO_TEXT_BASE_URL") ??
    options.baseURL;
  const modelId =
    readEnvOverride("VISION_MODEL") ??
    readEnvOverride("CUSTOM_EMOJI_TO_TEXT_MODEL") ??
    options.modelId;

  return { apiKey, baseURL, modelId };
}

function extractVisionMessageText(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const text = content
    .map((item) => {
      if (!item || typeof item !== "object") {
        return "";
      }
      const maybeText = (item as { text?: unknown }).text;
      return typeof maybeText === "string" ? maybeText : "";
    })
    .filter((item) => item.length > 0)
    .join("\n")
    .trim();
  return text;
}

function injectVisionDescription(messages: AgentLoopMessage[], description: string): AgentLoopMessage[] {
  let replacedAny = false;
  const replacedMessages = messages.map((message) => {
    if (message.role !== "user") {
      return message;
    }
    const content = message.content.replace(
      /\[photo(?:\s*x\d+)?\]/g,
      `[图片内容: ${description}]`
    );
    if (content !== message.content) {
      replacedAny = true;
      return { ...message, content };
    }
    return message;
  });

  if (replacedAny) {
    return replacedMessages;
  }

  for (let i = replacedMessages.length - 1; i >= 0; i--) {
    if (replacedMessages[i].role !== "user") {
      continue;
    }
    const suffix = `\n\n[图片内容: ${description}]`;
    replacedMessages[i] = {
      ...replacedMessages[i],
      content: `${replacedMessages[i].content}${suffix}`,
    };
    if (VISION_DEBUG_ENABLED) {
      console.warn("[vision] no [photo] placeholder found, appended image description to last user message");
    }
    return replacedMessages;
  }

  return [
    ...replacedMessages,
    { role: "user", content: `[图片内容: ${description}]` },
  ];
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

    const fetcher = createLlmFetcher({ apiKey, baseURL });
    const json: any = await fetcher("/chat/completions", {
      model: modelId,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "Describe this image concisely. Include visible text, objects, and notable details. Use Chinese if appropriate." },
          ...valid.map((u) => ({ type: "image_url", image_url: { url: u } })),
        ],
      }],
      max_tokens: 240,
    });
    const text = extractVisionMessageText(json?.choices?.[0]?.message?.content);
    if (!text) {
      if (VISION_DEBUG_ENABLED) {
        console.warn(
          "[vision] empty content from vision model response",
          JSON.stringify({
            hasChoices: Array.isArray(json?.choices),
            model: modelId,
          }),
        );
      }
      return null;
    }
    return text;
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
      if (VISION_DEBUG_ENABLED) {
        console.log(`[vision] preprocessing start count=${imageUrls.length}`);
      }
      const vision = resolveVisionEndpointConfig({
        apiKey: options.apiKey,
        baseURL: options.baseURL,
        modelId: model.id,
      });
      const description = await preprocessVisionContent(
        imageUrls,
        vision.apiKey,
        vision.baseURL,
        vision.modelId,
      );
      if (description) {
        if (VISION_DEBUG_ENABLED) {
          console.log(`[vision] description injected length=${description.length}`);
        }
        messages = injectVisionDescription(messages, description);
      } else if (VISION_DEBUG_ENABLED) {
        console.warn("[vision] description is empty after preprocessing");
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
    let messageSentViaTool = false;
    const sendMessageMode = resolveSendMessageMode();
    const strictTextFallbackEnabled = resolveStrictTextFallbackEnabled();
    try {
      console.log("[loopRunner] calling agentLoop with messages:", messages.length);
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
      console.log("[loopRunner] agentLoop returned stream");

      for await (const event of stream) {
        console.log("[loopRunner] event:", event.type, event);
        if (event.type === "message_update") {
          const assistantEvent = event.assistantMessageEvent;
          if (assistantEvent.type === "text_delta" && assistantEvent.delta) {
            currentMessageTextBuffer += assistantEvent.delta;
            console.log("[loopRunner] text_delta:", assistantEvent.delta);
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
          console.log("[loopRunner] message_end, buffer:", currentMessageTextBuffer, "hasToolCall:", currentMessageHasToolCall);
          const message = event.message as AgentEndMessage;
          if (message.role !== "assistant") {
            console.log("[loopRunner] message_end: role is not assistant:", message.role);
            currentMessageHasToolCall = false;
            currentMessageTextBuffer = "";
            continue;
          }
          // 处理错误情况
          if (message.stopReason === "error") {
            const errorMsg = message.errorMessage || "Unknown error";
            console.log("[loopRunner] message_end error:", errorMsg);
            globalMessageHasEmitted = true;
            yield {
              type: "message_update",
              role: "assistant",
              delta: `(模型调用失败: ${errorMsg})`,
            };
            currentMessageHasToolCall = false;
            currentMessageTextBuffer = "";
            continue;
          }
          if (!currentMessageHasToolCall && sendMessageMode === "compat" && !messageSentViaTool) {
            let output = currentMessageTextBuffer;
            if (!output && Array.isArray(message.content)) {
              output = message.content
                .filter((block) => block.type === "text" && typeof block.text === "string")
                .map((block) => block.text as string)
                .join("");
            }
            console.log("[loopRunner] message_end output:", output);
            if (output) {
              globalMessageHasEmitted = true;
              yield {
                type: "message_update",
                role: "assistant",
                delta: output,
              };
            }
          } else if (
            !currentMessageHasToolCall &&
            sendMessageMode === "strict" &&
            strictTextFallbackEnabled &&
            !messageSentViaTool
          ) {
            let output = currentMessageTextBuffer;
            if (!output && Array.isArray(message.content)) {
              output = message.content
                .filter((block) => block.type === "text" && typeof block.text === "string")
                .map((block) => block.text as string)
                .join("");
            }
            if (output) {
              globalMessageHasEmitted = true;
              console.warn("[loopRunner] strict fallback: emitting plain text because send_message was not called");
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
          let toolsChanged = false;
          if (event.toolName === "evolute") {
            const pendingTool = consumePendingEvolutedTool(event.toolCallId);
            if (pendingTool) {
              await options.registerDynamicTool(pendingTool);
              toolsChanged = true;
            } else {
              console.warn(
                `[evolute] pending tool not found for toolCallId=${String(event.toolCallId)}`
              );
            }
          } else if (event.toolName === "apoptosis") {
            const targetToolName = extractApoptosisTargetToolName(event.result);
            if (targetToolName) {
              await options.unregisterTool(targetToolName);
              toolsChanged = true;
            }
          } else if (event.toolName === "send_message") {
            const payload = extractSendMessagePayload(event.result);
            if (payload) {
              messageSentViaTool = true;
              globalMessageHasEmitted = true;
              yield {
                type: "send_message",
                delta: payload.text,
                toolCallId: event.toolCallId,
                awaitResponse: payload.awaitResponse,
                replyTo: payload.replyTo,
              };
            }
          } else if (event.toolName === "send_file") {
            const payload = extractSendFilePayload(event.result);
            if (payload) {
              messageSentViaTool = true;
              globalMessageHasEmitted = true;
              yield {
                type: "send_file",
                items: payload.items,
                caption: payload.caption,
                toolCallId: event.toolCallId,
                awaitResponse: payload.awaitResponse,
                replyTo: payload.replyTo,
              };
            }
          }
          if (toolsChanged) {
            syncToolsInPlace(loopContext, options.getCurrentTools());
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

      if (!globalMessageHasEmitted && !messageSentViaTool) {
        const newMessages = await stream.result();
        const fallbackText = extractAssistantTextFromMessages(newMessages);
        console.log(
          `[loopRunner] fallback extraction: found=${Boolean(fallbackText)} length=${fallbackText.length}`
        );
        const canEmitFallbackText =
          sendMessageMode === "compat" ||
          (sendMessageMode === "strict" && strictTextFallbackEnabled);
        if (fallbackText && canEmitFallbackText) {
          if (sendMessageMode === "strict") {
            console.warn("[loopRunner] strict fallback extraction: emitting plain text because send_message was not called");
          }
          yield {
            type: "message_update",
            role: "assistant",
            delta: fallbackText,
          };
        }
      }
      yield { type: "completed" };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.log("[loopRunner] caught error:", errorMsg);
      yield {
        type: "failed",
        error: errorMsg,
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
