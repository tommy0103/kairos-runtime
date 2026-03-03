import type { TelegramMessage } from "../../telegram/types";
import type { ContextStore } from "./types";
import { logger } from "../../utils/logger";

export interface CreateInMemoryContextStoreOptions {
  maxHistoryPerChat?: number;
}

export function createInMemoryContextStore(
  options: CreateInMemoryContextStoreOptions = {}
): ContextStore {
  const maxHistoryPerChat = options.maxHistoryPerChat ?? 50;
  const historyByChat = new Map<number, TelegramMessage[]>();

  return {
    append: (message) => {
      const history = historyByChat.get(message.chatId) ?? [];
      history.push(message);
      if (history.length > maxHistoryPerChat) {
        history.splice(0, history.length - maxHistoryPerChat);
      }
      historyByChat.set(message.chatId, history);
      logger.debug("Gateway", "Session History Updated", { chatId: message.chatId, historySize: history.length });
    },
    getByChat: (chatId) => [...(historyByChat.get(chatId) ?? [])],
  };
}
