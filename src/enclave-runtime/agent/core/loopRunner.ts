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
  | { type: "message_update"; role: "assistant"; delta: string; }
  | { type: "tool_execution_start"; toolName: string; toolCallId?: string; }
  | { type: "tool_execution_end"; toolName: string; toolCallId?: string; result?: unknown; }
  | { type: "completed"; }
  | { type: "failed"; error: string; };

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
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 4096,
    headers: FORCE_UA ? { "User-Agent": FORCE_UA } : undefined,
  };
}

function extractSystemPrompt(messages: AgentLoopMessage[]): string {
  return messages.filter((item) => item.role === "system").map((item) => item.content).join("\n").trim();
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
  if (!res.ok) return null;
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
    if (!valid.length) return null;
    return await callVisionApi(valid, apiKey, baseURL, modelId);
  } catch (err) {
    return null;
  }
}

function isLlmMessage(message: AgentMessage): message is Message {
  const role = (message as any)?.role;
  return role === "user" || role === "assistant" || role === "toolResult";
}

export function createAgentLoopRunner(options: CreateAgentLoopRunnerOptions): AgentLoopRunner {
  const activeAgentLoops = new Set<AgentContext>();
  const applyToolsToActiveLoops = () => {
    const tools = options.getCurrentTools();
    for (const loop of activeAgentLoops) {
      if (Array.isArray(loop.tools)) loop.tools.splice(0, loop.tools.length, ...tools);
      else loop.tools = [...tools];
    }
  };

  const streamEvents: AgentLoopRunner["streamEvents"] = async function* (messages, generateOptions = {}) {
    const { imageUrls, ...genOpts } = generateOptions;
    const model = createCompatibleModel(genOpts.model ?? options.defaultModel, options.baseURL);
    
    if (imageUrls?.length) {
      const description = await preprocessVisionContent(imageUrls, options.apiKey, options.baseURL, model.id);
      if (description) {
        let lastUserIdx = -1;
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i].role === "user") { lastUserIdx = i; break; }
        }
        if (lastUserIdx >= 0) {
          messages = messages.map((m, i) =>
            i === lastUserIdx ? { ...m, content: m.content.replace(/\[photo(?:\s*x\d+)?\]/g, `[图片内容: ${description}]`) } : m
          );
        }
      }
    }

    const systemPrompt = extractSystemPrompt(messages);
    const loopContext: AgentContext = { systemPrompt, messages: [], tools: options.getCurrentTools() };
    const abortController = new AbortController();
    activeAgentLoops.add(loopContext);

    let currentMessageTextBuffer = "";
    let globalMessageHasEmitted = false;
    try {
      const stream = agentLoop(messages as AgentMessage[], loopContext, { model, apiKey: options.apiKey, temperature: genOpts.temperature, convertToLlm: async (msgs) => msgs.filter(isLlmMessage) as any }, abortController.signal);

      for await (const event of stream) {
        if (event.type === "message_update") {
          const ae = event.assistantMessageEvent;
          if (ae.type === "text_delta" && ae.delta) { currentMessageTextBuffer += ae.delta; continue; }
          if (ae.type === "text_end" && ae.content) { if (!currentMessageTextBuffer) currentMessageTextBuffer = ae.content; continue; }
          continue;
        }
        if (event.type === "message_end") {
          const msg = event.message as any;
          if (msg.role === "assistant" && currentMessageTextBuffer) {
            globalMessageHasEmitted = true;
            yield { type: "message_update", role: "assistant", delta: currentMessageTextBuffer };
          }
          currentMessageTextBuffer = "";
          continue;
        }
      }
      if (!globalMessageHasEmitted && currentMessageTextBuffer.trim().length > 0) {
        yield { type: "message_update", role: "assistant", delta: currentMessageTextBuffer.trim() };
      }
      yield { type: "completed" };
    } catch (error: any) {
      yield { type: "failed", error: error.message || String(error) };
    } finally {
      abortController.abort();
      activeAgentLoops.delete(loopContext);
    }
  };

  return { streamEvents, streamText: async function* (msgs, opts = {}) {
    for await (const ev of streamEvents(msgs, opts)) {
      if (ev.type === "message_update" && ev.delta) yield ev.delta;
      if (ev.type === "failed") throw new Error(ev.error);
    }
  }, applyToolsToActiveLoops };
}
