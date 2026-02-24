import { Bot, type Context } from "grammy";
import type {
  StreamState,
  TelegramAdapter,
  TelegramConversationType,
  TelegramMessage,
} from "./types";

const DEFAULT_PLACEHOLDER = "小猫正在玩毛线球...";
const DEFAULT_FINAL_TEXT = "(空内容)";
const EDIT_RETRY_ATTEMPTS = 3;
const EDIT_RETRY_DELAY_MS = 500;

export function createTelegramAdapter(token: string): TelegramAdapter {
  const bot = new Bot(token);
  const messages: TelegramMessage[] = [];
  const streams = new Map<number, StreamState>();
  let nextStreamId = 1;
  const messageHandlers = new Set<
    (message: TelegramMessage) => void | Promise<void>
  >();
  const sendMessage = (
    chatId: number,
    text: string,
    messageId?: number
  ) => {
    const resolvedMessageId = toOptionalMessageId(messageId);
    if (resolvedMessageId === undefined) {
      return bot.api.sendMessage(chatId, text);
    }
    return bot.api.sendMessage(chatId, text, {
      reply_to_message_id: resolvedMessageId,
    });
  };

  const reply: TelegramAdapter["reply"] = async (chatId, text, messageId) => {
    await sendMessage(chatId, text, messageId);
  };

  const startStream: TelegramAdapter["startStream"] = async (
    chatId,
    messageId,
    placeholder = DEFAULT_PLACEHOLDER,
  ) => {
    const sent = await sendMessage(chatId, placeholder, messageId);
    const streamId = nextStreamId++;
    streams.set(streamId, {
      chatId,
      placeholderMessageId: sent.message_id,
      chunks: [],
    });
    return streamId;
  };

  const appendStream: TelegramAdapter["appendStream"] = (streamId, chunk) => {
    const state = streams.get(streamId);
    if (!state) {
      throw new Error(`stream not started for streamId: ${streamId}`);
    }
    state.chunks.push(chunk);
  };

  const endStream: TelegramAdapter["endStream"] = async (streamId) => {
    const state = streams.get(streamId);
    if (!state) {
      throw new Error(`stream not started for streamId: ${streamId}`);
    }

    const finalText = state.chunks.join("") || DEFAULT_FINAL_TEXT;
    try {
      await retry(
        () =>
          bot.api.editMessageText(
            state.chatId,
            state.placeholderMessageId,
            finalText
          ),
        EDIT_RETRY_ATTEMPTS,
        EDIT_RETRY_DELAY_MS
      );
      return finalText;
    } finally {
      streams.delete(streamId);
    }
  };

  const onMessage: TelegramAdapter["onMessage"] = (handler) => {
    messageHandlers.add(handler);
    return () => {
      messageHandlers.delete(handler);
    };
  };

  bot.on("message", async (ctx, next) => {
    // console.log("message arrived", ctx.msg.text);
    const message = toTelegramMessage(ctx);
    if (!message) {
      return;
    }

    messages.push(message);
    for (const handler of messageHandlers) {
      void Promise.resolve(handler(message)).catch((error) => {
        console.error("telegram onMessage handler failed:", error);
      });
    }

    await next();
  });

  return {
    start: async () => {
      await bot.start();
    },
    stop: () => {
      bot.stop();
    },
    getMessages: () => [...messages],
    onMessage,
    reply,
    startStream,
    appendStream,
    endStream,
  };
}

function toTelegramMessage(ctx: Context): TelegramMessage | null {
  const chat = ctx.chat;
  const message = ctx.message;
  if (!chat || !message) {
    return null;
  }

  const context = "text" in message ? (message.text ?? "") : (message.caption ?? "");

  return {
    userId: message.from?.id?.toString() ?? "unknown",
    messageId: message.message_id,
    chatId: chat.id,
    conversationType: toConversationType(chat.type),
    context,
    timestamp: (message.date ?? Math.floor(Date.now() / 1000)) * 1000,
    metadata: {
      isBot: message.from?.is_bot ?? false,
      username: message.from?.username ?? null,
      replyToMessageId: message.reply_to_message?.message_id ?? null,
      replyToUserId: message.reply_to_message?.from?.id?.toString() ?? null,
      isReplyToMe: message.reply_to_message?.from?.id === ctx.me.id,
      isMentionMe: isMentionMe(ctx),
      mentions: extractMentions(message),
    },
  };
}

function toConversationType(type: string): TelegramConversationType {
  if (
    type === "private" ||
    type === "group" ||
    type === "supergroup" ||
    type === "channel"
  ) {
    return type;
  }
  return "private";
}

function toOptionalMessageId(messageId?: number | string): number | undefined {
  if (messageId === undefined || messageId === null) {
    return undefined;
  }
  if (typeof messageId === "number" && Number.isFinite(messageId)) {
    return messageId;
  }
  if (typeof messageId === "string" && /^\d+$/.test(messageId)) {
    return Number(messageId);
  }
  throw new Error(`invalid messageId: ${String(messageId)}`);
}

function isMentionMe(ctx: Context): boolean {
//   const text = ctx.msg.text ?? "";
    const message = ctx.msg;
    if (!message) {
        return false;
    }
    const text = message.text ?? "";
    return text.includes(`@${ctx.me.username}`);
}

function extractMentions(message: NonNullable<Context["message"]>): string[] {
  const text = "text" in message ? (message.text ?? "") : "";
  if (!text || !message.entities?.length) {
    return [];
  }

  const mentions: string[] = [];
  for (const entity of message.entities) {
    if (entity.type !== "mention") {
      continue;
    }
    const mention = text.slice(entity.offset, entity.offset + entity.length);
    if (mention) {
      mentions.push(mention.toLowerCase());
    }
  }
  return mentions;
}

async function retry<T>(
  action: () => Promise<T>,
  attempts: number,
  delayMs: number
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await action();
    } catch (error) {
      lastError = error;
      if (!isRetryableNetworkError(error)) {
        throw error;
      }
      if (attempt === attempts) {
        break;
      }
      await sleep(delayMs * attempt);
    }
  }
  throw lastError;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableNetworkError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const maybeError = error as { code?: unknown; message?: unknown };
  const code = typeof maybeError.code === "string" ? maybeError.code : "";
  const message = typeof maybeError.message === "string" ? maybeError.message : "";
  const retryableCodes = new Set(["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EHOSTUNREACH"]);
  if (retryableCodes.has(code)) {
    return true;
  }
  const lowerMessage = message.toLowerCase();
  return (
    lowerMessage.includes("socket connection was closed unexpectedly") ||
    lowerMessage.includes("network request") ||
    lowerMessage.includes("fetch failed") ||
    lowerMessage.includes("network error")
  );
}
