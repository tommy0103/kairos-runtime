import type { LLMMessage } from "../../agent/core/openai";
import type { TelegramMessage } from "../../telegram/types";

export interface MessageNode {
  message: TelegramMessage;
  messageId: number;
  timestamp: number;
  replyToId: number | null;
  childrenIds: number[];
  sessionId: string;
  vector: number[];
}

export type SessionStatus = "L1_ACTIVE" | "L2_BACKGROUND" | "L3_ARCHIVED";

export interface SessionControlBlock {
  sessionId: string;
  topicSummary: string;
  /** Number of messages in session when topicSummary was last updated (for cloud summarization). */
  lastSummarizedMessageCount: number;
  centerVector: number[];
  recentVector: number[] | null;
  status: SessionStatus;
  lastActiveTime: number;
  messageIds: Set<number>;
  rootMessageIds: Set<number>;
}

export interface ChatControlBlock {
  chatId: number;
  sessionControlBlocks: Map<string, SessionControlBlock>;
  messageNodes: Map<number, MessageNode>;
  lastMessageNodeId: number | null;
  nextSessionSeq: number;
}

export type ContextMessagesPair = [recentMessages: TelegramMessage[], sessionMessages: TelegramMessage[]];

export interface ContextStore {
  ingestMessage: (input: { message: TelegramMessage }) => Promise<void>;
  getContextByAnchor: (input: { chatId: number; messageId: number }) => ContextMessagesPair;
  /** 获取指定 Chat 的最近 N 条历史消息（暴力线性模式） */
  getLinearContext: (input: { chatId: number; limit: number }) => TelegramMessage[];
  /** For evaluation: return sessionId for a message, or null if not found. */
  getSessionIdForMessage?: (input: { chatId: number; messageId: number }) => string | null;
  debugPrintSessionControlBlocks: (input?: {
    chatId?: number;
    includeVectors?: boolean;
    log?: (...args: unknown[]) => void;
  }) => void;
}

export interface ContextAssemblerBuildInput {
  triggerMessage: TelegramMessage;
  contextMessages: TelegramMessage[];
  recentMessages: TelegramMessage[];
  systemPrompt: string;
  userFacts?: string[]; // 长期记忆事实
}

export interface ContextAssembler {
  build: (input: ContextAssemblerBuildInput) => LLMMessage[];
}
