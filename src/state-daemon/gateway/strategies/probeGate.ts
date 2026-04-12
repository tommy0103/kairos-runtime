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
      // Skip probe for likely mentions to other bots/services in group chat.
      if (prompt.includes("@")) {
        return { shouldTrigger: false, reason: "none" };
      }
      // Skip low-signal noise like "...", "??", "ok", etc.
      const signalText = prompt.replace(/[\s\p{P}\p{S}]/gu, "");
      if (signalText.length < 3) {
        return { shouldTrigger: false, reason: "none" };
      }

      return { shouldTrigger: true, reason: "probe_gate", prompt };
    },
  };
}
