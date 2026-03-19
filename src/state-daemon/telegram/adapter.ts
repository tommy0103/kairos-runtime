import { Bot, type Context } from "grammy";
import type {
  StreamState,
  TelegramAdapter,
  TelegramConversationType,
  TelegramMessage,
} from "./types";
import { markdownToTelegramHtml } from "./markdownToHtml";

const DEFAULT_PLACEHOLDER = "小猫正在玩毛线球...";
const DEFAULT_FINAL_TEXT = "(空内容)";
const EDIT_RETRY_ATTEMPTS = 3;
const EDIT_RETRY_DELAY_MS = 500;
const MEDIA_GROUP_FLUSH_DELAY_MS = 250;

export function createTelegramAdapter(token: string): TelegramAdapter {
  const bot = new Bot(token);
  const messages: TelegramMessage[] = [];
  const streams = new Map<number, StreamState>();
  const pendingMediaGroups = new Map<
    string,
    {
      ctx: Context;
      photoCount: number;
      photoFileIds: string[];
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  let nextStreamId = 1;
  const messageHandlers = new Set<
    (message: TelegramMessage) => void | Promise<void>
  >();
  const editedMessageHandlers = new Set<
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

  const dispatchMessage = (message: TelegramMessage) => {
    messages.push(message);
    for (const handler of messageHandlers) {
      void Promise.resolve(handler(message)).catch((error) => {
        console.error("telegram onMessage handler failed:", error);
      });
    }
  };

  const dispatchEditedMessage = (message: TelegramMessage) => {
    for (const handler of editedMessageHandlers) {
      void Promise.resolve(handler(message)).catch((error) => {
        console.error("telegram onEditedMessage handler failed:", error);
      });
    }
  };

  const reply: TelegramAdapter["reply"] = async (chatId, text, messageId) => {
    const sent = await sendMessage(chatId, text, messageId);
    const outgoing = toOutgoingTelegramMessage(sent);
    if (outgoing) {
      dispatchMessage(outgoing);
    }
  };

  const startStream: TelegramAdapter["startStream"] = async (
    chatId,
    messageId,
    // placeholder = DEFAULT_PLACEHOLDER,
  ) => {
    // const sent = await sendMessage(chatId, placeholder, messageId);
    const streamId = nextStreamId++;
    streams.set(streamId, {
      chatId,
      // placeholderMessageId: sent.message_id,
      // conversationType: toConversationType(sent.chat.type),
      // username: sent.from?.username ?? null,
      // replyToMessageId: sent.reply_to_message?.message_id ?? null,
      // replyToUserId: sent.reply_to_message?.from?.id?.toString() ?? null,
      conversationType: "private",
      username: null,
      replyToMessageId: messageId ?? null,
      replyToUserId: null,
      chunks: [],
    });
    console.log("startStream", streams.get(streamId));
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
      // Send as new message instead of editing placeholder
      const sent = await sendMessage(state.chatId, finalText, state.replyToMessageId ?? undefined);
      const outgoing = toOutgoingTelegramMessage(sent);
      if (outgoing) {
        dispatchMessage(outgoing);
      }

      // Original edit-based approach (commented out):
      // let finalMessage;
      // try {
      //   const htmlText = markdownToTelegramHtml(finalText);
      //   finalMessage = await retry(
      //     () => bot.api.editMessageText(
      //       state.chatId,
      //       state.placeholderMessageId,
      //       htmlText,
      //       { parse_mode: "HTML" }
      //     ),
      //     EDIT_RETRY_ATTEMPTS,
      //     EDIT_RETRY_DELAY_MS
      //   );
      // } catch {
      //   console.warn("HTML formatting failed, falling back to plain text");
      //   finalMessage = await retry(
      //     () => bot.api.editMessageText(
      //       state.chatId,
      //       state.placeholderMessageId,
      //       finalText,
      //     ),
      //     EDIT_RETRY_ATTEMPTS,
      //     EDIT_RETRY_DELAY_MS
      //   );
      // }
      // const outgoing = toEditedResultMessage(finalMessage, state, finalText);
      // if (outgoing) {
      //   dispatchMessage(outgoing);
      // }

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

  const onEditedMessage: TelegramAdapter["onEditedMessage"] = (handler) => {
    editedMessageHandlers.add(handler);
    return () => {
      editedMessageHandlers.delete(handler);
    };
  };

  const flushMediaGroup = async (key: string) => {
    const pending = pendingMediaGroups.get(key);
    if (!pending) {
      return;
    }
    pendingMediaGroups.delete(key);

    const message = toTelegramMessage(pending.ctx, pending.photoCount);
    if (!message) {
      return;
    }
    message.imageUrls = await resolvePhotoUrlsByFileIds(pending.photoFileIds, bot, token);
    dispatchMessage(message);
  };

  const queueMediaGroupMessage = (ctx: Context, mediaGroupId: string) => {
    const chatId = ctx.chat?.id;
    const message = ctx.message;
    if (!chatId) {
      return;
    }
    if (!message) {
      return;
    }
    const key = `${chatId}:${mediaGroupId}`;
    const photos = message.photo;
    const hasPhoto = (photos?.length ?? 0) > 0;
    const largestFileId = hasPhoto ? photos![photos!.length - 1].file_id : undefined;
    const incomingContext =
      "text" in message ? (message.text ?? "") : (message.caption ?? "");
    const pending = pendingMediaGroups.get(key);

    if (!pending) {
      const timer = setTimeout(() => {
        flushMediaGroup(key);
      }, MEDIA_GROUP_FLUSH_DELAY_MS);
      pendingMediaGroups.set(key, {
        ctx,
        photoCount: hasPhoto ? 1 : 0,
        photoFileIds: largestFileId ? [largestFileId] : [],
        timer,
      });
      return;
    }

    clearTimeout(pending.timer);
    pending.photoCount += hasPhoto ? 1 : 0;
    if (largestFileId) {
      pending.photoFileIds.push(largestFileId);
    }
    const pendingMessage = pending.ctx.message;
    const pendingContext = pendingMessage
      ? ("text" in pendingMessage
          ? (pendingMessage.text ?? "")
          : (pendingMessage.caption ?? ""))
      : "";
    if (incomingContext && !pendingContext) {
      pending.ctx = ctx;
    }
    pending.timer = setTimeout(() => {
      flushMediaGroup(key);
    }, MEDIA_GROUP_FLUSH_DELAY_MS);
  };

  bot.on("message", async (ctx, next) => {
    const mediaGroupId = ctx.message?.media_group_id;
    if (mediaGroupId) {
      queueMediaGroupMessage(ctx, mediaGroupId);
      await next();
      return;
    }

    const message = toTelegramMessage(ctx);
    if (!message) {
      return;
    }

    message.imageUrls = await resolvePhotoUrls(ctx.message?.photo, bot, token);
    dispatchMessage(message);

    await next();
  });

  bot.on("edited_message", async (ctx, next) => {
    const message = toEditedTelegramMessage(ctx);
    if (!message) {
      return;
    }
    dispatchEditedMessage(message);
    await next();
  });

  return {
    start: async () => {
      await bot.start();
    },
    stop: () => {
      for (const pending of pendingMediaGroups.values()) {
        clearTimeout(pending.timer);
      }
      pendingMediaGroups.clear();
      bot.stop();
    },
    getMessages: () => [...messages],
    onMessage,
    onEditedMessage,
    reply,
    startStream,
    appendStream,
    endStream,
  };
}

function toTelegramMessage(ctx: Context, photoCountOverride?: number): TelegramMessage | null {
  const chat = ctx.chat;
  const message = ctx.message;
  if (!chat || !message) {
    return null;
  }

  const context = "text" in message ? (message.text ?? "") : (message.caption ?? "");
  const stickerEmoji = message.sticker?.emoji ?? "";
  const photoCount = photoCountOverride ?? ((message.photo?.length ?? 0) > 0 ? 1 : 0);
  const photoPlaceholder =
    photoCount <= 0 ? "" : photoCount === 1 ? "[photo]" : `[photo x${photoCount}]`;

  return {
    userId: message.from?.id?.toString() ?? "unknown",
    messageId: message.message_id,
    chatId: chat.id,
    conversationType: toConversationType(chat.type),
    context: `${stickerEmoji}${context}${photoPlaceholder}`,
    timestamp: (message.date ?? Math.floor(Date.now() / 1000)) * 1000,
    metadata: {
      isBot: message.from?.is_bot ?? false,
      username: message.from?.username ?? message.from?.first_name ?? null,
      replyToMessageId: message.reply_to_message?.message_id ?? null,
      replyToUserId: message.reply_to_message?.from?.id?.toString() ?? null,
      isReplyToMe: message.reply_to_message?.from?.id === ctx.me.id,
      isMentionMe: isMentionMe(ctx),
      mentions: extractMentions(message),
    },
  };
}

function toEditedTelegramMessage(ctx: Context): TelegramMessage | null {
  const chat = ctx.chat;
  const message = ctx.editedMessage;
  if (!chat || !message) {
    return null;
  }

  const context = "text" in message ? (message.text ?? "") : (message.caption ?? "");
  const stickerEmoji = message.sticker?.emoji ?? "";
  const photoCount = (message.photo?.length ?? 0) > 0 ? 1 : 0;
  const photoPlaceholder = photoCount <= 0 ? "" : "[photo]";

  return {
    userId: message.from?.id?.toString() ?? "unknown",
    messageId: message.message_id,
    chatId: chat.id,
    conversationType: toConversationType(chat.type),
    context: `${stickerEmoji}${context}${photoPlaceholder}`,
    timestamp: (message.date ?? Math.floor(Date.now() / 1000)) * 1000,
    metadata: {
      isBot: message.from?.is_bot ?? false,
      username: message.from?.username ?? message.from?.first_name ?? null,
      replyToMessageId: message.reply_to_message?.message_id ?? null,
      replyToUserId: message.reply_to_message?.from?.id?.toString() ?? null,
      isReplyToMe: message.reply_to_message?.from?.id === ctx.me.id,
      isMentionMe: isMentionMeEdited(ctx),
      mentions: extractMentionsFromTextWithEntities(
        "text" in message ? (message.text ?? "") : "",
        message.entities
      ),
    },
  };
}

function toOutgoingTelegramMessage(
  message: Awaited<ReturnType<Bot["api"]["sendMessage"]>>
): TelegramMessage | null {
  if (!message?.chat) {
    return null;
  }
  const context = message.text ?? "";
  return {
    userId: message.from?.id?.toString() ?? "bot",
    messageId: message.message_id,
    chatId: message.chat.id,
    conversationType: toConversationType(message.chat.type),
    context,
    timestamp: (message.date ?? Math.floor(Date.now() / 1000)) * 1000,
    metadata: {
      isBot: message.from?.is_bot ?? true,
      username: message.from?.username ?? null,
      replyToMessageId: message.reply_to_message?.message_id ?? null,
      replyToUserId: message.reply_to_message?.from?.id?.toString() ?? null,
      isReplyToMe: false,
      isMentionMe: false,
      mentions: [],
    },
  };
}

function toEditedResultMessage(
  result: Awaited<ReturnType<Bot["api"]["editMessageText"]>>,
  state: StreamState,
  finalText: string
): TelegramMessage | null {
  const baseMetadata = {
    isBot: true,
    replyToMessageId: state.replyToMessageId,
    replyToUserId: state.replyToUserId,
    isReplyToMe: false,
    isMentionMe: false,
    mentions: [] as string[],
  };

  if (result === true) {
    return {
      userId: "bot",
      messageId: state.placeholderMessageId,
      chatId: state.chatId,
      conversationType: state.conversationType,
      context: finalText,
      timestamp: Date.now(),
      metadata: {
        ...baseMetadata,
        username: state.username,
      },
    };
  }

  return {
    userId: result.from?.id?.toString() ?? "bot",
    messageId: result.message_id,
    chatId: result.chat.id,
    conversationType: state.conversationType,
    context: finalText ?? result.text ?? "",
    timestamp: (result.date ?? Math.floor(Date.now() / 1000)) * 1000,
    metadata: {
      ...baseMetadata,
      username: result.from?.username ?? state.username,
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
  const message = ctx.msg;
  if (!message) {
    return false;
  }
  const text = message.text ?? message.caption ?? "";
  return text.includes(`@${ctx.me.username}`);
}

function isMentionMeEdited(ctx: Context): boolean {
  const message = ctx.editedMessage;
  if (!message) {
    return false;
  }
  const text = message.text ?? message.caption ?? "";
  return text.includes(`@${ctx.me.username}`);
}

function extractMentions(message: NonNullable<Context["message"]>): string[] {
  const textMentions = extractMentionsFromTextWithEntities(
    message.text ?? "",
    message.entities
  );
  const captionMentions = extractMentionsFromTextWithEntities(
    message.caption ?? "",
    message.caption_entities
  );
  return Array.from(new Set([...textMentions, ...captionMentions]));
}

function extractMentionsFromTextWithEntities(
  text: string,
  entities?: ReadonlyArray<{ type: string; offset: number; length: number }>
): string[] {
  if (!text || !entities?.length) {
    return [];
  }
  const mentions: string[] = [];
  for (const entity of entities) {
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

async function resolvePhotoUrls(
  photos: ReadonlyArray<{ file_id: string }> | undefined,
  bot: Bot,
  token: string
): Promise<string[]> {
  if (!photos?.length) {
    return [];
  }
  const largest = photos[photos.length - 1];
  return resolvePhotoUrlsByFileIds([largest.file_id], bot, token);
}

async function resolvePhotoUrlsByFileIds(
  fileIds: string[],
  bot: Bot,
  token: string
): Promise<string[]> {
  const urls: string[] = [];
  for (const fileId of fileIds) {
    try {
      const file = await bot.api.getFile(fileId);
      if (file.file_path) {
        urls.push(`https://api.telegram.org/file/bot${token}/${file.file_path}`);
      }
    } catch (error) {
      console.error("resolvePhotoUrl failed for fileId:", fileId, error);
    }
  }
  return urls;
}

