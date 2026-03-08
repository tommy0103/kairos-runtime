import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions";

export interface UserbotConfig {
  apiId: number;
  apiHash: string;
  stringSession: string;
}

/**
 * Userbot 适配器：作为“数据泵”拉取历史记录
 */
export async function createUserbotClient(config: UserbotConfig) {
  const session = new StringSession(config.stringSession);
  const client = new TelegramClient(session, config.apiId, config.apiHash, {
    connectionRetries: 5,
  });

  await client.connect();

  return {
    /**
     * 拉取指定 Chat 的最近历史消息
     * @param chatId 聊天 ID (Bot API 格式，如 -100...)
     * @param limit 消息条数
     */
    getHistory: async (chatId: number | string, limit: number) => {
      try {
        const history = await client.invoke(
          new Api.messages.GetHistory({
            peer: chatId,
            limit: limit,
          })
        );

        if (history instanceof Api.messages.MessagesSlice || history instanceof Api.messages.Messages) {
          return history.messages
            .filter((msg): msg is Api.Message => msg instanceof Api.Message)
            .map((msg) => {
                // 转换成统一的消息格式（简化版）
                const senderId = msg.fromId instanceof Api.PeerUser ? msg.fromId.userId.toString() : "unknown";
                return {
                    userId: senderId,
                    context: msg.message,
                    timestamp: msg.date * 1000, // MTProto 是秒，Bot API 是毫秒
                    metadata: {
                        username: "unknown", // Userbot 获取历史时不一定能直接拿到 username，后续可以优化
                        isBot: false, 
                    }
                };
            })
            .reverse(); // GetHistory 拿到的是倒序，我们需要正序
        }
        return [];
      } catch (error) {
        console.error("[Userbot] 获取历史失败:", error);
        return [];
      }
    },
    stop: () => client.disconnect(),
  };
}
