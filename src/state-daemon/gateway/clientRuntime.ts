import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { inspect } from "node:util";
import type { TelegramMessage } from "../types/message";
import { RemoteAsyncIterable } from "../types/remoteAsyncIterable";
import type { AgentEnclaveClient } from "../enclave/protocol";
import {
  createContextAssembler,
  createInMemoryContextStore,
  type ContextAssembler,
  type ContextStore,
} from "./context";
import { createOllamaLocalModel, createOpenAICloudModel } from "../model/llm";
import { createDenseEmbedder } from "../model/embedding";
import { system } from "./context";

export type RuntimeReplyStage =
  | "retrieving_context"
  | "generating"
  | "tool_call"
  | "streaming";

export type RuntimeReplyStreamEvent =
  | {
      type: "status_update";
      stage: RuntimeReplyStage;
      text: string;
    }
  | {
      type: "message_delta";
      delta: string;
    };

export interface ClientRuntime {
  recordMessage: (message: TelegramMessage) => Promise<void>;
  streamReply: (input: {
    triggerMessage: TelegramMessage;
    prompt: string;
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

function statusTextForToolStart(toolName: string): string {
  switch (toolName) {
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

  const streamReply: ClientRuntime["streamReply"] = ({ triggerMessage, prompt }) => {
    const stream = new RemoteAsyncIterable<RuntimeReplyStreamEvent>();
    void (async () => {
      let longRunningTicker: ReturnType<typeof setInterval> | null = null;
      const startedAt = Date.now();
      try {
        stream.push({
          type: "status_update",
          stage: "retrieving_context",
          text: "Retrieving memory and conversation context...",
        });

        const [recentMessages, sessionMessages] = contextStore.getContextByAnchor({
          chatId: triggerMessage.chatId,
          messageId: triggerMessage.messageId,
        });
        const llmMessages = contextAssembler.build({
          contextMessages: sessionMessages,
          recentMessages,
          triggerMessage,
          systemPrompt: system(),
        });

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
        for await (const event of enclaveClient.streamReply({
          chatId: triggerMessage.chatId,
          messages: llmMessages,
          imageUrls: triggerMessage.imageUrls,
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
            if (!startedStreamingText) {
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
    streamReply,
  };
}
