import type {
  TelegramConversationType,
  TelegramMessage,
} from "../types/message";
export type { TelegramConversationType, TelegramMessage };

export interface StreamState {
  chatId: number;
  // placeholderMessageId: number;  // Commented out: no longer sending placeholder
  conversationType: TelegramConversationType;
  username: string | null;
  replyToMessageId: number | null;
  replyToUserId: string | null;
  chunks: string[];
}

export interface TelegramAdapter {
  start: () => Promise<void>;
  stop: () => void;
  getMessages: () => TelegramMessage[];
  onMessage: (
    handler: (message: TelegramMessage) => void | Promise<void>
  ) => () => void;
  onEditedMessage: (
    handler: (message: TelegramMessage) => void | Promise<void>
  ) => () => void;
  reply: (chatId: number, text: string, messageId?: number) => Promise<void>;
  startStream: (
    chatId: number,
    messageId?: number,
    placeholder?: string
  ) => Promise<number>;
  appendStream: (streamMessageId: number, chunk: string) => void;
  endStream: (streamMessageId: number) => Promise<string>;
}
