import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { Api } from "telegram/tl";
import type { TelegramAdapter, TelegramMessage, StreamState } from "./types";

const DEFAULT_PLACEHOLDER = "小猫正在玩毛线球...";
const DEFAULT_FINAL_TEXT = "(空内容)";
const EDIT_RETRY_ATTEMPTS = 3;
const EDIT_RETRY_DELAY_MS = 500;

export interface UserBotAdapterOptions {
  apiId: number;
  apiHash: string;
  phoneNumber: string;
  password?: string;
  sessionString?: string;
  sessionFilePath?: string;
}

export function createUserBotAdapter(options: UserBotAdapterOptions): TelegramAdapter {
  const client = new TelegramClient(
    new StringSession(options.sessionString || ""),
    options.apiId,
    options.apiHash,
    {
      connectionRetries: 5,
      useWSS: false,
    }
  );

  const messages: TelegramMessage[] = [];
  const sentMessageIds = new Set<number>();
  const streams = new Map<number, StreamState>();
  let nextStreamId = 1;
  const messageHandlers = new Set<(message: TelegramMessage) => void | Promise<void>>();
  const editedMessageHandlers = new Set<(message: TelegramMessage) => void | Promise<void>>();

  const dispatchMessage = (message: TelegramMessage) => {
    messages.push(message);
    for (const handler of messageHandlers) {
      void Promise.resolve(handler(message)).catch((error) => {
        console.error("userbot onMessage handler failed:", error);
      });
    }
  };

  const dispatchEditedMessage = (message: TelegramMessage) => {
    for (const handler of editedMessageHandlers) {
      void Promise.resolve(handler(message)).catch((error) => {
        console.error("userbot onEditedMessage handler failed:", error);
      });
    }
  };

  let me: Api.User | null = null;

  const toTelegramMessage = (event: Api.TypeUpdate): TelegramMessage | null => {
    let message: Api.Message | undefined;
    let isEdited = false;

    if (event instanceof Api.UpdateNewMessage) {
      if (event.message instanceof Api.Message) {
        message = event.message;
      }
    } else if (event instanceof Api.UpdateNewChannelMessage) {
      if (event.message instanceof Api.Message) {
        message = event.message;
      }
    } else if (event instanceof Api.UpdateEditMessage) {
      if (event.message instanceof Api.Message) {
        message = event.message;
        isEdited = true;
      }
    } else if (event instanceof Api.UpdateEditChannelMessage) {
      if (event.message instanceof Api.Message) {
        message = event.message;
        isEdited = true;
      }
    }

    if (!message) {
      return null;
    }

    const chatId = message.peerId instanceof Api.PeerUser
      ? message.peerId.userId.toJSNumber()
      : message.peerId instanceof Api.PeerChat
      ? message.peerId.chatId.toJSNumber()
      : message.peerId instanceof Api.PeerChannel
      ? message.peerId.channelId.toJSNumber()
      : 0;

    const userId = message.fromId instanceof Api.PeerUser
      ? message.fromId.userId.toJSNumber().toString()
      : message.peerId instanceof Api.PeerUser
      ? message.peerId.userId.toJSNumber().toString()
      : "unknown";

    // Don't process messages from myself
    if (me && userId === me.id.toString()) {
      return null;
    }

    const context = message.message || "";
    const timestamp = (message.date || Math.floor(Date.now() / 1000)) * 1000;

    const conversationType = message.peerId instanceof Api.PeerUser
      ? "private"
      : message.peerId instanceof Api.PeerChat
      ? "group"
      : "supergroup";

    const replyToMsgId = message.replyTo instanceof Api.MessageReplyHeader
      ? message.replyTo.replyToMsgId
      : null;

    const isReplyToMe = replyToMsgId !== null && sentMessageIds.has(replyToMsgId);

    // Simple mention check: if username is present in text or if it's a private chat
    const myUsername = me?.username;
    const isMentionMe = conversationType === "private" || 
      (myUsername ? context.includes(`@${myUsername}`) : false);

    return {
      userId,
      messageId: message.id,
      chatId,
      conversationType,
      context,
      timestamp,
      metadata: {
        isBot: false,
        username: null,
        replyToMessageId: replyToMsgId ?? null,
        replyToUserId: null,
        isReplyToMe: isReplyToMe,
        isMentionMe: isMentionMe,
        mentions: [],
      },
    };
  };

  const reply: TelegramAdapter["reply"] = async (chatId, text, messageId) => {
    const entity = await client.getEntity(chatId.toString());
    
    const sent = await client.sendMessage(entity, {
      message: text,
      replyTo: messageId || undefined,
    });

    if (sent instanceof Api.Message) {
      sentMessageIds.add(sent.id);
    }
  };

  const startStream: TelegramAdapter["startStream"] = async (chatId, messageId, placeholder = DEFAULT_PLACEHOLDER) => {
    const entity = await client.getEntity(chatId.toString());
    
    const sent = await client.sendMessage(entity, {
      message: placeholder,
      replyTo: messageId || undefined,
    });

    if (sent instanceof Api.Message) {
      sentMessageIds.add(sent.id);
    }

    const streamId = nextStreamId++;
    streams.set(streamId, {
      chatId,
      placeholderMessageId: sent.id,
      conversationType: "private",
      username: null,
      replyToMessageId: messageId || null,
      replyToUserId: null,
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
    const escapedFinalText = escapeText(finalText);

    try {
      await retry(
        async () => {
          const entity = await client.getEntity(state.chatId.toString());
          await client.editMessage(entity, {
            message: state.placeholderMessageId,
            text: escapedFinalText,
          });
        },
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

  const onEditedMessage: TelegramAdapter["onEditedMessage"] = (handler) => {
    editedMessageHandlers.add(handler);
    return () => {
      editedMessageHandlers.delete(handler);
    };
  };

  const start: TelegramAdapter["start"] = async () => {
    try {
      await client.connect();
    } catch (err: any) {
      console.error("UserBot: 连接失败", err);
    }

    const sessionSaved = client.session.save() as unknown as string;
    let needsAuth = !sessionSaved;

    if (!needsAuth) {
      try {
        // Test if the session is actually valid
        await client.getMe();
        console.log("UserBot: 使用已有 session 登录成功");
      } catch (err: any) {
        if (err.errorMessage === "AUTH_KEY_UNREGISTERED" || err.code === 401) {
          console.log("UserBot: Session 已失效，准备重新认证...");
          needsAuth = true;
        } else {
          throw err;
        }
      }
    }

    if (needsAuth) {
      console.log("UserBot: 开始认证流程...");
      await client.start({
        phoneNumber: options.phoneNumber,
        password: async () => options.password || "",
        phoneCode: async () => {
          console.log("请输入收到的验证码: ");
          const code = await new Promise<string>((resolve) => {
            process.stdin.once("data", (data) => {
              resolve(data.toString().trim());
            });
          });
          return code;
        },
        onError: (err) => console.error("登录错误:", err),
      });
      
      const sessionString = client.session.save() as unknown as string;
      console.log("登录成功！请保存以下 session string:");
      console.log(sessionString);
      
      if (options.sessionFilePath) {
        const { writeFileSync } = await import("fs");
        writeFileSync(options.sessionFilePath, sessionString, "utf-8");
        console.log(`Session 已保存到: ${options.sessionFilePath}`);
      }
    }

    me = await client.getMe() as Api.User;
    console.log(`UserBot: 已作为 ${me.firstName} (@${me.username || "no_username"}) 登录 (ID: ${me.id})`);

    client.addEventHandler((event: Api.TypeUpdate) => {
      const message = toTelegramMessage(event);
      if (!message) {
        return;
      }

      if (event instanceof Api.UpdateEditMessage || event instanceof Api.UpdateEditChannelMessage) {
        dispatchEditedMessage(message);
      } else {
        dispatchMessage(message);
      }
    });
  };

  const stop: TelegramAdapter["stop"] = () => {
    client.disconnect();
    streams.clear();
  };

  const getMessages: TelegramAdapter["getMessages"] = () => [...messages];

  return {
    start,
    stop,
    getMessages,
    onMessage,
    onEditedMessage,
    reply,
    startStream,
    appendStream,
    endStream,
  };
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

function escapeText(text: string): string {
  const escapeMarkdownV2 = (value: string): string =>
    value.replace(/[\\_\*\[\]()~`>#+\-=|{}.!]/g, "\\$&");
  
  const placeholders: string[] = [];

  const protectedText = text.replace(
    /\[([^\]\n]+)\]\(([^)\n]+)\)/g,
    (_, label: string, url: string) => {
      const token = `\u0000LINK${placeholders.length}\u0000`;
      const escapedLabel = escapeMarkdownV2(label);
      placeholders.push(`[${escapedLabel}](${url})`);
      return token;
    }
  );

  const escaped = escapeMarkdownV2(protectedText);
  return escaped.replace(/\u0000LINK(\d+)\u0000/g, (_, indexText: string) => {
    const index = Number(indexText);
    return placeholders[index] ?? "";
  });
}
