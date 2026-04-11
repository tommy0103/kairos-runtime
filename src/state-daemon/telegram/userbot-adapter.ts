import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions";
import { NewMessage } from "telegram/events";
import type { TelegramAdapter, TelegramMessage, StreamState } from "./types";
import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_FINAL_TEXT = "(空内容)";
const DEFAULT_STREAM_PLACEHOLDER = "Working on it... estimated 30-90 seconds.";
const STREAM_EDIT_THROTTLE_MS = 1200;
const MEDIA_GROUP_FLUSH_DELAY_MS = 300;

export function createUserBotAdapter(options: any): TelegramAdapter {
  const client = new TelegramClient(new StringSession(options.sessionString || ""), options.apiId, options.apiHash, { connectionRetries: 10, useWSS: false, autoReconnect: true });
  const sentMessageIds = new Set<number>();
  const streams = new Map<number, StreamState>();
  let nextStreamId = 1;
  const messageHandlers = new Set<any>();
  let me: Api.User | null = null;

  // 媒体组缓存，参照 adapter.ts
  const pendingMediaGroups = new Map<
    string,
    {
      msg: Api.Message;
      photoCount: number;
      photoPaths: string[];
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  const getSafeEntity = async (id: any) => {
    const ids = [id, id.toString()];
    if (typeof id === 'number' && id > 0) ids.push(-id);
    for (const target of ids) {
      try { return await client.getEntity(target); } catch {}
    }
    try { return await client.getEntity(BigInt(id)); } catch {}
    throw new Error("Could not find entity for " + id);
  };

  const setTyping = async (chatId: any) => {
    try {
      const target = await getSafeEntity(chatId);
      await client.invoke(new Api.messages.SetTyping({
        peer: target,
        action: new Api.SendMessageTypingAction(),
      }));
    } catch (e) {}
  };

  const downloadPhoto = async (msg: Api.Message): Promise<string | null> => {
    if (!(msg.media instanceof Api.MessageMediaPhoto)) return null;
    try {
      const buffer = await client.downloadMedia(msg.media, { workers: 1 });
      if (buffer && buffer instanceof Buffer) {
        const fileName = `vision-${msg.peerId?.toJSON()}-${msg.id}.jpg`;
        const filePath = `/tmp/kairos-vision/${fileName}`;
        await fs.mkdir("/tmp/kairos-vision", { recursive: true });
        await fs.writeFile(filePath, buffer);
        return `file://${filePath}`;
      }
    } catch (e) {
      console.error("[userbot] Failed to download media:", e);
    }
    return null;
  };

  const flushMediaGroup = async (key: string) => {
    const pending = pendingMediaGroups.get(key);
    if (!pending) return;
    pendingMediaGroups.delete(key);

    const m = await toTelegramMessage(pending.msg, pending.photoCount, pending.photoPaths);
    if (m) {
      for (const h of messageHandlers) void Promise.resolve(h(m)).catch(e => console.error(e));
    }
  };

  const toTelegramMessage = async (msg: Api.Message, photoCountOverride?: number, photoPaths?: string[]): Promise<TelegramMessage | null> => {
    if (!me || !msg.peerId) return null;
    const fromId = msg.fromId;
    const userId = fromId instanceof Api.PeerUser ? fromId.userId.toString() : "unknown";
    
    if (userId === me.id.toString()) return null;

    const chatId = msg.peerId instanceof Api.PeerUser ? msg.peerId.userId.toJSNumber() :
                   (msg.peerId instanceof Api.PeerChat ? msg.peerId.chatId.toJSNumber() :
                   (msg.peerId instanceof Api.PeerChannel ? msg.peerId.channelId.toJSNumber() : 0));

    const conversationType = msg.peerId instanceof Api.PeerUser ? "private" : "group";
    const replyToMsgId = msg.replyTo instanceof Api.MessageReplyHeader ? msg.replyTo.replyToMsgId : null;
    
    const myUsername = (me.username || "").toLowerCase();
    const text = (msg.message || "").toLowerCase();
    
    // 判定 Mention：私聊 100% 触发，或者文本包含关键词
    const isMentionMe = conversationType === "private" || 
                        (myUsername && text.includes(myUsername)) ||
                        text.includes("yuki") || text.includes("mochi") ||
                        (me.firstName && text.includes(me.firstName.toLowerCase()));

    // 判定 Reply
    let isReplyToMe = replyToMsgId !== null && sentMessageIds.has(replyToMsgId);
    
    // 判定 Bot 和提取用户名/姓名
    let isBot = false;
    let senderName: string | null = null;
    try {
      const sender = await client.getEntity(fromId);
      if (sender instanceof Api.User) {
        const username = sender.username || "";
        isBot = sender.bot || username.toLowerCase().includes("bot") || false;
        senderName = username || sender.firstName || null;
      } else if (sender instanceof Api.Chat || sender instanceof Api.Channel) {
        senderName = sender.title || null;
      }
    } catch (e) {
      console.warn(`[userbot] Failed to get entity for ${fromId}:`, e);
    }

    const photoCount = photoCountOverride ?? (msg.media instanceof Api.MessageMediaPhoto ? 1 : 0);
    const photoPlaceholder = photoCount <= 0 ? "" : (photoCount === 1 ? " [photo]" : ` [photo x${photoCount}]`);

    const imageUrls = photoPaths || [];
    if (!photoPaths && msg.media instanceof Api.MessageMediaPhoto) {
      const path = await downloadPhoto(msg);
      if (path) imageUrls.push(path);
    }

    console.log(`[userbot] Ingested: from=${userId} (${senderName}) chat=${chatId} text="${text.slice(0, 20)}..." photo=${photoCount} mention=${isMentionMe}`);

    return {
      userId, messageId: msg.id, chatId, conversationType, 
      context: (msg.message || "") + photoPlaceholder,
      timestamp: (msg.date || Math.floor(Date.now() / 1000)) * 1000,
      imageUrls,
      metadata: { isBot, username: senderName, replyToMessageId: replyToMsgId, replyToUserId: null, isReplyToMe, isMentionMe, mentions: [] }
    };
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

  const editStreamMessage = async (state: StreamState, text: string) => {
    if (!state.placeholderMessageId) {
      return;
    }
    const target = await getSafeEntity(state.chatId);
    await (client as any).editMessage(target, {
      message: state.placeholderMessageId,
      text,
    });
    state.lastRenderedText = text;
    state.lastFlushAtMs = Date.now();
  };

  const deleteStreamMessage = async (state: StreamState): Promise<void> => {
    if (!state.placeholderMessageId) {
      return;
    }
    try {
      const target = await getSafeEntity(state.chatId);
      await (client as any).deleteMessages(target, [state.placeholderMessageId], {
        revoke: true,
      });
    } catch (error) {
      console.warn("[userbot] failed to delete stream placeholder:", error);
    }
  };

  const flushStreamPreview = async (state: StreamState, force = false) => {
    if (!state.placeholderMessageId) {
      return;
    }
    const now = Date.now();
    if (!force && now - state.lastFlushAtMs < STREAM_EDIT_THROTTLE_MS) {
      return;
    }
    const preview = renderStreamPreview(state);
    if (!preview || preview === state.lastRenderedText) {
      return;
    }
    try {
      await editStreamMessage(state, preview);
    } catch (error) {
      console.warn("[userbot] stream preview edit failed:", error);
    }
  };


  return {
    start: async () => {
      await client.connect();
      me = await client.getMe() as Api.User;
      console.log(`UserBot: 已作为 ${me.firstName} (@${me.username}) 登录 (ID: ${me.id})`);

      client.addEventHandler(async (ev) => {
        const msg = ev.message;
        if (!(msg instanceof Api.Message)) return;

        try {
          const mediaGroupId = msg.mediaGroupId?.toString();
          if (mediaGroupId) {
            const chatId = msg.peerId instanceof Api.PeerUser ? msg.peerId.userId.toJSNumber() :
                          (msg.peerId instanceof Api.PeerChat ? msg.peerId.chatId.toJSNumber() :
                          (msg.peerId instanceof Api.PeerChannel ? msg.peerId.channelId.toJSNumber() : 0));
            const key = `${chatId}:${mediaGroupId}`;
            const photoPath = await downloadPhoto(msg);

            let pending = pendingMediaGroups.get(key);
            if (!pending) {
              pending = {
                msg,
                photoCount: 0,
                photoPaths: [],
                timer: setTimeout(() => flushMediaGroup(key), MEDIA_GROUP_FLUSH_DELAY_MS),
              };
              pendingMediaGroups.set(key, pending);
            } else {
              clearTimeout(pending.timer);
              pending.timer = setTimeout(() => flushMediaGroup(key), MEDIA_GROUP_FLUSH_DELAY_MS);
            }

            if (photoPath) {
              pending.photoCount++;
              pending.photoPaths.push(photoPath);
            }
            // 如果消息带文本，通常媒体组的第一条消息会带文本
            if (msg.message) {
              pending.msg = msg;
            }
            return;
          }

          const m = await toTelegramMessage(msg);
          if (m) {
            for (const h of messageHandlers) void Promise.resolve(h(m)).catch(e => console.error(e));
          }
        } catch (e) {
          console.error("[userbot] handler error:", e);
        }
      }, new NewMessage({}));
      return new Promise(() => {});
    },
    stop: () => client.disconnect(),
    getMessages: () => [],
    onMessage: (h) => { messageHandlers.add(h); return () => messageHandlers.delete(h); },
    onEditedMessage: () => () => {},
    reply: async (chatId, text, messageId) => {
      const target = await getSafeEntity(chatId);
      const sent = await client.sendMessage(target, { message: text, replyTo: messageId });
      if (sent instanceof Api.Message) sentMessageIds.add(sent.id);
    },
    startStream: async (chatId, messageId, placeholder) => {
      void setTyping(chatId);
      const streamId = nextStreamId++;
      const initialStatus = (placeholder?.trim() || DEFAULT_STREAM_PLACEHOLDER).trim();
      let placeholderMessageId: number | null = null;
      try {
        const target = await getSafeEntity(chatId);
        const sent = await client.sendMessage(target, {
          message: initialStatus,
          replyTo: messageId || undefined,
        });
        if (sent instanceof Api.Message) {
          placeholderMessageId = sent.id;
          sentMessageIds.add(sent.id);
        }
      } catch (error) {
        console.warn("[userbot] failed to send stream placeholder:", error);
      }

      streams.set(streamId, {
        chatId,
        placeholderMessageId,
        conversationType: "group",
        username: null,
        replyToMessageId: messageId || null,
        replyToUserId: null,
        statusText: initialStatus,
        lastRenderedText: placeholderMessageId ? initialStatus : "",
        lastFlushAtMs: Date.now(),
        chunks: [],
      });
      return streamId;
    },
    setStreamStatus: async (id, status) => {
      const s = streams.get(id);
      if (!s) return;
      const normalized = status.trim();
      if (!normalized || normalized === s.statusText) {
        return;
      }
      s.statusText = normalized;
      await flushStreamPreview(s, true);
    },
    appendStream: (id, c) => {
      const s = streams.get(id);
      if (s) {
        s.chunks.push(c);
        if (s.chunks.length % 5 === 0) void setTyping(s.chatId);
        void flushStreamPreview(s);
      }
    },
    endStream: async (id) => {
      const s = streams.get(id);
      if (!s) return "";
      const text = s.chunks.join("") || DEFAULT_FINAL_TEXT;
      if (s.placeholderMessageId) {
        await deleteStreamMessage(s);
      }

      const target = await getSafeEntity(s.chatId);
      const sent = await client.sendMessage(target, {
        message: text,
        replyTo: s.replyToMessageId || undefined,
      });
      if (sent instanceof Api.Message) {
        sentMessageIds.add(sent.id);
        console.log(`[userbot] Record sent message ID: ${sent.id}`);
      }
      streams.delete(id);
      return text;
    }
  };
}
