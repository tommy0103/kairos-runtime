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
  decayFactor: 0.6, // 机器人之间对话的热情衰减系数
  recoveryTimeMs: 10 * 60 * 1000, // 10 分钟恢复到 100% 热情
  minHeat: 0.1, // 最低保留 10% 的概率（留点火种）
};

class SocialEtiquetteManager {
  private heatMap = new Map<number, { heat: number; lastUpdate: number }>();

  getHeat(chatId: number): number {
    const entry = this.heatMap.get(chatId);
    if (!entry) return 1.0;

    const elapsed = Date.now() - entry.lastUpdate;
    const recovery = elapsed / ETIQUETTE_CONFIG.recoveryTimeMs;
    const currentHeat = Math.min(1.0, entry.heat + recovery);
    
    return Math.max(ETIQUETTE_CONFIG.minHeat, currentHeat);
  }

  updateHeat(chatId: number, isBotInteraction: boolean) {
    let currentHeat = this.getHeat(chatId);
    
    if (isBotInteraction) {
      // 机器人对话，热情度降低
      currentHeat = currentHeat * ETIQUETTE_CONFIG.decayFactor;
    } else {
      // 人类对话，热情度立即重置
      currentHeat = 1.0;
    }

    this.heatMap.set(chatId, {
      heat: Math.max(ETIQUETTE_CONFIG.minHeat, currentHeat),
      lastUpdate: Date.now()
    });
  }

  shouldRespond(chatId: number, isBotInteraction: boolean): { allowed: boolean; heat: number } {
    if (!isBotInteraction) return { allowed: true, heat: 1.0 };
    
    const heat = this.getHeat(chatId);
    const random = Math.random();
    const allowed = random < heat;
    
    console.log(`[etiquette] chat=${chatId} isBot=true heat=${heat.toFixed(2)} roll=${random.toFixed(2)} result=${allowed}`);
    return { allowed, heat };
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
    console.log("handleMessage", message);

    // blocked users get recorded but never trigger agent
    if (options.userRoles?.isBlocked(message.userId)) {
      if (decision.shouldTrigger) {
        await options.telegram.reply(message.chatId, BLOCKED_REPLY, message.messageId);
      }
      return;
    }

    if (!decision.shouldTrigger || !decision.prompt) {
      return;
    }

    // 社交礼仪检查：如果是来自 Bot 的触发，判定概率
    const isBotInteraction = message.metadata.isBot || message.metadata.isReplyToMe; // 简单判定：如果是回复我也按互动算
    const etiquette = etiquetteManager.shouldRespond(message.chatId, isBotInteraction);
    
    if (!etiquette.allowed) {
      console.log(`[etiquette] skipped response to bot-like user ${message.userId} in chat ${message.chatId} (heat too low)`);
      return;
    }

    // 确定要回复，更新热度
    etiquetteManager.updateHeat(message.chatId, isBotInteraction);

    // console.log("streamMessage", message);
    const streamMessageId = await options.telegram.startStream(
      message.chatId,
      message.messageId
    );

    try {
      let hasOutput = false;
      for await (const chunk of options.runtime.streamReply({
        triggerMessage: message,
        prompt: decision.prompt,
      })) {
        console.log("append stream", chunk);
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
        // Stream may already be closed; ignore append failure.
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
