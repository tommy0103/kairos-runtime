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
      // 忽略设置状态失败的情况
    }
  };

  const toTelegramMessage = (msg: Api.Message): TelegramMessage | null => {
    if (!me || !msg.peerId) return null;
    const userId = msg.fromId instanceof Api.PeerUser ? msg.fromId.userId.toString() : "unknown";
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
                        text.includes("yuki") || text.includes("mochi");
    const isReplyToMe = replyToMsgId !== null && sentMessageIds.has(replyToMsgId);

    return {
      userId, messageId: msg.id, chatId, conversationType, context: msg.message || "",
      timestamp: (msg.date || Math.floor(Date.now() / 1000)) * 1000,
      metadata: { isBot: false, username: null, replyToMessageId: replyToMsgId, replyToUserId: null, isReplyToMe, isMentionMe, mentions: [] }
    };
  };

  return {
    start: async () => {
      await client.connect();
      me = await client.getMe() as Api.User;
      console.log(`UserBot: 已作为 ${me.firstName} 登录 (ID: ${me.id})`);
      client.addEventHandler(async (ev) => {
        const m = toTelegramMessage(ev.message);
        if (m) {
          for (const h of messageHandlers) void Promise.resolve(h(m)).catch(e => console.error(e));
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
      // 不再发送占位符消息，只设置正在输入状态
      void setTyping(chatId);
      const streamId = nextStreamId++;
      streams.set(streamId, { 
        chatId, 
        placeholderMessageId: 0, // 不再使用
        conversationType: "group", 
        username: null, 
        replyToMessageId: messageId || null, 
        replyToUserId: null, 
        chunks: [] 
      });
      return streamId;
    },
    appendStream: (id, c) => {
      const s = streams.get(id);
      if (s) {
        s.chunks.push(c);
        // 每收到 5 个 chunk 刷新一次 typing 状态（TG 状态通常 5 秒消失）
        if (s.chunks.length % 5 === 0) void setTyping(s.chatId);
      }
    },
    endStream: async (id) => {
      const s = streams.get(id);
      if (!s) return "";
      const text = s.chunks.join("") || DEFAULT_FINAL_TEXT;
      const target = await getSafeEntity(s.chatId);
      
      // 直接发送新消息，而不是编辑占位符
      const sent = await client.sendMessage(target, { 
        message: text, 
        replyTo: s.replyToMessageId || undefined 
      });
      if (sent instanceof Api.Message) sentMessageIds.add(sent.id);
      
      streams.delete(id);
      return text;
    }
  };
}
