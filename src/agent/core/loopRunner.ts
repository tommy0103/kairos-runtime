import {
  agentLoop,
  type AgentContext,
  type AgentMessage,
  type AgentTool,
} from "@mariozechner/pi-agent-core";
import type { Message, Model } from "@mariozechner/pi-ai";
import { consumePendingEvolutedTool } from "../tools/evolute";
import { logger } from "../../utils/logger";

export interface AgentLoopMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface AgentLoopGenerateOptions {
  model?: string;
  temperature?: number;
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
    input: ["text"],
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

function extractLatestUserPrompt(messages: AgentLoopMessage[]): string {
  const latestUserMessage = [...messages]
    .reverse()
    .filter((item): item is AgentLoopMessage & { role: "user" } => item.role === "user")
    .find((item) => item.content.trim().length > 0);
  return latestUserMessage?.content ?? "";
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
    const model = createCompatibleModel(generateOptions.model ?? options.defaultModel, options.baseURL);
    // const prompt = extractLatestUserPrompt(messages);
    const systemPrompt = extractSystemPrompt(messages);
    // if (!prompt.trim()) {
    //   yield { type: "completed" };
    //   return;
    // }
    logger.debug("Agent", "LoopRunner 开始迭代", { messageCount: messages.length });

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
      // const userPrompt = { role: "user", content: prompt, timestamp: Date.now() } as AgentMessage;
      const stream = agentLoop(
        // [userPrompt],
        messages as AgentMessage[],
        loopContext,
        {
          model,
          apiKey: options.apiKey,
          temperature: generateOptions.temperature,
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
          logger.info("Agent", `工具执行结束: ${event.toolName}`, { result: event.result });
          yield {
            type: "tool_execution_end",
            toolName: event.toolName,
            toolCallId: event.toolCallId,
            result: event.result,
          };
          continue;
        }

        if (event.type === "tool_execution_start") {
          logger.info("Agent", `工具开始执行: ${event.toolName}`);
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
        if (fallbackText) {
          logger.debug("Agent", "由于流中断，使用 Fallback 提取文本");
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
