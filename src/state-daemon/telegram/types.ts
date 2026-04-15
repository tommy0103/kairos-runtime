import type {
  TelegramConversationType,
  TelegramMessage,
} from "../types/message";
export type { TelegramConversationType, TelegramMessage };

export type TelegramOutgoingMediaType = "image" | "audio" | "file";

export interface TelegramOutgoingMediaItem {
  source: string;
  type: TelegramOutgoingMediaType;
  mimeType?: string;
  fileName?: string;
}

export interface TelegramSendMediaBatchResult {
  sentCount: number;
  failures: Array<{
    source: string;
    type: TelegramOutgoingMediaType;
    error: string;
  }>;
}

export interface StreamState {
  chatId: number;
  placeholderMessageId: number | null;
  conversationType: TelegramConversationType;
  username: string | null;
  replyToMessageId: number | null;
  replyToUserId: string | null;
  statusText: string | null;
  lastRenderedText: string;
  lastFlushAtMs: number;
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
  sendMediaBatch: (
    chatId: number,
    items: TelegramOutgoingMediaItem[],
    options?: {
      caption?: string;
      replyToMessageId?: number;
    }
  ) => Promise<TelegramSendMediaBatchResult>;
  sendTyping: (chatId: number) => Promise<void>;
  startStream: (
    chatId: number,
    messageId?: number,
    placeholder?: string
  ) => Promise<number>;
  setStreamStatus: (streamMessageId: number, status: string) => Promise<void>;
  appendStream: (streamMessageId: number, chunk: string) => void;
  endStream: (streamMessageId: number) => Promise<string>;
}
