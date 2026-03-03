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

export interface SessionControlBlock {
  sessionId: string;
  topicSummary: string;
  centerVector: number[];
  recentVector: number[] | null;
  status: "L1_ACTIVE" | "L2_BACKGROUND";
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
}

export interface ContextAssembler {
  build: (input: ContextAssemblerBuildInput) => LLMMessage[];
}
