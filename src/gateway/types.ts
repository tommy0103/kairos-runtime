import type { ClientRuntime } from "./clientRuntime";
import type { TelegramAdapter, TelegramMessage } from "../telegram/types";
import type { UserRolesStore } from "../storage";

export interface GatewayContext {
  telegram: TelegramAdapter;
  runtime: ClientRuntime;
  userRoles?: UserRolesStore;
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
