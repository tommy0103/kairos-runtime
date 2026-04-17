export interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export type TelegramConversationType =
  | "private"
  | "group"
  | "supergroup"
  | "channel";

export interface TelegramMessage {
  userId: string;
  messageId: number;
  chatId: number;
  conversationType: TelegramConversationType;
  context: string;
  timestamp: number;
  imageUrls?: string[];
  metadata: {
    isBot: boolean;
    username: string | null;
    replyToMessageId: number | null;
    replyToUserId: string | null;
    replyToUsername?: string | null;
    replyToPreviewText?: string | null;
    isReplyToMe: boolean;
    isMentionMe: boolean;
    mentions: string[];
    mentionUserIds?: string[];
    usernameHandle?: string | null;
  };
}
