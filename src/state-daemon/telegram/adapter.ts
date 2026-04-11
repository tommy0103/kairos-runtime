import { Bot, type Context } from "grammy";
import type {
  StreamState,
  TelegramAdapter,
  TelegramConversationType,
  TelegramMessage,
} from "./types";
import { markdownToTelegramHtml } from "./markdownToHtml";
import { createCustomEmojiToTextResolver } from "./custom-emoji-to-text";
import { createImageAltTextStore } from "./image-to-text-store";
import type { CustomEmojiToTextConfig } from "./index";

const DEFAULT_FINAL_TEXT = "(empty)";
const DEFAULT_STREAM_PLACEHOLDER = "Working on it... estimated 30-90 seconds.";
const EDIT_RETRY_ATTEMPTS = 3;
const EDIT_RETRY_DELAY_MS = 500;
const STREAM_EDIT_THROTTLE_MS = 900;
const MEDIA_GROUP_FLUSH_DELAY_MS = 250;

type TelegramTextEntity = {
  type: string;
  offset: number;
  length: number;
  custom_emoji_id?: string;
};

interface CustomEmojiOccurrence {
  customEmojiId: string;
  fallbackEmoji: string;
  offset: number;
  length: number;
}

interface ResolvedCustomEmojiInfo {
  packName?: string;
  altText?: string;
  errorText?: string;
}

type CustomEmojiRenderer = (
  text: string,
  entities?: ReadonlyArray<TelegramTextEntity>
) => Promise<string>;

export function createTelegramAdapter(
  token: string,
  customEmojiToTextConfig?: CustomEmojiToTextConfig
): TelegramAdapter {
  const bot = new Bot(token);
  const messages: TelegramMessage[] = [];
  const streams = new Map<number, StreamState>();
  const typingIntervals = new Map<number, ReturnType<typeof setInterval>>();
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
  const customEmojiStore = createImageAltTextStore(customEmojiToTextConfig?.dbPath);
  customEmojiStore.hydrate();

  const customEmojiResolver = createCustomEmojiToTextResolver({
    enabled: customEmojiToTextConfig?.enabled ?? false,
    model: customEmojiToTextConfig?.model
      ? {
          model: customEmojiToTextConfig.model,
          baseURL: customEmojiToTextConfig.baseURL,
          apiKey: customEmojiToTextConfig.apiKey,
        }
      : undefined,
    maxConcurrency: customEmojiToTextConfig?.maxConcurrency,
    maxFrames: customEmojiToTextConfig?.maxFrames,
    lookupByHash: customEmojiStore.lookupByHash,
    persist: customEmojiStore.persist,
    getCustomEmojiStickers: async (customEmojiIds) => {
      const stickers = await bot.api.getCustomEmojiStickers(customEmojiIds);
      return stickers
        .map((sticker) => {
          const id =
            typeof (sticker as { custom_emoji_id?: unknown }).custom_emoji_id === "string"
              ? (sticker as { custom_emoji_id: string }).custom_emoji_id
              : undefined;
          if (!id) {
            return null;
          }
          return {
            id,
            file_id: sticker.file_id,
            is_animated: sticker.is_animated,
            is_video: sticker.is_video,
            mime_type: (sticker as { mime_type?: string }).mime_type,
            set_name: sticker.set_name,
          };
        })
        .filter((item): item is NonNullable<typeof item> => item !== null);
    },
    downloadFile: async (fileId) => {
      const file = await bot.api.getFile(fileId);
      if (!file.file_path) {
        throw new Error(`file_path missing for file_id: ${fileId}`);
      }
      const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`download custom emoji failed (${response.status})`);
      }
      const bytes = await response.arrayBuffer();
      return Buffer.from(bytes);
    },
    resolvePackTitle: async (setName) => {
      try {
        const stickerSet = await bot.api.getStickerSet(setName);
        const title = stickerSet.title?.trim();
        return title || setName;
      } catch {
        return setName;
      }
    },
  });

  const renderCustomEmojiText: CustomEmojiRenderer = async (text, entities) => {
    if (!text || !entities?.length) {
      return text;
    }
    const occurrences = extractCustomEmojiOccurrences(text, entities);
    if (occurrences.length === 0) {
      return text;
    }
    const emojiIds = new Map<string, string>();
    for (const occurrence of occurrences) {
      if (!emojiIds.has(occurrence.customEmojiId)) {
        emojiIds.set(occurrence.customEmojiId, occurrence.fallbackEmoji);
      }
    }
    await customEmojiResolver.resolve(emojiIds);

    const infoById = new Map<string, ResolvedCustomEmojiInfo>();
    for (const [id] of emojiIds) {
      infoById.set(id, {
        packName: customEmojiResolver.getPackName(id),
        altText: customEmojiResolver.getAltText(id),
        errorText: customEmojiResolver.getError(id),
      });
    }
    return renderTextWithCustomEmojiTags(text, occurrences, infoById);
  };

  const setTyping = async (chatId: number) => {
    try {
      await bot.api.sendChatAction(chatId, "typing");
    } catch (e) {
      // Ignore chat-action errors.
    }
  };

  const toTelegramPayload = (text: string): { body: string; parseMode?: "HTML" } => {
    let htmlText: string | null = null;
    try {
      htmlText = markdownToTelegramHtml(text);
    } catch {
      // fall through
    }
    if (htmlText) {
      return { body: htmlText, parseMode: "HTML" };
    }
    return { body: text };
  };

  const sendMessage = (
    chatId: number,
    text: string,
    messageId?: number
  ) => {
    const payload = toTelegramPayload(text);
    const opts: Record<string, unknown> = {};
    if (payload.parseMode) opts.parse_mode = payload.parseMode;
    const resolvedMessageId = toOptionalMessageId(messageId);
    if (resolvedMessageId !== undefined) {
      opts.reply_to_message_id = resolvedMessageId;
    }
    return bot.api.sendMessage(chatId, payload.body, opts as any);
  };

  const editStreamMessageText = async (state: StreamState, text: string) => {
    const placeholderMessageId = state.placeholderMessageId;
    if (placeholderMessageId == null) {
      return null;
    }
    const payload = toTelegramPayload(text);
    const opts: Record<string, unknown> = {};
    if (payload.parseMode) {
      opts.parse_mode = payload.parseMode;
    }
    return retry(
      () =>
        bot.api.editMessageText(
          state.chatId,
          placeholderMessageId,
          payload.body,
          opts as any
        ),
      EDIT_RETRY_ATTEMPTS,
      EDIT_RETRY_DELAY_MS
    );
  };

  const deleteStreamMessage = async (state: StreamState): Promise<void> => {
    if (!state.placeholderMessageId) {
      return;
    }
    try {
      await bot.api.deleteMessage(state.chatId, state.placeholderMessageId);
    } catch (error) {
      console.warn("telegram delete placeholder failed:", error);
    }
  };

  const renderStreamPreview = (state: StreamState): string => {
    const content = state.chunks.join("");
    if (content) {
      if (state.statusText) {
        return `${state.statusText}\n\n${content}\n\n...`;
      }
      return `${content}\n\n...`;
    }
    return state.statusText ?? DEFAULT_STREAM_PLACEHOLDER;
  };

  const flushStreamPreview = async (streamId: number, force = false) => {
    const state = streams.get(streamId);
    if (!state || !state.placeholderMessageId) {
      return;
    }
    const now = Date.now();
    if (!force && now - state.lastFlushAtMs < STREAM_EDIT_THROTTLE_MS) {
      return;
    }
    const previewText = renderStreamPreview(state);
    if (!previewText || previewText === state.lastRenderedText) {
      return;
    }
    state.lastFlushAtMs = now;
    try {
      await editStreamMessageText(state, previewText);
      state.lastRenderedText = previewText;
    } catch (error) {
      if (isTelegramMessageNotModifiedError(error)) {
        state.lastRenderedText = previewText;
        return;
      }
      console.error("telegram stream preview edit failed:", error);
    }
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
    placeholder,
  ) => {
    // Set native typing status.
    void setTyping(chatId);
    const streamId = nextStreamId++;

    // Send typing indicator and repeat every 4s (Telegram clears it after 5s)
    bot.api.sendChatAction(chatId, "typing").catch(() => {});
    const typingInterval = setInterval(() => {
      bot.api.sendChatAction(chatId, "typing").catch(() => {});
    }, 4000);
    typingIntervals.set(streamId, typingInterval);

    const initialStatus = (placeholder?.trim() || DEFAULT_STREAM_PLACEHOLDER).trim();
    let placeholderMessageId: number | null = null;
    let conversationType: TelegramConversationType = "private";
    let username: string | null = null;
    try {
      const sent = await sendMessage(chatId, initialStatus, messageId ?? undefined);
      placeholderMessageId = sent.message_id;
      conversationType = toConversationType(sent.chat.type);
      username = sent.from?.username ?? null;
    } catch (error) {
      console.error("telegram startStream placeholder send failed:", error);
    }

    streams.set(streamId, {
      chatId,
      placeholderMessageId,
      conversationType,
      username,
      replyToMessageId: messageId ?? null,
      replyToUserId: null,
      statusText: initialStatus,
      lastRenderedText: placeholderMessageId ? initialStatus : "",
      lastFlushAtMs: Date.now(),
      chunks: [],
    });
    return streamId;
  };

  const setStreamStatus: TelegramAdapter["setStreamStatus"] = async (
    streamId,
    status
  ) => {
    const state = streams.get(streamId);
    if (!state) {
      throw new Error(`stream not started for streamId: ${streamId}`);
    }
    const normalized = status.trim();
    if (!normalized || normalized === state.statusText) {
      return;
    }
    state.statusText = normalized;
    await flushStreamPreview(streamId, true);
  };

  const appendStream: TelegramAdapter["appendStream"] = (streamId, chunk) => {
    const state = streams.get(streamId);
    if (!state) {
      throw new Error(`stream not started for streamId: ${streamId}`);
    }
    state.chunks.push(chunk);
    // Refresh typing status every 5 chunks.
    if (state.chunks.length % 5 === 0) {
      void setTyping(state.chatId);
    }
    void flushStreamPreview(streamId);
  };

  const endStream: TelegramAdapter["endStream"] = async (streamId) => {
    const interval = typingIntervals.get(streamId);
    if (interval) {
      clearInterval(interval);
      typingIntervals.delete(streamId);
    }

    const state = streams.get(streamId);
    if (!state) {
      throw new Error(`stream not started for streamId: ${streamId}`);
    }

    const finalText = state.chunks.join("") || DEFAULT_FINAL_TEXT;

    try {
      if (state.placeholderMessageId) {
        await deleteStreamMessage(state);
      }

      const sent = await sendMessage(
        state.chatId,
        finalText,
        state.replyToMessageId ?? undefined
      );
      const outgoing = toOutgoingTelegramMessage(sent);
      if (outgoing) {
        dispatchMessage(outgoing);
      }
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

    const message = await toTelegramMessage(
      pending.ctx,
      renderCustomEmojiText,
      pending.photoCount
    );
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

    const message = await toTelegramMessage(ctx, renderCustomEmojiText);
    if (!message) {
      return;
    }

    message.imageUrls = await resolvePhotoUrls(ctx.message?.photo, bot, token);
    dispatchMessage(message);

    await next();
  });

  bot.on("edited_message", async (ctx, next) => {
    const message = await toEditedTelegramMessage(ctx, renderCustomEmojiText);
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
    setStreamStatus,
    appendStream,
    endStream,
  };
}

async function toTelegramMessage(
  ctx: Context,
  renderCustomEmojiText: CustomEmojiRenderer,
  photoCountOverride?: number
): Promise<TelegramMessage | null> {
  const chat = ctx.chat;
  const message = ctx.message;
  if (!chat || !message) {
    return null;
  }

  const rawContext = "text" in message ? (message.text ?? "") : (message.caption ?? "");
  const rawEntities = ("text" in message ? message.entities : message.caption_entities) as
    | ReadonlyArray<TelegramTextEntity>
    | undefined;
  const context = await renderCustomEmojiText(rawContext, rawEntities);
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

async function toEditedTelegramMessage(
  ctx: Context,
  renderCustomEmojiText: CustomEmojiRenderer
): Promise<TelegramMessage | null> {
  const chat = ctx.chat;
  const message = ctx.editedMessage;
  if (!chat || !message) {
    return null;
  }

  const rawContext = "text" in message ? (message.text ?? "") : (message.caption ?? "");
  const rawEntities = ("text" in message ? message.entities : message.caption_entities) as
    | ReadonlyArray<TelegramTextEntity>
    | undefined;
  const context = await renderCustomEmojiText(rawContext, rawEntities);
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
    if (!state.placeholderMessageId) {
      return null;
    }
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
  entities?: ReadonlyArray<TelegramTextEntity>
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

function extractCustomEmojiOccurrences(
  text: string,
  entities: ReadonlyArray<TelegramTextEntity>
): CustomEmojiOccurrence[] {
  const occurrences: CustomEmojiOccurrence[] = [];
  for (const entity of entities) {
    if (entity.type !== "custom_emoji" || !entity.custom_emoji_id) {
      continue;
    }
    const fallbackEmoji = text.slice(entity.offset, entity.offset + entity.length);
    if (!fallbackEmoji) {
      continue;
    }
    occurrences.push({
      customEmojiId: entity.custom_emoji_id,
      fallbackEmoji,
      offset: entity.offset,
      length: entity.length,
    });
  }
  return occurrences;
}

function renderTextWithCustomEmojiTags(
  text: string,
  occurrences: CustomEmojiOccurrence[],
  infoById: Map<string, ResolvedCustomEmojiInfo>
): string {
  if (occurrences.length === 0) {
    return text;
  }

  const sorted = [...occurrences].sort((a, b) => b.offset - a.offset);
  let rendered = text;
  for (const occurrence of sorted) {
    const info = infoById.get(occurrence.customEmojiId);
    const attrs = [`id="${escapeXmlAttribute(occurrence.customEmojiId)}"`];
    const errorText = info?.errorText;
    const altText = info?.altText?.trim() || undefined;
    const effectiveAlt = altText || (errorText ? `[${errorText}]` : undefined);
    if (info?.packName) {
      attrs.push(`pack="${escapeXmlAttribute(info.packName)}"`);
    }
    if (effectiveAlt) {
      attrs.push(`alt="${escapeXmlAttribute(effectiveAlt)}"`);
    }
    if (errorText) {
      attrs.push('error="true"');
    }
    const textContent = errorText
      ? occurrence.fallbackEmoji
      : (altText || occurrence.fallbackEmoji);
    const replacement = `<custom-emoji ${attrs.join(" ")}>${escapeXmlText(textContent)}</custom-emoji>`;
    rendered =
      rendered.slice(0, occurrence.offset) +
      replacement +
      rendered.slice(occurrence.offset + occurrence.length);
  }
  return rendered;
}

function escapeXmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("\"", "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeXmlText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
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

function isTelegramMessageNotModifiedError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const message = (error as { message?: unknown }).message;
  if (typeof message !== "string") {
    return false;
  }
  return message.toLowerCase().includes("message is not modified");
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
