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
  decayFactor: 0.7, // 机器人之间对话的热情衰减系数
  recoveryTimeMs: 15 * 60 * 1000, // 15 分钟恢复到 100% 热情
  minHeat: 0.1, 
};

type SocialState = "NORMAL" | "CONCISE" | "WRAP_UP";

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
      currentHeat = currentHeat * ETIQUETTE_CONFIG.decayFactor;
    } else {
      // 真人消息直接重置热度
      currentHeat = 1.0;
    }

    this.heatMap.set(chatId, {
      heat: Math.max(ETIQUETTE_CONFIG.minHeat, currentHeat),
      lastUpdate: Date.now()
    });
  }

  getSocialState(chatId: number, isBotInteraction: boolean): SocialState {
    if (!isBotInteraction) return "NORMAL";
    
    const heat = this.getHeat(chatId);
    if (heat > 0.7) return "NORMAL";
    if (heat > 0.4) return "CONCISE";
    return "WRAP_UP";
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
    console.log("handleMessage", message);

    if (options.userRoles?.isBlocked(message.userId)) {
      if (decision.shouldTrigger) {
        await options.telegram.reply(message.chatId, BLOCKED_REPLY, message.messageId);
      }
      return;
    }

    if (!decision.shouldTrigger || !decision.prompt) {
      return;
    }

    // 社交礼仪处理
    const isBotInteraction = message.metadata.isBot === true;
    const socialState = etiquetteManager.getSocialState(message.chatId, isBotInteraction);
    const instruction = etiquetteManager.getInstruction(socialState);
    
    // 更新热度（在生成前更新，以便下一次消息能看到最新的热度）
    etiquetteManager.updateHeat(message.chatId, isBotInteraction);

    const streamMessageId = await options.telegram.startStream(
      message.chatId,
      message.messageId
    );

    try {
      let hasOutput = false;
      for await (const chunk of options.runtime.streamReply({
        triggerMessage: message,
        // 将社交指令注入 Prompt
        prompt: decision.prompt + instruction,
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
