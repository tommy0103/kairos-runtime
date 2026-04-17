import { Bot, InputFile, type Context } from "grammy";
import type {
  StreamState,
  TelegramAdapter,
  TelegramConversationType,
  TelegramMessage,
  TelegramOutgoingMediaItem,
  TelegramSendMediaBatchResult,
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
  user?: {
    id?: number | string;
  };
};

type TelegramIncomingMessageLike = {
  text?: string;
  caption?: string;
  photo?: ReadonlyArray<unknown>;
  sticker?: {
    emoji?: string;
  };
  document?: unknown;
  audio?: unknown;
  voice?: unknown;
  video?: unknown;
  animation?: unknown;
  reply_to_message?: {
    text?: string;
    caption?: string;
    photo?: ReadonlyArray<unknown>;
    sticker?: {
      emoji?: string;
    };
    document?: unknown;
    audio?: unknown;
    voice?: unknown;
    video?: unknown;
    animation?: unknown;
    from?: {
      id?: number | string;
      first_name?: string;
      last_name?: string;
      username?: string;
    };
  };
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
  const messageAuthorByChat = new Map<number, Map<number, string>>();
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
  let botUserId: string | null = null;
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

  const rememberMessageAuthor = (
    chatId: number,
    messageId: number,
    userId: string | null | undefined
  ): void => {
    const normalized = (userId ?? "").trim();
    if (!Number.isFinite(chatId) || !Number.isFinite(messageId) || !normalized || normalized === "unknown" || normalized === "bot") {
      return;
    }
    let bucket = messageAuthorByChat.get(chatId);
    if (!bucket) {
      bucket = new Map<number, string>();
      messageAuthorByChat.set(chatId, bucket);
    }
    bucket.set(messageId, normalized);
  };

  const getRememberedMessageAuthor = (chatId: number, messageId: number): string | null => {
    return messageAuthorByChat.get(chatId)?.get(messageId) ?? null;
  };

  const hydrateReplyMetadata = (message: TelegramMessage): TelegramMessage => {
    const replyToMessageId = message.metadata.replyToMessageId;
    let replyToUserId = message.metadata.replyToUserId;
    if (replyToMessageId !== null && !replyToUserId) {
      replyToUserId = getRememberedMessageAuthor(message.chatId, replyToMessageId);
    }
    let replyToUsername = message.metadata.replyToUsername ?? null;
    if (!replyToUsername && replyToUserId) {
      replyToUsername = replyToUserId;
    }

    const isOwnMessage =
      message.userId === "bot" ||
      (botUserId !== null && message.userId === botUserId);
    let isReplyToMe = message.metadata.isReplyToMe;
    if (!isOwnMessage && replyToUserId && botUserId) {
      isReplyToMe = replyToUserId === botUserId;
    }

    if (
      replyToUserId === message.metadata.replyToUserId &&
      replyToUsername === (message.metadata.replyToUsername ?? null) &&
      isReplyToMe === message.metadata.isReplyToMe
    ) {
      return message;
    }

    return {
      ...message,
      metadata: {
        ...message.metadata,
        replyToUserId,
        replyToUsername,
        isReplyToMe,
      },
    };
  };

  const rememberMessageAuthorsFromPayload = (message: TelegramMessage): void => {
    const effectiveUserId =
      message.userId === "bot"
        ? botUserId
        : message.userId;
    rememberMessageAuthor(message.chatId, message.messageId, effectiveUserId);
    if (message.metadata.replyToMessageId !== null && message.metadata.replyToUserId) {
      rememberMessageAuthor(
        message.chatId,
        message.metadata.replyToMessageId,
        message.metadata.replyToUserId,
      );
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
    const hydrated = hydrateReplyMetadata(message);
    rememberMessageAuthorsFromPayload(hydrated);
    messages.push(hydrated);
    for (const handler of messageHandlers) {
      void Promise.resolve(handler(hydrated)).catch((error) => {
        console.error("telegram onMessage handler failed:", error);
      });
    }
  };

  const dispatchEditedMessage = (message: TelegramMessage) => {
    const hydrated = hydrateReplyMetadata(message);
    rememberMessageAuthorsFromPayload(hydrated);
    for (const handler of editedMessageHandlers) {
      void Promise.resolve(handler(hydrated)).catch((error) => {
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

  const sendMediaItem = async (
    chatId: number,
    item: TelegramOutgoingMediaItem,
    options?: { caption?: string; replyToMessageId?: number }
  ) => {
    const mediaInput = toTelegramMediaInput(item.source, item.fileName);
    const payload = options?.caption ? toTelegramPayload(options.caption) : null;
    const mediaOptions: Record<string, unknown> = {};
    if (payload?.body) {
      mediaOptions.caption = payload.body;
    }
    if (payload?.parseMode) {
      mediaOptions.parse_mode = payload.parseMode;
    }
    const resolvedReplyTo = toOptionalMessageId(options?.replyToMessageId);
    if (resolvedReplyTo !== undefined) {
      mediaOptions.reply_to_message_id = resolvedReplyTo;
    }

    if (item.type === "image") {
      return bot.api.sendPhoto(chatId, mediaInput as any, mediaOptions as any);
    }
    if (item.type === "audio") {
      return bot.api.sendAudio(chatId, mediaInput as any, mediaOptions as any);
    }
    return bot.api.sendDocument(chatId, mediaInput as any, mediaOptions as any);
  };

  const sendMediaBatch: TelegramAdapter["sendMediaBatch"] = async (
    chatId,
    items,
    options
  ) => {
    const result: TelegramSendMediaBatchResult = {
      sentCount: 0,
      failures: [],
    };

    if (!Array.isArray(items) || items.length === 0) {
      return result;
    }

    const groups = splitMediaItemsByType(items);
    let caption = options?.caption?.trim() || undefined;
    const replyToMessageId = toOptionalMessageId(options?.replyToMessageId);

    for (const group of groups) {
      for (let index = 0; index < group.length; index += 1) {
        const item = group[index];
        const effectiveCaption = caption && index === 0 ? caption : undefined;
        try {
          const sent = await sendMediaItem(chatId, item, {
            caption: effectiveCaption,
            replyToMessageId,
          });
          const outgoing = toOutgoingTelegramMessage(sent as any);
          if (outgoing) {
            dispatchMessage(outgoing);
          }
          result.sentCount += 1;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          result.failures.push({
            source: item.source,
            type: item.type,
            error: message,
          });
        }
      }
      caption = undefined;
    }

    return result;
  };

  const sendTyping: TelegramAdapter["sendTyping"] = async (chatId) => {
    await setTyping(chatId);
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
    botUserId = ctx.me.id.toString();
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
    botUserId = ctx.me.id.toString();
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
    sendMediaBatch,
    sendTyping,
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
  const replySnapshot = extractReplySnapshotFromTelegramMessage(message);

  return {
    userId: message.from?.id?.toString() ?? "unknown",
    messageId: message.message_id,
    chatId: chat.id,
    conversationType: toConversationType(chat.type),
    context: `${stickerEmoji}${context}${photoPlaceholder}`,
    timestamp: (message.date ?? Math.floor(Date.now() / 1000)) * 1000,
    metadata: {
      isBot: message.from?.is_bot ?? false,
      username: buildDisplayName(message.from),
      usernameHandle: normalizeUsernameHandle(message.from?.username),
      replyToMessageId: message.reply_to_message?.message_id ?? null,
      replyToUserId: message.reply_to_message?.from?.id?.toString() ?? null,
      replyToUsername: replySnapshot.replyToUsername,
      replyToPreviewText: replySnapshot.replyToPreviewText,
      isReplyToMe: message.reply_to_message?.from?.id === ctx.me.id,
      isMentionMe: isMentionMe(ctx),
      mentions: extractMentions(message),
      mentionUserIds: extractMentionUserIds(
        rawContext,
        rawEntities,
      ),
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
  const replySnapshot = extractReplySnapshotFromTelegramMessage(message);

  return {
    userId: message.from?.id?.toString() ?? "unknown",
    messageId: message.message_id,
    chatId: chat.id,
    conversationType: toConversationType(chat.type),
    context: `${stickerEmoji}${context}${photoPlaceholder}`,
    timestamp: (message.date ?? Math.floor(Date.now() / 1000)) * 1000,
    metadata: {
      isBot: message.from?.is_bot ?? false,
      username: buildDisplayName(message.from),
      usernameHandle: normalizeUsernameHandle(message.from?.username),
      replyToMessageId: message.reply_to_message?.message_id ?? null,
      replyToUserId: message.reply_to_message?.from?.id?.toString() ?? null,
      replyToUsername: replySnapshot.replyToUsername,
      replyToPreviewText: replySnapshot.replyToPreviewText,
      isReplyToMe: message.reply_to_message?.from?.id === ctx.me.id,
      isMentionMe: isMentionMeEdited(ctx),
      mentions: extractMentionsFromTextWithEntities(
        rawContext,
        rawEntities,
      ),
      mentionUserIds: extractMentionUserIds(rawContext, rawEntities),
    },
  };
}

function toOutgoingTelegramMessage(
  message: Awaited<ReturnType<Bot["api"]["sendMessage"]>>
): TelegramMessage | null {
  if (!message?.chat) {
    return null;
  }
  const context = (message as { text?: string; caption?: string }).text ?? (message as { caption?: string }).caption ?? "";
  const replySnapshot = extractReplySnapshotFromTelegramMessage(message as TelegramIncomingMessageLike);
  return {
    userId: message.from?.id?.toString() ?? "bot",
    messageId: message.message_id,
    chatId: message.chat.id,
    conversationType: toConversationType(message.chat.type),
    context,
    timestamp: (message.date ?? Math.floor(Date.now() / 1000)) * 1000,
    metadata: {
      isBot: message.from?.is_bot ?? true,
      username: buildDisplayName(message.from),
      usernameHandle: normalizeUsernameHandle(message.from?.username),
      replyToMessageId: message.reply_to_message?.message_id ?? null,
      replyToUserId: message.reply_to_message?.from?.id?.toString() ?? null,
      replyToUsername: replySnapshot.replyToUsername,
      replyToPreviewText: replySnapshot.replyToPreviewText,
      isReplyToMe: false,
      isMentionMe: false,
      mentions: [],
      mentionUserIds: [],
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
    replyToUsername: state.replyToUserId,
    replyToPreviewText: null,
    isReplyToMe: false,
    isMentionMe: false,
    mentions: [] as string[],
    mentionUserIds: [] as string[],
    usernameHandle: null,
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
      username: buildDisplayName(result.from) ?? state.username,
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

function buildDisplayName(user: {
  first_name?: string;
  last_name?: string;
  username?: string;
} | null | undefined): string | null {
  if (!user) {
    return null;
  }
  const firstName = (user.first_name ?? "").trim();
  const lastName = (user.last_name ?? "").trim();
  const fullName = `${firstName} ${lastName}`.trim();
  if (fullName) {
    return fullName;
  }
  const username = (user.username ?? "").trim();
  return username || null;
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

function extractMentionUserIds(
  text: string,
  entities?: ReadonlyArray<TelegramTextEntity>
): string[] {
  if (!text || !entities?.length) {
    return [];
  }
  const ids: string[] = [];
  for (const entity of entities) {
    if (entity.type !== "text_mention") {
      continue;
    }
    const id = entity.user?.id;
    if (id === undefined || id === null) {
      continue;
    }
    const normalized = String(id).trim();
    if (!normalized) {
      continue;
    }
    ids.push(normalized);
  }
  return Array.from(new Set(ids));
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

function normalizeUsernameHandle(username: string | undefined): string | null {
  const normalized = (username ?? "").trim().toLowerCase();
  return normalized ? `@${normalized}` : null;
}

function normalizeReplyPreviewText(value: string | null | undefined): string | null {
  const normalized = (value ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return null;
  }
  if (normalized.length <= 180) {
    return normalized;
  }
  return `${normalized.slice(0, 177)}...`;
}

function extractReplyPreviewFromTelegramMessage(
  message: NonNullable<TelegramIncomingMessageLike["reply_to_message"]>
): string | null {
  const raw = normalizeReplyPreviewText(message.text ?? message.caption ?? null);
  if (raw) {
    return raw;
  }
  const stickerEmoji = (message.sticker?.emoji ?? "").trim();
  if (stickerEmoji) {
    return `[sticker ${stickerEmoji}]`;
  }
  if ((message.photo?.length ?? 0) > 0) {
    return "[photo]";
  }
  if (message.video || message.animation) {
    return "[video]";
  }
  if (message.voice) {
    return "[voice]";
  }
  if (message.audio) {
    return "[audio]";
  }
  if (message.document) {
    return "[file]";
  }
  return null;
}

function extractReplySnapshotFromTelegramMessage(
  message: TelegramIncomingMessageLike
): { replyToUsername: string | null; replyToPreviewText: string | null } {
  const reply = message.reply_to_message;
  if (!reply) {
    return {
      replyToUsername: null,
      replyToPreviewText: null,
    };
  }

  const speakerFromName = buildDisplayName(reply.from);
  const speakerFromId =
    reply.from?.id === undefined || reply.from?.id === null
      ? null
      : String(reply.from.id);
  return {
    replyToUsername: speakerFromName ?? speakerFromId,
    replyToPreviewText: extractReplyPreviewFromTelegramMessage(reply),
  };
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

function splitMediaItemsByType(
  items: TelegramOutgoingMediaItem[]
): TelegramOutgoingMediaItem[][] {
  const groups: TelegramOutgoingMediaItem[][] = [];
  for (const item of items) {
    if (!item?.source) {
      continue;
    }
    const lastGroup = groups[groups.length - 1];
    if (!lastGroup || lastGroup[0].type !== item.type) {
      groups.push([item]);
      continue;
    }
    lastGroup.push(item);
  }
  return groups;
}

function toTelegramMediaInput(source: string, fileName?: string): string | InputFile {
  if (isHttpMediaSource(source)) {
    return source;
  }
  const localPath = toLocalMediaPath(source);
  return fileName ? new InputFile(localPath, fileName) : new InputFile(localPath);
}

function isHttpMediaSource(source: string): boolean {
  try {
    const parsed = new URL(source);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function toLocalMediaPath(source: string): string {
  try {
    const parsed = new URL(source);
    if (parsed.protocol === "file:") {
      return decodeURIComponent(parsed.pathname);
    }
    return source;
  } catch {
    return source;
  }
}
