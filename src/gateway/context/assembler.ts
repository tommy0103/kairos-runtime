import type { LLMMessage } from "../../agent/core/openai";
import type { ContextAssembler } from "./types";

export function createContextAssembler(): ContextAssembler {
  return {
    build: ({ contextMessages, recentMessages, triggerMessage, systemPrompt }) => {
      const triggerId = triggerMessage.messageId;
      const normalizedRecent = recentMessages
        .filter((item) => item.messageId !== triggerId)
        .slice()
        .sort((a, b) => a.timestamp - b.timestamp);
      const normalizedContext = contextMessages
        .filter((item) => item.messageId !== triggerId)
        .slice()
        .sort((a, b) => a.timestamp - b.timestamp);

      const xml = `<context>
  <recent_messages>
${normalizedRecent.map(formatMessageNode).join("\n")}
  </recent_messages>
  <related_history>
${normalizedContext.map(formatHistoryNode).join("\n")}
  </related_history>
</context>
<current_message speaker="${escapeXml(getSpeaker(triggerMessage))}" timestamp="${formatTimestampUtc8(triggerMessage.timestamp)}">
  ${escapeXml(triggerMessage.context)}
</current_message>`;

      return [
        { role: "system", content: systemPrompt},
        { role: "user", content: xml }
      ];
    },
  };
}

function formatMessageNode(message: { metadata: { username: string | null }; timestamp: number; context: string }): string {
  return `    <message speaker="${escapeXml(getSpeaker(message))}" timestamp="${formatTimestampUtc8(message.timestamp)}">${escapeXml(message.context)}</message>`;
}

function formatHistoryNode(message: {
  metadata: { isBot: boolean; username: string | null };
  timestamp: number;
  context: string;
}): string {
  if (message.metadata.isBot) {
    return `    <agent_message timestamp="${formatTimestampUtc8(message.timestamp)}">${escapeXml(message.context)}</agent_message>`;
  }
  return `    <message speaker="${escapeXml(getSpeaker(message))}" timestamp="${formatTimestampUtc8(message.timestamp)}">${escapeXml(message.context)}</message>`;
}

function getSpeaker(message: { metadata: { username: string | null } }): string {
  return message.metadata.username ?? "unknown";
}

function formatTimestampUtc8(timestamp: number): string {
  // const date = new Date(timestamp + 8 * 60 * 60 * 1000);
  // const iso = date.toISOString().replace("T", " ").slice(0, 19);
  // return `${iso} UTC+8`;
  return new Date(timestamp + 8 * 60 * 60 * 1000).toLocaleString('en-US', { timeZone: 'Asia/Shanghai' })
}

function escapeXml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
