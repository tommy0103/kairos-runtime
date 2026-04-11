export type { TelegramAdapter, TelegramMessage, StreamState } from "./types";
export { createTelegramAdapter } from "./adapter";
export { createUserBotAdapter, type UserBotAdapterOptions } from "./userbot-adapter";

import type { TelegramAdapter } from "./types";
import { createTelegramAdapter as createBotAdapter } from "./adapter";
import { createUserBotAdapter, type UserBotAdapterOptions } from "./userbot-adapter";

export interface CustomEmojiToTextConfig {
  enabled: boolean;
  model?: string;
  baseURL?: string;
  apiKey?: string;
  maxConcurrency?: number;
  maxFrames?: number;
  dbPath?: string;
}

export interface TelegramConfig {
  mode: "bot" | "userbot";
  botToken?: string;
  userbot?: UserBotAdapterOptions;
  customEmojiToText?: CustomEmojiToTextConfig;
}

export function createAdapter(config: TelegramConfig): TelegramAdapter {
  if (config.mode === "userbot") {
    if (!config.userbot) {
      throw new Error("UserBot mode requires userbot configuration");
    }
    return createUserBotAdapter({
      ...config.userbot,
      customEmojiToText: config.customEmojiToText,
    });
  }
  
  if (!config.botToken) {
    throw new Error("Bot mode requires botToken");
  }
  return createBotAdapter(config.botToken, config.customEmojiToText);
}
