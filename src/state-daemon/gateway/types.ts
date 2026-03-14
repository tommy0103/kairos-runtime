import type { ClientRuntime } from "./clientRuntime";
import type { TelegramAdapter } from "../telegram/types";
import type { TelegramMessage } from "../types/message";

export interface GatewayContext {
  telegram: TelegramAdapter;
  runtime: ClientRuntime;
}

export type TriggerReason = "mention_me" | "reply_to_me" | "private_chat" | "none";

export interface TriggerDecision {
  shouldTrigger: boolean;
  reason: TriggerReason;
  prompt?: string;
}

export interface GatewayTriggerPolicy {
  name: string;
  priority: number;
  decide: (
    message: TelegramMessage,
    context: GatewayContext
  ) => Promise<TriggerDecision> | TriggerDecision;
}
