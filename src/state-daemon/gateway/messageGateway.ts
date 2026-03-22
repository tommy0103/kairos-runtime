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

// 社交礼仪配置（针对机器人对谈的专项治理）
const ETIQUETTE_CONFIG = {
  decayFactor: 0.3, // 激进的衰减系数，机器人对话快速降温
  recoveryTimeMs: 60 * 60 * 1000, // 恢复周期延长到 1 小时
  idleResetMs: 30 * 60 * 1000, // 30 分钟无活动重置
  terminateThreshold: 0.1, 
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

  updateHeat(chatId: number, isBotLike: boolean, isOwner: boolean = false) {
    if (isOwner) {
      // 只有主人能立刻重置热度
      this.heatMap.set(chatId, { heat: 1.0, lastUpdate: Date.now() });
      return;
    }

    const currentHeat = this.getHeat(chatId);
    
    if (isBotLike) {
      const newHeat = currentHeat * ETIQUETTE_CONFIG.decayFactor;
      console.log(`[etiquette] chat=${chatId} decaying heat: ${currentHeat.toFixed(2)} -> ${newHeat.toFixed(2)}`);
      this.heatMap.set(chatId, {
        heat: newHeat,
        lastUpdate: Date.now()
      });
    } else {
      // 普通非主人用户，不再重置热度，允许随时间缓慢恢复
      this.heatMap.set(chatId, {
        heat: currentHeat,
        lastUpdate: Date.now()
      });
    }
  }

  // 手动强制静默
  forceSilence(chatId: number) {
    this.heatMap.set(chatId, { heat: 0.0, lastUpdate: Date.now() });
  }

  getSocialState(chatId: number, isBotLike: boolean): SocialState {
    // 只有在被判定为 BotLike 对话时，才执行降级/封口逻辑
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

    // 终极保险：手动指令中断对话链
    const trimmedText = message.context.trim().toLowerCase();
    if (trimmedText === "!" || trimmedText === "！" || trimmedText === "!stop" || trimmedText === "！stop") {
      console.log(`[etiquette] Manual interrupt by user ${message.userId} in chat ${message.chatId}`);
      etiquetteManager.forceSilence(message.chatId);
      return;
    }

    if (!decision.shouldTrigger || !decision.prompt) {
      return;
    }

    // 判定 Bot
    const role = options.userRoles?.getRole(message.userId);
    const isOwner = role === "owner";
    const username = (message.metadata.username || "").toLowerCase();
    
    // 满足以下任一条件才视为机器人行为（触发热度衰减）：
    const isBotLike = !isOwner && (
        message.metadata.isBot === true || 
        role === "bot" ||
        username.includes("bot")
    );
    
    // 核心修复：1. 先更新热度
    etiquetteManager.updateHeat(message.chatId, isBotLike, isOwner);
    
    // 2. 再判定（判定扣分后的热度）
    const socialState = etiquetteManager.getSocialState(message.chatId, isBotLike);
    
    console.log(`[etiquette] chat=${message.chatId} userId=${message.userId} isOwner=${isOwner} isBotLike=${isBotLike} heat=${etiquetteManager.getHeat(message.chatId).toFixed(2)} state=${socialState}`);

    if (socialState === "SILENCE") {
      console.log(`[etiquette] SILENCE triggered for chat ${message.chatId}. Stopping loop.`);
      return;
    }

    const instruction = etiquetteManager.getInstruction(socialState);

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

    // 核心修复：物理去重
    if (triggeredMessageIds.has(rawMessage.messageId)) {
      return;
    }

    void (async () => {
      const decision = await pickDecision(policies, rawMessage, context);
      if (!decision.shouldTrigger || !decision.prompt) {
        return;
      }
      // 再次检查去重，防止并发竞态
      if (triggeredMessageIds.has(rawMessage.messageId)) {
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
