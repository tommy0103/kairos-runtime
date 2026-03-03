import type { OpenAIAgent } from "../agent/core/openai";
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
  recordMessage: (message: TelegramMessage) => void;
  streamReply: (input: {
    triggerMessage: TelegramMessage;
    prompt: string;
  }) => AsyncIterable<string>;
}

export interface CreateClientRuntimeOptions {
  agent?: OpenAIAgent;
  enclaveClient?: AgentEnclaveClient;
  maxHistoryPerChat?: number;
  contextStore?: ContextStore;
  contextAssembler?: ContextAssembler;
}

export function createClientRuntime(options: CreateClientRuntimeOptions): ClientRuntime {
  const enclaveClient =
    options.enclaveClient ?? (options.agent ? createLocalEnclaveClient(options.agent) : null);
  if (!enclaveClient) {
    throw new Error("createClientRuntime requires either agent or enclaveClient.");
  }

  const contextStore =
    options.contextStore ??
    createInMemoryContextStore({
      maxHistoryPerChat: options.maxHistoryPerChat,
    });
  const contextAssembler = options.contextAssembler ?? createContextAssembler();

  const recordMessage: ClientRuntime["recordMessage"] = (message) => {
    contextStore.append(message);
  };

  const streamReply: ClientRuntime["streamReply"] = ({ triggerMessage, prompt }) => {
    const stream = new RemoteAsyncIterable<string>();
    const history = contextStore.getByChat(triggerMessage.chatId);
    const llmMessages = contextAssembler.build({
      history,
      triggerMessage,
      prompt,
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
