/**
 * ClientRuntime — logos-native version.
 *
 * All state goes through logos kernel. Session clustering by kernel.
 * Persona read from logos://users/. Context from system.get_context.
 */

import type { TelegramMessage } from "../types/message";
import { RemoteAsyncIterable } from "../types/remoteAsyncIterable";
import type { AgentEnclaveClient } from "../enclave/protocol";
import { MemoryVfsClient } from "../storage/vfs/client";

export interface ClientRuntime {
  recordMessage: (message: TelegramMessage) => Promise<void>;
  streamReply: (input: {
    triggerMessage: TelegramMessage;
    prompt: string;
  }) => AsyncIterable<string>;
}

export interface CreateClientRuntimeOptions {
  enclaveClient?: AgentEnclaveClient;
  vfsClient?: MemoryVfsClient;
}

const BOT_UID = "kairos-bot";

export function createClientRuntime(options: CreateClientRuntimeOptions): ClientRuntime {
  const enclaveClient = options.enclaveClient;
  if (!enclaveClient) {
    throw new Error("createClientRuntime requires enclaveClient.");
  }

  const vfs = options.vfsClient ?? new MemoryVfsClient();

  // Init session in background so call() works
  let sessionReady = false;
  const taskId = `daemon-${Date.now()}`;
  vfs.initSession(taskId, "kairos-daemon").then(() => {
    sessionReady = true;
    console.log("[clientRuntime] logos session ready");
    // Create daemon task in system
    vfs.write({
      path: "logos://system/tasks",
      content: JSON.stringify({
        task_id: taskId, description: "kairos daemon", chat_id: "", trigger: "daemon",
      }),
    }).catch(() => {});
  }).catch(e => {
    console.error("[clientRuntime] logos session failed:", e);
  });

  const recordMessage: ClientRuntime["recordMessage"] = async (message) => {
    try {
      await vfs.write({
        path: `logos://memory/groups/${message.chatId}/messages`,
        content: JSON.stringify({
          msg_id: message.messageId,
          chat_id: String(message.chatId),
          speaker: message.senderName ?? message.userId?.toString() ?? "unknown",
          text: message.text,
          reply_to: message.replyToMessageId ?? null,
          ts: new Date(message.timestamp * 1000).toISOString(),
          mentions: JSON.stringify(message.mentions ?? []),
        }),
      });
    } catch (error) {
      console.error(`[clientRuntime] record message failed:`, error);
    }
  };

  const streamReply: ClientRuntime["streamReply"] = ({ triggerMessage, prompt }) => {
    const stream = new RemoteAsyncIterable<string>();

    void (async () => {
      try {
        // 1. Get context from logos (session + summary + persona paths)
        let contextJson: any = {};
        if (sessionReady) {
          try {
            const resp = await vfs.call({
              tool: "system.get_context",
              params: {
                chat_id: String(triggerMessage.chatId),
                sender_uid: triggerMessage.userId?.toString() ?? "unknown",
                msg_id: triggerMessage.messageId,
              },
            });
            contextJson = typeof resp === "string" ? JSON.parse(resp) : resp;
          } catch (e) {
            console.error("[clientRuntime] get_context failed:", e);
          }
        }

        // 2. Read persona from logos
        let personaLong = "";
        let personaMid = "";
        if (contextJson.persona_paths) {
          try {
            const r = await vfs.read({ path: contextJson.persona_paths.long });
            personaLong = r.content || "";
          } catch {}
          try {
            const r = await vfs.read({ path: contextJson.persona_paths.mid });
            personaMid = r.content || "";
          } catch {}
        }
        // Also read bot's own persona
        let botPersona = "";
        try {
          const r = await vfs.read({ path: `logos://users/${BOT_UID}/persona/long.md` });
          botPersona = r.content || "";
        } catch {}

        // 3. Build system prompt with logos context
        const systemPrompt = buildSystemPrompt(contextJson, botPersona, personaLong, personaMid);
        const messages = buildLlmMessages(triggerMessage, prompt, contextJson, systemPrompt);

        // 4. Stream from enclave, collect full reply
        let fullReply = "";
        for await (const event of enclaveClient.streamReply({
          chatId: triggerMessage.chatId,
          messages,
          imageUrls: triggerMessage.imageUrls,
        })) {
          if (event.type === "message_update" && event.role === "assistant" && event.delta) {
            fullReply += event.delta;
            stream.push(event.delta);
          } else if (event.type === "failed") {
            throw new Error(event.error);
          } else if (event.type === "completed") {
            break;
          }
        }

        // 5. Write bot reply back to logos memory (so next turn has context)
        if (fullReply.trim()) {
          try {
            await vfs.write({
              path: `logos://memory/groups/${triggerMessage.chatId}/messages`,
              content: JSON.stringify({
                msg_id: Date.now(),
                chat_id: String(triggerMessage.chatId),
                speaker: BOT_UID,
                text: fullReply,
                reply_to: triggerMessage.messageId,
                ts: new Date().toISOString(),
                mentions: "[]",
              }),
            });
          } catch (e) {
            console.error("[clientRuntime] failed to write bot reply:", e);
          }
        }

        stream.end();
      } catch (error) {
        stream.fail(error);
      }
    })();

    return stream;
  };

  return { recordMessage, streamReply };
}

function buildSystemPrompt(
  context: any,
  botPersona: string,
  senderPersonaLong: string,
  senderPersonaMid: string,
): string {
  let prompt = `You are an AI agent running on the Logos kernel.

## Core Rules
- Stay in character at all times. Never break the fourth wall.
- Be helpful through action, not pleasantries. Skip "Great question!" — just help.
- Have opinions. Disagree when warranted. A mindless agent is just a search engine.
- When using tools, work silently. Don't expose tool calls in your reply.
- Try to solve problems yourself before asking the user. Read files, check context, search.
- Protect private information. When unsure about external actions, ask first.

## Capabilities
You have 5 primitives: read, write, patch, exec, call — all through logos:// URIs.

Current time: ${new Date().toLocaleString("en-US", { timeZone: "Asia/Shanghai" })}`;

  if (botPersona) {
    prompt += `\n\n## Your Persona\n${botPersona}`;
  }

  if (senderPersonaLong || senderPersonaMid) {
    prompt += `\n\n## About the sender`;
    if (senderPersonaLong) prompt += `\n${senderPersonaLong}`;
    if (senderPersonaMid) prompt += `\n\nRecent: ${senderPersonaMid}`;
  }

  // Session context
  if (context.session?.messages?.length > 0) {
    prompt += "\n\n## Current Session\n";
    for (const m of context.session.messages.slice(-15)) {
      prompt += `[${m.speaker}]: ${m.text}\n`;
    }
  }

  // Recent summary
  if (context.recent_summary && context.recent_summary !== "null") {
    const summary = typeof context.recent_summary === "string"
      ? context.recent_summary
      : JSON.stringify(context.recent_summary);
    if (summary && summary !== "null") {
      prompt += `\n\n## Recent Summary\n${summary}`;
    }
  }

  return prompt;
}

function buildLlmMessages(
  trigger: TelegramMessage,
  prompt: string,
  context: any,
  systemPrompt: string,
): Array<{ role: string; content: string }> {
  const messages: Array<{ role: string; content: string }> = [];
  messages.push({ role: "system", content: systemPrompt });

  // Inject recent session as conversation history
  if (context.session?.messages) {
    for (const m of context.session.messages.slice(-10)) {
      const role = m.speaker === "assistant" ? "assistant" : "user";
      messages.push({ role, content: m.text });
    }
  }

  messages.push({ role: "user", content: prompt });
  return messages;
}
