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
    } catch (e) {
      // 忽略
    }
  };

  const toTelegramMessage = async (msg: Api.Message): Promise<TelegramMessage | null> => {
    if (!me || !msg.peerId) return null;
    const fromId = msg.fromId;
    const userId = fromId instanceof Api.PeerUser ? fromId.userId.toString() : "unknown";
    
    // 如果是自己发的，过滤掉
    if (userId === me.id.toString()) return null;

    const chatId = msg.peerId instanceof Api.PeerUser ? msg.peerId.userId.toJSNumber() :
                   (msg.peerId instanceof Api.PeerChat ? msg.peerId.chatId.toJSNumber() :
                   (msg.peerId instanceof Api.PeerChannel ? msg.peerId.channelId.toJSNumber() : 0));

    const conversationType = msg.peerId instanceof Api.PeerUser ? "private" : "group";
    const replyToMsgId = msg.replyTo instanceof Api.MessageReplyHeader ? msg.replyTo.replyToMsgId : null;
    
    const myUsername = me?.username?.toLowerCase();
    const text = (msg.message || "").toLowerCase();
    
    const isMentionMe = conversationType === "private" || 
                        (myUsername && text.includes("@" + myUsername)) ||
                        text.includes("yuki") || text.includes("mochi") ||
                        (me.firstName && text.includes(me.firstName.toLowerCase()));

    // 改进的回复检测
    let isReplyToMe = replyToMsgId !== null && sentMessageIds.has(replyToMsgId);
    if (!isReplyToMe && replyToMsgId !== null) {
      try {
        // 如果内存没命中，尝试拉取原消息确认（带有缓存/限制以防频繁请求）
        const replyMsg = await client.getMessages(msg.peerId, { ids: [replyToMsgId] });
        if (replyMsg && replyMsg[0] && replyMsg[0].fromId instanceof Api.PeerUser) {
          if (replyMsg[0].fromId.userId.toString() === me.id.toString()) {
            isReplyToMe = true;
          }
        }
      } catch (e) {
        // 忽略
      }
    }

    // 判定是否为机器人
    let isBot = false;
    try {
      const sender = await client.getEntity(fromId);
      if (sender instanceof Api.User && sender.bot) {
        isBot = true;
      }
    } catch (e) {}

    console.log(`[userbot] Msg from ${userId} (bot=${isBot}) in ${chatId}: mention=${isMentionMe} replyToMe=${isReplyToMe}`);

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
      console.log(`UserBot: 已作为 ${me.firstName} 登录 (ID: ${me.id})`);
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
      if (sent instanceof Api.Message) sentMessageIds.add(sent.id);
      streams.delete(id);
      return text;
    }
  };
}
