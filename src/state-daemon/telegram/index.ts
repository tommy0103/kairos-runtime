export type { TelegramAdapter, TelegramMessage, StreamState } from "./types";
export { createTelegramAdapter } from "./adapter";
export { createUserBotAdapter, type UserBotAdapterOptions } from "./userbot-adapter";

import type { TelegramAdapter } from "./types";
import { createTelegramAdapter as createBotAdapter } from "./adapter";
import { createUserBotAdapter, type UserBotAdapterOptions } from "./userbot-adapter";

export interface TelegramConfig {
  mode: "bot" | "userbot";
  botToken?: string;
  userbot?: UserBotAdapterOptions;
}

export function createAdapter(config: TelegramConfig): TelegramAdapter {
  if (config.mode === "userbot") {
    if (!config.userbot) {
      throw new Error("UserBot mode requires userbot configuration");
    }
    return createUserBotAdapter(config.userbot);
  }
  
  if (!config.botToken) {
    throw new Error("Bot mode requires botToken");
  }
  return createBotAdapter(config.botToken);
}
