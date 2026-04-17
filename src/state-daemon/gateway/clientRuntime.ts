import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { inspect } from "node:util";
import type { LLMMessage, TelegramMessage } from "../types/message";
import { RemoteAsyncIterable } from "../types/remoteAsyncIterable";
import type { AgentEnclaveClient, EnclaveOutgoingMediaItem } from "../enclave/protocol";
import {
  buildSystemPromptInput,
  createContextAssembler,
  createInMemoryContextStore,
  formatTimeNow,
  renderLateBindingPrompt,
  renderSystemPrompt,
  type ContextAssembler,
  type ContextStore,
} from "./context";
import { createOllamaLocalModel, createOpenAICloudModel } from "../model/llm";
import { createDenseEmbedder } from "../model/embedding";

export type RuntimeReplyStage =
  | "retrieving_context"
  | "generating"
  | "tool_call"
  | "streaming"
  | "sending";

export type RuntimeReplyStreamEvent =
  | {
      type: "status_update";
      stage: RuntimeReplyStage;
      text: string;
    }
  | {
      type: "send_message";
      text: string;
      replyToMessageId?: number;
      awaitResponse?: boolean;
    }
  | {
      type: "send_file";
      items: EnclaveOutgoingMediaItem[];
      caption?: string;
      replyToMessageId?: number;
      awaitResponse?: boolean;
    }
  | {
      type: "message_delta";
      delta: string;
    };

export interface ProbeDecision {
  shouldReply: boolean;
  reason: string;
  raw: string;
}

export interface ClientRuntime {
  recordMessage: (message: TelegramMessage) => Promise<void>;
  probeShouldReply: (input: {
    triggerMessage: TelegramMessage;
  }) => Promise<ProbeDecision>;
  streamReply: (input: {
    triggerMessage: TelegramMessage;
    prompt: string;
    isProbeActivated?: boolean;
    triggerReason?: string;
  }) => AsyncIterable<RuntimeReplyStreamEvent>;
}

export interface CreateClientRuntimeOptions {
  enclaveClient?: AgentEnclaveClient;
  contextStore?: ContextStore;
  contextAssembler?: ContextAssembler;
  modelConfig?: {
    llm?: {
      ollama?: {
        baseUrl?: string;
        model?: string;
      };
      cloud?: {
        apiKey?: string;
        baseURL?: string;
        model?: string;
      };
    };
    embedding?: {
      provider?: "ollama" | "native";
      ollamaBaseUrl?: string;
      ollamaModel?: string;
    };
  };
}

const SESSION_DEBUG_LOG_PATH = join(
  process.cwd(),
  ".memoh-debug",
  "session-control-blocks.log"
);
const LONG_RUNNING_STATUS_INTERVAL_MS = 15000;
const DEFAULT_PROBE_MODEL_PROVIDER = "ollama";
const DEFAULT_SEND_MESSAGE_MODE = "strict";
const VISION_DEBUG_ENABLED = /^(1|true|yes)$/i.test(
  (process.env.VISION_DEBUG ?? "").trim()
);
type SendMessageMode = "strict" | "compat";

function statusTextForToolStart(toolName: string): string {
  switch (toolName) {
    case "send_message":
      return "Sending message...";
    case "send_file":
      return "Sending media files...";
    case "fetch_webpage":
      return "Checking web sources...";
    case "read_file_safe":
      return "Reading project files...";
    case "list_files_safe":
      return "Scanning project structure...";
    case "run_safe_bash":
      return "Running workspace command...";
    case "write_file_safe":
      return "Applying file updates...";
    case "evolute":
      return "Preparing dynamic capability...";
    case "apoptosis":
      return "Cleaning up obsolete capability...";
    default:
      return `Using tool: ${toolName}`;
  }
}

function statusTextForToolEnd(toolName: string): string {
  switch (toolName) {
    case "send_message":
      return "Message sent.";
    case "send_file":
      return "Media files sent.";
    case "fetch_webpage":
      return "Web lookup complete, continuing generation...";
    case "read_file_safe":
    case "list_files_safe":
      return "Context collected, continuing generation...";
    case "run_safe_bash":
      return "Command finished, reviewing output...";
    case "write_file_safe":
      return "File update done, continuing response...";
    default:
      return "Tool step finished, continuing generation...";
  }
}

function resolveSendMessageMode(): SendMessageMode {
  const raw = process.env.ENCLAVE_SEND_MESSAGE_MODE?.trim().toLowerCase();
  if (raw === "compat") {
    return "compat";
  }
  return DEFAULT_SEND_MESSAGE_MODE;
}

function parseReplyToMessageId(input: string | undefined): number | undefined {
  if (!input) {
    return undefined;
  }
  const parsed = Number.parseInt(input, 10);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }
  return parsed;
}

function toLocalPrompt(messages: LLMMessage[]): string {
  return messages
    .map((message) => `[${message.role.toUpperCase()}]\n${message.content}`)
    .join("\n\n");
}

function parseProbeDecision(text: string): ProbeDecision {
  const trimmed = text.trim();
  const jsonStart = trimmed.indexOf("{");
  const jsonEnd = trimmed.lastIndexOf("}") + 1;

  if (jsonStart >= 0 && jsonEnd > jsonStart) {
    try {
      const parsed = JSON.parse(trimmed.slice(jsonStart, jsonEnd)) as {
        action?: unknown;
        reason?: unknown;
        shouldReply?: unknown;
        respond?: unknown;
      };
      if (typeof parsed.shouldReply === "boolean") {
        return {
          shouldReply: parsed.shouldReply,
          reason: typeof parsed.reason === "string" ? parsed.reason : "boolean_should_reply",
          raw: text,
        };
      }
      if (typeof parsed.respond === "boolean") {
        return {
          shouldReply: parsed.respond,
          reason: typeof parsed.reason === "string" ? parsed.reason : "boolean_respond",
          raw: text,
        };
      }
      if (typeof parsed.action === "string") {
        const action = parsed.action.trim().toLowerCase();
        if (action === "respond" || action === "reply" || action === "activate") {
          return {
            shouldReply: true,
            reason: typeof parsed.reason === "string" ? parsed.reason : action,
            raw: text,
          };
        }
        if (action === "silent" || action === "silence" || action === "ignore" || action === "skip") {
          return {
            shouldReply: false,
            reason: typeof parsed.reason === "string" ? parsed.reason : action,
            raw: text,
          };
        }
      }
    } catch {
    }
  }

  return { shouldReply: false, reason: "invalid_format", raw: text };
}

export function createClientRuntime(options: CreateClientRuntimeOptions): ClientRuntime {
  const enclaveClient =
    options.enclaveClient;
  if (!enclaveClient) {
    throw new Error("createClientRuntime requires either agent or enclaveClient.");
  }

  const contextStore =
    options.contextStore ?? createInMemoryContextStore({
      embedder: createDenseEmbedder({
        provider: options.modelConfig?.embedding?.provider,
        ollamaBaseUrl: options.modelConfig?.embedding?.ollamaBaseUrl,
        ollamaModel: options.modelConfig?.embedding?.ollamaModel,
      }),
      localModel: createOllamaLocalModel({
        baseUrl: options.modelConfig?.llm?.ollama?.baseUrl,
        model: options.modelConfig?.llm?.ollama?.model,
      }),
      cloudModel: createOpenAICloudModel({
        apiKey: options.modelConfig?.llm?.cloud?.apiKey,
        baseURL: options.modelConfig?.llm?.cloud?.baseURL,
        model: options.modelConfig?.llm?.cloud?.model,
      }),
    });
  const contextAssembler = options.contextAssembler ?? createContextAssembler();
  const probeProvider = (
    process.env.STATE_DAEMON_PROBE_MODEL_PROVIDER ??
    process.env.PROBE_MODEL_PROVIDER ??
    DEFAULT_PROBE_MODEL_PROVIDER
  ).toLowerCase();
  const probeLocalModel = createOllamaLocalModel({
    baseUrl:
      process.env.STATE_DAEMON_PROBE_OLLAMA_BASE_URL ??
      options.modelConfig?.llm?.ollama?.baseUrl,
    model:
      process.env.STATE_DAEMON_PROBE_OLLAMA_MODEL ??
      options.modelConfig?.llm?.ollama?.model,
  });
  const probeCloudModel = createOpenAICloudModel({
    apiKey:
      process.env.STATE_DAEMON_PROBE_CLOUD_API_KEY ??
      options.modelConfig?.llm?.cloud?.apiKey,
    baseURL:
      process.env.STATE_DAEMON_PROBE_CLOUD_BASE_URL ??
      options.modelConfig?.llm?.cloud?.baseURL,
    model:
      process.env.STATE_DAEMON_PROBE_CLOUD_MODEL ??
      options.modelConfig?.llm?.cloud?.model,
  });

  const buildContextMessages = async (
    triggerMessage: TelegramMessage,
    sendMessageMode: SendMessageMode,
  ): Promise<LLMMessage[]> => {
    const [recentMessages, sessionMessages] = contextStore.getContextByAnchor({
      chatId: triggerMessage.chatId,
      messageId: triggerMessage.messageId,
    });

    const systemPrompt = await renderSystemPrompt(
      buildSystemPromptInput({ sendMessageMode }),
    );

    return contextAssembler.build({
      contextMessages: sessionMessages,
      recentMessages,
      triggerMessage,
      systemPrompt,
    });
  };

  const recordMessage: ClientRuntime["recordMessage"] = async (message) => {
    await contextStore.ingestMessage({ message });
    const lines: string[] = [];
    contextStore.debugPrintSessionControlBlocks({
      chatId: message.chatId,
      log: (...args: unknown[]) => {
        lines.push(args.map((arg) => inspect(arg, { depth: null, compact: true })).join(" "));
      },
    });
    if (lines.length > 0) {
      await mkdir(join(process.cwd(), ".memoh-debug"), { recursive: true });
      const stamp = new Date().toISOString();
      const header = `\n[${stamp}] chatId=${message.chatId} messageId=${message.messageId}\n`;
      await appendFile(SESSION_DEBUG_LOG_PATH, `${header}${lines.join("\n")}\n`, "utf8");
    }
  };

  const probeShouldReply: ClientRuntime["probeShouldReply"] = async ({
    triggerMessage,
  }) => {
    const sendMessageMode = resolveSendMessageMode();
    const messages = await buildContextMessages(triggerMessage, sendMessageMode);
    const lateBindingPrompt = await renderLateBindingPrompt({
      timeNow: formatTimeNow(),
      conversationType: triggerMessage.conversationType,
      isProbeEnabled: true,
      isProbing: true,
      isMentioned: triggerMessage.metadata.isMentionMe,
      isReplied: triggerMessage.metadata.isReplyToMe,
      triggerReason: "probe_gate",
    });

    messages.push({ role: "user", content: lateBindingPrompt });

    const text =
      probeProvider === "cloud"
        ? (await probeCloudModel.complete({ messages })).text
        : (await probeLocalModel.complete({ prompt: toLocalPrompt(messages) })).text;
    return parseProbeDecision(text);
  };

  const streamReply: ClientRuntime["streamReply"] = ({
    triggerMessage,
    prompt,
    isProbeActivated,
    triggerReason,
  }) => {
    const stream = new RemoteAsyncIterable<RuntimeReplyStreamEvent>();
    void (async () => {
      const sendMessageMode = resolveSendMessageMode();
      let longRunningTicker: ReturnType<typeof setInterval> | null = null;
      const startedAt = Date.now();
      try {
        stream.push({
          type: "status_update",
          stage: "retrieving_context",
          text: "Retrieving memory and conversation context...",
        });

        const llmMessages = await buildContextMessages(triggerMessage, sendMessageMode);
        const normalizedPrompt = prompt.trim();
        const lateBindingPrompt = await renderLateBindingPrompt({
          timeNow: formatTimeNow(),
          conversationType: triggerMessage.conversationType,
          isProbeEnabled: isProbeActivated === true,
          isProbing: false,
          isMentioned: triggerMessage.metadata.isMentionMe,
          isReplied: triggerMessage.metadata.isReplyToMe,
          extraGuideline: normalizedPrompt || undefined,
          triggerReason,
        });
        llmMessages.push({ role: "user", content: lateBindingPrompt });

        stream.push({
          type: "status_update",
          stage: "generating",
          text: "Generating response...",
        });

        longRunningTicker = setInterval(() => {
          const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
          stream.push({
            type: "status_update",
            stage: "generating",
            text: `Still working (${elapsedSeconds}s elapsed)...`,
          });
        }, LONG_RUNNING_STATUS_INTERVAL_MS);

        let startedStreamingText = false;
        const imageUrls = (triggerMessage.imageUrls ?? [])
          .map((item) => item.trim())
          .filter((item) => item.length > 0);
        if (triggerMessage.context.includes("[photo") && imageUrls.length === 0) {
          console.warn(
            `[vision] trigger has photo placeholder but no imageUrls chat=${triggerMessage.chatId} messageId=${triggerMessage.messageId}`,
          );
        } else if (VISION_DEBUG_ENABLED && imageUrls.length > 0) {
          console.log(
            `[vision] forwarding imageUrls chat=${triggerMessage.chatId} messageId=${triggerMessage.messageId} count=${imageUrls.length}`,
          );
        }
        for await (const event of enclaveClient.streamReply({
          chatId: triggerMessage.chatId,
          messages: llmMessages,
          imageUrls,
        })) {
          if (event.type === "tool_execution_start") {
            stream.push({
              type: "status_update",
              stage: "tool_call",
              text: statusTextForToolStart(event.toolName),
            });
            continue;
          }
          if (event.type === "tool_execution_end") {
            stream.push({
              type: "status_update",
              stage: "generating",
              text: statusTextForToolEnd(event.toolName),
            });
            continue;
          }
          if (event.type === "message_update" && event.role === "assistant" && event.delta) {
            if (sendMessageMode !== "strict" && !startedStreamingText) {
              stream.push({
                type: "status_update",
                stage: "streaming",
                text: "Streaming reply...",
              });
              startedStreamingText = true;
            }
            stream.push({
              type: "message_delta",
              delta: event.delta,
            });
            continue;
          }
          if (event.type === "send_message" && event.delta) {
            stream.push({
              type: "status_update",
              stage: "sending",
              text: "Sending message...",
            });
            stream.push({
              type: "send_message",
              text: event.delta,
              replyToMessageId: parseReplyToMessageId(event.replyTo),
              awaitResponse: event.awaitResponse,
            });
            continue;
          }
          if (event.type === "send_file") {
            stream.push({
              type: "status_update",
              stage: "sending",
              text: "Sending media files...",
            });
            stream.push({
              type: "send_file",
              items: event.items,
              caption: event.caption,
              replyToMessageId: parseReplyToMessageId(event.replyTo),
              awaitResponse: event.awaitResponse,
            });
            continue;
          }
          if (event.type === "failed") {
            throw new Error(event.error);
          }
          if (event.type === "completed") {
            break;
          }
        }
        if (longRunningTicker) {
          clearInterval(longRunningTicker);
          longRunningTicker = null;
        }
        stream.end();
      } catch (error) {
        if (longRunningTicker) {
          clearInterval(longRunningTicker);
          longRunningTicker = null;
        }
        stream.fail(error);
      }
    })();
    return stream;
  };

  return {
    recordMessage,
    probeShouldReply,
    streamReply,
  };
}
