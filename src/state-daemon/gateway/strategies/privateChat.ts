import type { GatewayTriggerPolicy } from "../types";

export function createPrivateChatTriggerPolicy(): GatewayTriggerPolicy {
  return {
    name: "PrivateChat",
    priority: 30,
    decide: (message) => {
      if (message.conversationType !== "private") {
        return { shouldTrigger: false, reason: "none" };
      }
      if (message.metadata.isBot) {
        return { shouldTrigger: false, reason: "none" };
      }
      const prompt = message.context.trim();
      if (!prompt) {
        return { shouldTrigger: false, reason: "none" };
      }
      return { shouldTrigger: true, reason: "private_chat", prompt };
    },
  };
}
