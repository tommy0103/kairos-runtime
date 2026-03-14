// export type MessageNodeInput = {
//   metadata: { isBot: boolean; username: string | null };
//   timestamp: number;
//   context: string;
// };
import type { TelegramMessage } from "../types/message";

export function formatNormalMessageNode(message: TelegramMessage, replyToMessage?: TelegramMessage): string {
  const messageTemplate = `id="${message.messageId}" speaker="${escapeXml(getSpeaker(message))}" timestamp="${formatTimestampUtc8(message.timestamp)}" ${message.metadata.replyToMessageId ? `reply_to="${message.metadata.replyToMessageId}"` : ""}`;
  let replyToPreview = replyToMessage ? `<reply_to_preview speaker="${escapeXml(getSpeaker(replyToMessage))}">${escapeXml(replyToMessage.context)}</reply_to_preview>` : "";
  if (message.metadata.replyToMessageId && !replyToMessage) {
    replyToPreview = `<reply_to_preview speaker="unknown">unknown</reply_to_preview>`;
  }
  if (message.metadata.isBot) {
    return `<agent_message ${messageTemplate}>
    ${replyToPreview ? `${replyToPreview}` : ""}
    ${escapeXml(message.context)}
    </agent_message>`;
  }
  return `<message ${messageTemplate}>
  ${replyToPreview ? `${replyToPreview}` : ""}
  ${escapeXml(message.context)}
  </message>`;
}

export function getSpeaker(message: { metadata: { username: string | null } }): string {
  return message.metadata.username ?? "unknown";
}

export function formatTimestampUtc8(timestamp: number): string {
  return new Date(timestamp).toLocaleString("en-US", { timeZone: "Asia/Shanghai" });
}

export function escapeXml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
