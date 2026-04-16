import type { ClientRuntime, RuntimeReplyStreamEvent } from "./clientRuntime";
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
        return "\n\n[System note: This conversation is getting long. Keep the reply concise.]";
      case "WRAP_UP":
        return "\n\n[System note: This conversation is very long. Politely wrap up and avoid extending it.]";
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
  probe?: {
    enabled?: boolean;
    cooldownMs?: number;
  };
}

export interface MessageGateway {
  stop: () => void;
}

const DEFAULT_LONG_WAIT_HINT_DELAY_MS = 120000;
const TYPING_REFRESH_MS = 4000;
const DEFAULT_SEND_MESSAGE_MODE = "strict";
const DEFAULT_GROUP_REPLY_SOFT_LIMIT = 400;
type SendMessageMode = "strict" | "compat";

function resolveSendMessageMode(): SendMessageMode {
  const raw = process.env.ENCLAVE_SEND_MESSAGE_MODE?.trim().toLowerCase();
  if (raw === "compat") {
    return "compat";
  }
  return DEFAULT_SEND_MESSAGE_MODE;
}

function resolveLongWaitHintDelayMs(): number {
  const raw = process.env.ENCLAVE_LONG_WAIT_HINT_MS?.trim();
  if (!raw) {
    return DEFAULT_LONG_WAIT_HINT_DELAY_MS;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_LONG_WAIT_HINT_DELAY_MS;
  }
  return parsed;
}


function resolveGroupReplySoftLimit(): number {
  const raw = process.env.STATE_DAEMON_GROUP_REPLY_SOFT_LIMIT?.trim();
  if (!raw) {
    return DEFAULT_GROUP_REPLY_SOFT_LIMIT;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_GROUP_REPLY_SOFT_LIMIT;
  }
  return Math.min(4000, Math.max(20, parsed));
}

function isGroupConversationType(conversationType: TelegramMessage["conversationType"]): boolean {
  return conversationType === "group" || conversationType === "supergroup";
}

function splitGroupReplyText(text: string, softLimit: number): string[] {
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }

  // If the message contains code blocks, do not split it at all.
  // We trust the model's decision to keep it as a single coherent unit.
  if (trimmed.includes("```")) {
    return [trimmed];
  }

  if (trimmed.length <= softLimit) {
    return [trimmed];
  }

  const paragraphs = trimmed
    .split(/\n+/)
    .map((part) => part.trim())
    .filter(Boolean);
  const fragments: string[] = [];
  for (const paragraph of paragraphs) {
    const parts = paragraph.match(/[^。！？!?；;…]+[。！？!?；;…]?/g) ?? [paragraph];
    for (const part of parts) {
      const clean = part.trim();
      if (clean) {
        fragments.push(clean);
      }
    }
  }

  const chunks: string[] = [];
  let current = "";

  const flushCurrent = () => {
    const normalized = current.trim();
    if (normalized) {
      chunks.push(normalized);
    }
    current = "";
  };

  for (const fragment of fragments) {
    if (fragment.length > softLimit) {
      flushCurrent();
      for (let index = 0; index < fragment.length; index += softLimit) {
        const slice = fragment.slice(index, index + softLimit).trim();
        if (slice) {
          chunks.push(slice);
        }
      }
      continue;
    }

    if (!current) {
      current = fragment;
      continue;
    }

    const joiner = /[A-Za-z0-9]$/.test(current) && /^[A-Za-z0-9]/.test(fragment) ? " " : "";
    const next = `${current}${joiner}${fragment}`;
    if (next.length <= softLimit) {
      current = next;
      continue;
    }

    flushCurrent();
    current = fragment;
  }

  flushCurrent();
  return chunks.length > 0 ? chunks : [trimmed];
}
function estimateReplyEtaSeconds(message: TelegramMessage): { min: number; max: number } {
  let min = 30;
  let max = 90;
  const hasImage = (message.imageUrls?.length ?? 0) > 0;
  if (hasImage) {
    min += 20;
    max += 50;
  }
  const textLength = message.context.trim().length;
  if (textLength > 400) {
    min += 10;
    max += 25;
  }
  if (textLength > 1200) {
    min += 15;
    max += 40;
  }
  return { min, max };
}

function toEtaHintText(eta: { min: number; max: number }): string {
  if (eta.max >= 120) {
    const minMinutes = Math.max(1, Math.floor(eta.min / 60));
    const maxMinutes = Math.max(minMinutes + 1, Math.ceil(eta.max / 60));
    return `Estimated ${minMinutes}-${maxMinutes} minutes.`;
  }
  return `Estimated ${eta.min}-${eta.max} seconds.`;
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
  const probeEnabled = options.probe?.enabled ?? false;
  const probeCooldownMs = Math.max(0, options.probe?.cooldownMs ?? 45000);
  const sendMessageMode = resolveSendMessageMode();
  const longWaitHintDelayMs = resolveLongWaitHintDelayMs();
  const groupReplySoftLimit = resolveGroupReplySoftLimit();
  const lastProbeAtByChat = new Map<number, number>();

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
    if (trimmedText === "!stop" || trimmedText === "！stop") {
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

    if (decision.reason === "probe_gate") {
      if (!probeEnabled) {
        return;
      }
      const now = Date.now();
      const lastProbeAt = lastProbeAtByChat.get(message.chatId) ?? 0;
      if (now - lastProbeAt < probeCooldownMs) {
        return;
      }
      lastProbeAtByChat.set(message.chatId, now);
      try {
        const probeResult = await options.runtime.probeShouldReply({
          triggerMessage: message,
        });
        console.log(
          `[probe] chat=${message.chatId} messageId=${message.messageId} shouldReply=${probeResult.shouldReply} reason=${probeResult.reason}`
        );
        if (!probeResult.shouldReply) {
          return;
        }
      } catch (error) {
        console.error("message gateway probe failed, suppressing auto-reply:", error);
        return;
      }
    }
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

    const deliverMediaBatch = async (event: Extract<RuntimeReplyStreamEvent, { type: "send_file" }>) => {
      const replyToMessageId = event.replyToMessageId ?? message.messageId;
      const result = await options.telegram.sendMediaBatch(
        message.chatId,
        event.items,
        {
          caption: event.caption,
          replyToMessageId,
        }
      );

      if (result.failures.length > 0) {
        console.warn(
          `[message gateway] media send had failures chatId=${message.chatId} sent=${result.sentCount} failed=${result.failures.length}`
        );
      }

      return result;
    };

    if (sendMessageMode === "compat") {
      const eta = estimateReplyEtaSeconds(message);
      const streamMessageId = await options.telegram.startStream(
        message.chatId,
        message.messageId,
        `Working on it... ${toEtaHintText(eta)}`
      );
      let lastStatus = "";
      const applyStatus = (event: RuntimeReplyStreamEvent | string) => {
        const text = typeof event === "string"
          ? event
          : event.type === "status_update"
            ? event.text
            : "";
        const normalized = text.trim();
        if (!normalized || normalized === lastStatus) {
          return;
        }
        lastStatus = normalized;
        void options.telegram.setStreamStatus(streamMessageId, normalized).catch((error) => {
          console.error("message gateway setStreamStatus failed:", error);
        });
      };
      const longWaitTimer = setTimeout(() => {
        applyStatus(
          "This is taking longer than usual. Feel free to do something else; I will post the final reply when done."
        );
      }, longWaitHintDelayMs);

      try {
        let hasOutput = false;
        let hasTextOutput = false;
        for await (const event of options.runtime.streamReply({
          triggerMessage: message,
          prompt: instruction,
          isProbeActivated: decision.reason === "probe_gate",
          triggerReason: decision.reason,
        })) {
          if (event.type === "status_update") {
            applyStatus(event);
            continue;
          }
          if (event.type === "send_message") {
            const chunk = event.text.trim();
            if (chunk) {
              const needsSpacer = hasTextOutput;
              options.telegram.appendStream(
                streamMessageId,
                needsSpacer ? `\n\n${chunk}` : chunk
              );
              hasOutput = true;
              hasTextOutput = true;
            }
            continue;
          }
          if (event.type === "send_file") {
            const mediaResult = await deliverMediaBatch(event);
            if (mediaResult.sentCount > 0) {
              hasOutput = true;
            }
            if (mediaResult.sentCount === 0 && mediaResult.failures.length > 0) {
              options.telegram.appendStream(
                streamMessageId,
                "\n(Failed to send media files in this run.)"
              );
              hasOutput = true;
              hasTextOutput = true;
            }
            continue;
          }
          if (event.type === "message_delta") {
            options.telegram.appendStream(streamMessageId, event.delta);
            hasOutput = true;
            hasTextOutput = true;
          }
        }
        if (!hasOutput) {
          options.telegram.appendStream(
            streamMessageId,
            "\n(Model returned no displayable text in this turn. Please retry.)"
          );
        } else if (!hasTextOutput) {
          options.telegram.appendStream(
            streamMessageId,
            "\n(Media delivered.)"
          );
        }
        await options.telegram.endStream(streamMessageId);
      } catch (error) {
        try {
          options.telegram.appendStream(
            streamMessageId,
            "\n(Generation failed, please retry in a moment.)"
          );
        } catch {
        }
        try {
          await options.telegram.endStream(streamMessageId);
        } catch (endError) {
          console.error("message gateway endStream failed:", endError);
          await options.telegram.reply(
            message.chatId,
            "Generation failed, please retry in a moment.",
            message.messageId
          );
        }
        console.error("message gateway stream failed:", error);
      } finally {
        clearTimeout(longWaitTimer);
      }
      return;
    }

    let typingTimer: ReturnType<typeof setInterval> | null = null;
    let longWaitTimer: ReturnType<typeof setTimeout> | null = null;
    let sentMessagesCount = 0;
    const strictFallbackTextChunks: string[] = [];
    let longWaitHintSent = false;
    try {
      await options.telegram.sendTyping(message.chatId);
      typingTimer = setInterval(() => {
        void options.telegram.sendTyping(message.chatId).catch((error) => {
          console.error("message gateway sendTyping failed:", error);
        });
      }, TYPING_REFRESH_MS);

      if (longWaitHintDelayMs > 0) {
        longWaitTimer = setTimeout(() => {
          if (sentMessagesCount > 0 || longWaitHintSent) {
            return;
          }
          longWaitHintSent = true;
          void options.telegram.reply(
            message.chatId,
            "Still working on it, I will send messages as they are ready.",
            message.messageId
          ).catch((error) => {
            console.error("message gateway long-wait hint failed:", error);
          });
        }, longWaitHintDelayMs);
      }

      for await (const event of options.runtime.streamReply({
          triggerMessage: message,
          prompt: instruction,
          isProbeActivated: decision.reason === "probe_gate",
          triggerReason: decision.reason,
        })) {
        if (event.type === "status_update") {
          continue;
        }
        if (event.type === "send_message") {
          const replyToMessageId = event.replyToMessageId ?? message.messageId;
          const replyChunks = isGroupConversationType(message.conversationType)
            ? splitGroupReplyText(event.text, groupReplySoftLimit)
            : [event.text.trim()].filter(Boolean);
          for (const replyChunk of replyChunks) {
            await options.telegram.reply(
              message.chatId,
              replyChunk,
              replyToMessageId
            );
            sentMessagesCount += 1;
          }
          continue;
        }
        if (event.type === "send_file") {
          const mediaResult = await deliverMediaBatch(event);
          if (mediaResult.sentCount > 0) {
            sentMessagesCount += 1;
          }
          if (mediaResult.sentCount === 0 && mediaResult.failures.length > 0) {
            await options.telegram.reply(
              message.chatId,
              "Failed to send media files, please retry.",
              event.replyToMessageId ?? message.messageId
            );
            sentMessagesCount += 1;
          }
          continue;
        }
        if (event.type === "message_delta" && event.delta) {
          strictFallbackTextChunks.push(event.delta);
        }
      }
      if (sentMessagesCount === 0) {
        const fallbackText = strictFallbackTextChunks.join("").trim();
        if (fallbackText) {
          const fallbackChunks = isGroupConversationType(message.conversationType)
            ? splitGroupReplyText(fallbackText, groupReplySoftLimit)
            : [fallbackText];
          for (const fallbackChunk of fallbackChunks) {
            await options.telegram.reply(
              message.chatId,
              fallbackChunk,
              message.messageId
            );
            sentMessagesCount += 1;
          }
        }
      }
    } catch (error) {
      await options.telegram.reply(
        message.chatId,
        "Generation failed, please retry in a moment.",
        message.messageId
      );
      console.error("message gateway stream failed:", error);
    } finally {
      if (typingTimer) {
        clearInterval(typingTimer);
      }
      if (longWaitTimer) {
        clearTimeout(longWaitTimer);
      }
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
