import type { ClientRuntime } from "./clientRuntime";
import type { TelegramAdapter, TelegramMessage } from "../telegram/types";
import type {
  GatewayContext,
  GatewayTriggerPolicy,
  TriggerDecision,
} from "./types";
import type { UserRolesStore } from "../storage";
import { handleCommand } from "./commandHandler";
import { logger } from "../utils/logger";

const BLOCKED_REPLY = "我不能响应被拉黑的用户喵";

export interface CreateMessageGatewayOptions {
  telegram: TelegramAdapter;
  runtime: ClientRuntime;
  policies: GatewayTriggerPolicy[];
  userRoles?: UserRolesStore;
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

  const unsubscribe = options.telegram.onMessage((message) => {
    void handleMessage(message).catch((error) => {
      console.error("message gateway handler failed:", error);
    });
  });

  const handleMessage = async (message: TelegramMessage) => {
    logger.info("Gateway", `收到消息: ${message.context.slice(0, 50)}${message.context.length > 50 ? "..." : ""}`, { chatId: message.chatId, userId: message.userId });
    await options.runtime.recordMessage(message);

    // track username→userId mapping
    if (options.userRoles && message.metadata.username) {
      options.userRoles.trackUser(message.userId, message.metadata.username);
    }

    // handle /commands before anything else
    if (options.userRoles && /\/(?:block|unblock|status|grant|revoke|help|view_logs|flush_logs)\b/.test(message.context)) {
      const handled = await handleCommand(message, options.userRoles, options.telegram);
      if (handled) return;
    }

    // blocked users get recorded but never trigger agent
    if (options.userRoles?.isBlocked(message.userId)) {
      const wouldTrigger = await pickDecision(policies, message, context);
      if (wouldTrigger.shouldTrigger) {
        await options.telegram.reply(message.chatId, BLOCKED_REPLY, message.messageId);
      }
      return;
    }

    const decision = await pickDecision(policies, message, context);
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
      logger.error("Gateway", "流式回复失败", { error: String(error) });
    }
  };

  return {
    stop: () => unsubscribe(),
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
