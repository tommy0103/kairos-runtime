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

export interface ClientRuntime {
  recordMessage: (message: TelegramMessage) => Promise<void>;
  streamReply: (input: {
    triggerMessage: TelegramMessage;
    prompt: string;
  }) => AsyncIterable<string>;
}

export interface CreateClientRuntimeOptions {
  agent?: OpenAIAgent;
  enclaveClient?: AgentEnclaveClient;
  contextStore?: ContextStore;
  contextAssembler?: ContextAssembler;
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
    options.contextStore ?? createInMemoryContextStore();
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
    // console.log("llmMessages", llmMessages);
    void (async () => {
      try {
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
