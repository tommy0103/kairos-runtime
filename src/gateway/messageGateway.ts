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

export interface CreateMessageGatewayOptions {
  telegram: TelegramAdapter;
  runtime: ClientRuntime;
  policies: GatewayTriggerPolicy[];
  userRoles?: UserRolesStore;
  mergeWindowMs?: number;
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

  const policies = [...options.policies].sort(
    (a, b) => a.priority - b.priority
  );

  const recordNormalizedMessage = async (message: TelegramMessage) => {
    await options.runtime.recordMessage(message);
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

  const normalizer = createEventNormalizer({
    mergeWindowMs: options.mergeWindowMs,
    onUpsert: (message) => {
      return recordNormalizedMessage(message);
    },
  });

  const unsubscribe = options.telegram.onMessage((rawMessage) => {
    normalizer.ingestMessage(rawMessage);

    void (async () => {
      const decision = await pickDecision(policies, rawMessage, context);
      if (!decision.shouldTrigger || !decision.prompt) {
        return;
      }

      const flushed = normalizer.flushChatBefore(rawMessage.chatId, rawMessage.timestamp);
      // console.log("flushed", flushed);
      for (const message of flushed) {
        await recordNormalizedMessage(message);
      }

      const triggerMessage =
        flushed.find((message) => message.messageId === rawMessage.messageId) ?? rawMessage;
      if (!flushed.some((message) => message.messageId === triggerMessage.messageId)) {
        await recordNormalizedMessage(triggerMessage);
      }
      await handleTriggerMessage(triggerMessage, decision);
    })().catch((error) => {
      console.error("message gateway handler failed:", error);
    });
  });
  const unsubscribeEdited = options.telegram.onEditedMessage((editedMessage) => {
    normalizer.ingestEditedMessage(editedMessage);
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
