import type { AgentRuntime } from "../agent";
import type { TelegramAdapter, TelegramMessage } from "../telegram/types";
import type {
  GatewayContext,
  GatewayTriggerPolicy,
  TriggerDecision,
} from "./types";

export interface CreateMessageGatewayOptions {
  telegram: TelegramAdapter;
  runtime: AgentRuntime;
  policies: GatewayTriggerPolicy[];
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
    console.log("handleMessage", message);
    options.runtime.observe(message);
    if (message.metadata.isBot) {
      return;
    }

    const decision = await pickDecision(policies, message, context);
    if (!decision.shouldTrigger || !decision.prompt) {
      return;
    }

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
