import type { ClientRuntime } from "./clientRuntime";
import type { TelegramAdapter } from "../telegram/types";
import type { TelegramMessage } from "../types/message";
import type {
  GatewayContext,
  GatewayTriggerPolicy,
  TriggerDecision,
} from "./types";
import type { UserRolesStore } from "../storage";
import { createEventNormalizer } from "./eventNormalizer";

const BLOCKED_REPLY = "我不能响应被拉黑的用户喵";

// 社交礼仪配置
const ETIQUETTE_CONFIG = {
  decayFactor: 0.5, // 衰减系数
  recoveryTimeMs: 5 * 60 * 1000, 
  idleResetMs: 3 * 60 * 1000, 
  terminateThreshold: 0.15, 
  conciseThreshold: 0.6, 
  wrapUpThreshold: 0.3, 
};

type SocialState = "NORMAL" | "CONCISE" | "WRAP_UP" | "SILENCE";

class SocialEtiquetteManager {
  private heatMap = new Map<number, { heat: number; lastUpdate: number }>();

  getHeat(chatId: number): number {
    const entry = this.heatMap.get(chatId);
    if (!entry) return 1.0;

    const now = Date.now();
    const elapsed = now - entry.lastUpdate;

    if (elapsed > ETIQUETTE_CONFIG.idleResetMs) return 1.0;

    const recovery = elapsed / ETIQUETTE_CONFIG.recoveryTimeMs;
    return Math.min(1.0, entry.heat + recovery);
  }

  updateHeat(chatId: number, isBotLike: boolean) {
    if (!isBotLike) {
      this.heatMap.set(chatId, { heat: 1.0, lastUpdate: Date.now() });
      return;
    }

    const currentHeat = this.getHeat(chatId);
    const newHeat = currentHeat * ETIQUETTE_CONFIG.decayFactor;
    console.log(`[etiquette] chat=${chatId} decaying heat: ${currentHeat.toFixed(2)} -> ${newHeat.toFixed(2)}`);
    this.heatMap.set(chatId, {
      heat: newHeat,
      lastUpdate: Date.now()
    });
  }

  getSocialState(chatId: number, isBotLike: boolean): SocialState {
    if (!isBotLike) return "NORMAL";
    
    const heat = this.getHeat(chatId);
    if (heat < ETIQUETTE_CONFIG.terminateThreshold) return "SILENCE";
    if (heat < ETIQUETTE_CONFIG.wrapUpThreshold) return "WRAP_UP";
    if (heat < ETIQUETTE_CONFIG.conciseThreshold) return "CONCISE";
    return "NORMAL";
  }

  getInstruction(state: SocialState): string {
    switch (state) {
      case "CONCISE":
        return "\n\n【系统提示：当前对话已持续较久，请精简你的回答，避免展开复杂话题。】";
      case "WRAP_UP":
        return "\n\n【系统提示：当前对话已过长。请礼貌地找个借口结束本次对话（例如：要去忙了、去休息了等），不要再引导对方继续聊下去。】";
      default:
        return "";
    }
  }
}

export interface CreateMessageGatewayOptions {
  telegram: TelegramAdapter;
  runtime: ClientRuntime;
  policies: GatewayTriggerPolicy[];
  userRoles?: UserRolesStore;
  mergeWindowMs?: number;
  enableEditedMessageTrigger?: boolean;
}

export interface MessageGateway {
  stop: () => void;
}

export function createMessageGateway(
  options: CreateMessageGatewayOptions
): MessageGateway {
  const context: GatewayContext = {
    telegram: options.telegram,
    runtime: options.runtime,
  };

  const etiquetteManager = new SocialEtiquetteManager();

  const policies = [...options.policies].sort(
    (a, b) => a.priority - b.priority
  );

  const recordNormalizedMessage = async (message: TelegramMessage) => {
    try {
      await options.runtime.recordMessage(message);
    } catch (error) {
      console.error(
        `message gateway recordMessage failed chatId=${message.chatId} messageId=${message.messageId} userId=${message.userId}`,
        error
      );
      throw error;
    }
  };

  const handleTriggerMessage = async (
    message: TelegramMessage,
    decision: TriggerDecision
  ) => {
    if (options.userRoles?.isBlocked(message.userId)) {
      if (decision.shouldTrigger) {
        await options.telegram.reply(message.chatId, BLOCKED_REPLY, message.messageId);
      }
      return;
    }

    if (!decision.shouldTrigger || !decision.prompt) {
      return;
    }

    // 优雅的判定逻辑：
    // 1. 如果是主人说的，永远 1.0 热度。
    // 2. 如果是机器人说的 (metadata.isBot)，应用衰减。
    // 3. 如果是别人回复我 (isReplyToMe)，也应用衰减（防止 Bot 间回复套娃）。
    const isOwner = options.userRoles?.getRole(message.userId) === "owner";
    const isBotLike = !isOwner && (message.metadata.isBot === true || message.metadata.isReplyToMe === true);
    
    const socialState = etiquetteManager.getSocialState(message.chatId, isBotLike);
    
    console.log(`[etiquette] chat=${message.chatId} userId=${message.userId} isOwner=${isOwner} isBotLike=${isBotLike} state=${socialState}`);

    if (socialState === "SILENCE") {
      console.log(`[etiquette] SILENCE triggered for chat ${message.chatId}. Stopping loop.`);
      return;
    }

    const instruction = etiquetteManager.getInstruction(socialState);
    etiquetteManager.updateHeat(message.chatId, isBotLike);

    const streamMessageId = await options.telegram.startStream(
      message.chatId,
      message.messageId
    );

    try {
      let hasOutput = false;
      for await (const chunk of options.runtime.streamReply({
        triggerMessage: message,
        prompt: decision.prompt + instruction,
      })) {
        options.telegram.appendStream(streamMessageId, chunk);
        hasOutput = true;
      }
      if (!hasOutput) {
        options.telegram.appendStream(
          streamMessageId,
          "\n(模型本轮未返回可显示文本，请重试或调整提示词)"
        );
      }
      await options.telegram.endStream(streamMessageId);
    } catch (error) {
      try {
        options.telegram.appendStream(streamMessageId, "\n(生成失败，请稍后重试)");
      } catch {
      }
      try {
        await options.telegram.endStream(streamMessageId);
      } catch (endError) {
        console.error("message gateway endStream failed:", endError);
        await options.telegram.reply(
          message.chatId,
          "生成失败，请稍后重试。",
          message.messageId
        );
      }
      console.error("message gateway stream failed:", error);
    }
  };

  const triggeredMessageIds = new Set<number>();

  const normalizer = createEventNormalizer({
    mergeWindowMs: options.mergeWindowMs,
    onUpsert: (message) => {
      return recordNormalizedMessage(message);
    },
  });

  const flushRecordAndTrigger = async (
    rawMessage: TelegramMessage,
    decision: TriggerDecision
  ) => {
    const flushed = normalizer.flushChatBefore(rawMessage.chatId, rawMessage.timestamp);
    for (const message of flushed) {
      await recordNormalizedMessage(message);
    }

    const triggerMessage =
      flushed.find((message) => message.messageId === rawMessage.messageId) ?? rawMessage;
    if (!flushed.some((message) => message.messageId === triggerMessage.messageId)) {
      await recordNormalizedMessage(triggerMessage);
    }
    await handleTriggerMessage(triggerMessage, decision);
  };

  const unsubscribe = options.telegram.onMessage((rawMessage) => {
    normalizer.ingestMessage(rawMessage);

    void (async () => {
      const decision = await pickDecision(policies, rawMessage, context);
      if (!decision.shouldTrigger || !decision.prompt) {
        return;
      }
      triggeredMessageIds.add(rawMessage.messageId);
      await flushRecordAndTrigger(rawMessage, decision);
    })().catch((error) => {
      console.error("message gateway handler failed:", error);
    });
  });
  const enableEditedTrigger = options.enableEditedMessageTrigger !== false;
  const unsubscribeEdited = options.telegram.onEditedMessage((editedMessage) => {
    normalizer.ingestEditedMessage(editedMessage);

    if (!enableEditedTrigger) {
      return;
    }
    if (triggeredMessageIds.has(editedMessage.messageId)) {
      return;
    }

    void (async () => {
      const decision = await pickDecision(policies, editedMessage, context);
      if (!decision.shouldTrigger || !decision.prompt) {
        return;
      }
      if (triggeredMessageIds.has(editedMessage.messageId)) {
        return;
      }
      triggeredMessageIds.add(editedMessage.messageId);
      await flushRecordAndTrigger(editedMessage, decision);
    })().catch((error) => {
      console.error("message gateway edited handler failed:", error);
    });
  });

  return {
    stop: () => {
      unsubscribe();
      unsubscribeEdited();
      normalizer.stop();
    },
  };
}

async function pickDecision(
  policies: GatewayTriggerPolicy[],
  message: TelegramMessage,
  context: GatewayContext
): Promise<TriggerDecision> {
  for (const policy of policies) {
    const decision = await policy.decide(message, context);
    if (decision.shouldTrigger) {
      return decision;
    }
  }
  return { shouldTrigger: false, reason: "none" };
}
