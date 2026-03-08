import type { OpenAIAgent } from "../agent/core/openai";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { inspect } from "node:util";
import type { TelegramMessage } from "../telegram/types";
import { system } from "../agent/prompt";
import { RemoteAsyncIterable } from "../agent/remoteAsyncIterable";
import type { AgentEnclaveClient } from "../agent/transport/enclave/protocol";
import { createLocalEnclaveClient } from "../agent/transport/enclave/client";
import {
  createContextAssembler,
  createInMemoryContextStore,
  type ContextAssembler,
  type ContextStore,
} from "./context";
import { createOllamaLocalModel, createOpenAICloudModel } from "../llm";
import { createOllamaDenseEmbedder } from "../embedding";
import { createUserMemoryStore } from "../storage/userMemory";
import { createUserbotClient } from "../telegram/userbot";

export interface ClientRuntime {
  recordMessage: (message: TelegramMessage) => Promise<void>;
  streamReply: (input: {
    triggerMessage: TelegramMessage;
    prompt: string;
  }) => AsyncIterable<string>;
}

import { createUserbotClient } from "../telegram/userbot";

export interface CreateClientRuntimeOptions {
  agent?: OpenAIAgent;
  enclaveClient?: AgentEnclaveClient;
  contextStore?: ContextStore;
  contextAssembler?: ContextAssembler;
  userbot?: Awaited<ReturnType<typeof createUserbotClient>>;
}

const SESSION_DEBUG_LOG_PATH = join(
  process.cwd(),
  ".memoh-debug",
  "session-control-blocks.log"
);

export function createClientRuntime(options: CreateClientRuntimeOptions): ClientRuntime {
  const enclaveClient =
    options.enclaveClient ?? (options.agent ? createLocalEnclaveClient(options.agent) : null);
  if (!enclaveClient) {
    throw new Error("createClientRuntime requires either agent or enclaveClient.");
  }

  const contextStore =
    options.contextStore ?? createInMemoryContextStore({
      embedder: createOllamaDenseEmbedder({
        model: "qwen3-embedding:0.6b"
      }),
      // localModel: createOllamaLocalModel(),
      cloudModel: createOpenAICloudModel({
        apiKey: process.env.SUMMARIZER_API_KEY,
        baseURL: process.env.SUMMARIZER_BASE_URL ?? "https://ark.cn-beijing.volces.com/api/v3",
        model: process.env.SUMMARIZER_MODEL ?? "doubao-seed-2-0-lite-260215",
        // apiKey: process.env.DEEPSEEK_API_KEY,
        // baseURL: "https://api.deepseek.com/v1",
        // model: "deepseek-chat",
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
    const stream = new RemoteAsyncIterable<string>();
    
    void (async () => {
      try {
        const mode = process.env.CONTEXT_MODE || "session";
        
        let contextMessages: TelegramMessage[];
        let recentMessages: TelegramMessage[];
        let userFacts: string[] | undefined = undefined;

        if (mode === "bruteforce") {
          /**
           * 暴力全量模式：
           * 1. 优先调用 Userbot (MTProto) 直接从 Telegram 服务器拉取最近 1000 条真实消息。
           * 2. 如果 Userbot 未配置，则回退到内存中的 LinearContext。
           */
          const bruteforceLimit = parseInt(process.env.MAX_BRUTEFORCE_MESSAGES || "1000", 10);

          if (options.userbot) {
            try {
              const remoteHistory = await options.userbot.getHistory(triggerMessage.chatId, bruteforceLimit);
              if (remoteHistory.length > 0) {
                // 将 Userbot 获取的历史映射为系统通用的消息格式
                contextMessages = remoteHistory.map(m => ({
                  ...m,
                  chatId: triggerMessage.chatId,
                  messageId: 0, // Userbot 消息 ID 暂不用于锚点
                  conversationType: triggerMessage.conversationType,
                })) as TelegramMessage[];
              } else {
                contextMessages = contextStore.getLinearContext({ chatId: triggerMessage.chatId, limit: bruteforceLimit });
              }
            } catch (err) {
              console.error("[Userbot] 远程拉取失败，回退内存:", err);
              contextMessages = contextStore.getLinearContext({ chatId: triggerMessage.chatId, limit: bruteforceLimit });
            }
          } else {
            contextMessages = contextStore.getLinearContext({ chatId: triggerMessage.chatId, limit: bruteforceLimit });
          }

          recentMessages = [];
          userFacts = undefined;
        }
 else if (mode === "linear") {
          const linearLimit = parseInt(process.env.MAX_LINEAR_MESSAGES || "50", 10);
          contextMessages = contextStore.getLinearContext({ 
            chatId: triggerMessage.chatId, 
            limit: linearLimit 
          });
          recentMessages = [];
          // 线性模式仍可使用记忆事实
          const memoryStore = createUserMemoryStore();
          userFacts = await memoryStore.getFacts(triggerMessage.userId);
        } else {
          // 传统会话模式
          const [recent, session] = contextStore.getContextByAnchor({
            chatId: triggerMessage.chatId,
            messageId: triggerMessage.messageId,
          });
          recentMessages = recent;
          contextMessages = session;
          // 传统模式使用记忆事实
          const memoryStore = createUserMemoryStore();
          userFacts = await memoryStore.getFacts(triggerMessage.userId);
        }

        const llmMessages = contextAssembler.build({
          contextMessages,
          recentMessages,
          triggerMessage,
          systemPrompt: system(),
          userFacts,
        });

        for await (const event of enclaveClient.streamReply({
          chatId: triggerMessage.chatId,
          messages: llmMessages,
        })) {
          if (event.type === "message_update" && event.role === "assistant" && event.delta) {
            stream.push(event.delta);
            continue;
          }
          if (event.type === "failed") {
            throw new Error(event.error);
          }
          if (event.type === "completed") {
            break;
          }
        }
        stream.end();
      } catch (error) {
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
