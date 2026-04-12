import type { GatewayTriggerPolicy } from "../types";

export function createProbeGateTriggerPolicy(): GatewayTriggerPolicy {
  return {
    name: "ProbeGate",
    priority: 40,
    decide: (message) => {
      if (message.conversationType !== "group" && message.conversationType !== "supergroup") {
        return { shouldTrigger: false, reason: "none" };
      }
      if (message.metadata.isBot) {
        return { shouldTrigger: false, reason: "none" };
      }
      if (message.metadata.isMentionMe || message.metadata.isReplyToMe) {
        return { shouldTrigger: false, reason: "none" };
      }

      const prompt = message.context.trim();
      if (!prompt || prompt.startsWith("/")) {
        return { shouldTrigger: false, reason: "none" };
      }

      return { shouldTrigger: true, reason: "probe_gate", prompt };
    },
  };
}
