import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions";
import { NewMessage } from "telegram/events";
import type { TelegramAdapter, TelegramMessage, StreamState } from "./types";

const DEFAULT_FINAL_TEXT = "(空内容)";

export function createUserBotAdapter(options: any): TelegramAdapter {
  const client = new TelegramClient(new StringSession(options.sessionString || ""), options.apiId, options.apiHash, { connectionRetries: 10, useWSS: false, autoReconnect: true });
  const sentMessageIds = new Set<number>();
  const streams = new Map<number, StreamState>();
  let nextStreamId = 1;
  const messageHandlers = new Set<any>();
  let me: Api.User | null = null;

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

  const toTelegramMessage = async (msg: Api.Message): Promise<TelegramMessage | null> => {
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
    
    // 判定 Bot
    let isBot = false;
    try {
      // 这里的 getEntity 可能会慢，但在 Userbot 中是必要的
      const sender = await client.getEntity(fromId);
      if (sender instanceof Api.User && sender.bot) {
        isBot = true;
      }
    } catch (e) {}

    console.log(`[userbot] Ingested: from=${userId} (bot=${isBot}) chat=${chatId} text="${text.slice(0, 20)}..." mention=${isMentionMe} replyToMe=${isReplyToMe}`);

    return {
      userId, messageId: msg.id, chatId, conversationType, context: msg.message || "",
      timestamp: (msg.date || Math.floor(Date.now() / 1000)) * 1000,
      metadata: { isBot, username: null, replyToMessageId: replyToMsgId, replyToUserId: null, isReplyToMe, isMentionMe, mentions: [] }
    };
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
    startStream: async (chatId, messageId) => {
      void setTyping(chatId);
      const streamId = nextStreamId++;
      streams.set(streamId, { chatId, placeholderMessageId: 0, conversationType: "group", username: null, replyToMessageId: messageId || null, replyToUserId: null, chunks: [] });
      return streamId;
    },
    appendStream: (id, c) => {
      const s = streams.get(id);
      if (s) {
        s.chunks.push(c);
        if (s.chunks.length % 5 === 0) void setTyping(s.chatId);
      }
    },
    endStream: async (id) => {
      const s = streams.get(id);
      if (!s) return "";
      const text = s.chunks.join("") || DEFAULT_FINAL_TEXT;
      const target = await getSafeEntity(s.chatId);
      const sent = await client.sendMessage(target, { message: text, replyTo: s.replyToMessageId || undefined });
      if (sent instanceof Api.Message) {
        sentMessageIds.add(sent.id);
        console.log(`[userbot] Record sent message ID: ${sent.id}`);
      }
      streams.delete(id);
      return text;
    }
  };
}
