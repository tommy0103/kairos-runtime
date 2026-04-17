import { escapeXml, formatNormalMessageNode, formatTimestampUtc8, getSpeaker } from "../../utils/messageXml";
import type { ContextAssembler } from "./core/types";
import type { TelegramMessage } from "../../types/message";

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
      const messageIndex = new Map<number, TelegramMessage>();
      for (const message of normalizedRecent) {
        messageIndex.set(message.messageId, message);
      }
      for (const message of normalizedContext) {
        messageIndex.set(message.messageId, message);
      }

      const findReplyTarget = (replyToMessageId: number | null): TelegramMessage | undefined => {
        if (replyToMessageId === null) {
          return undefined;
        }
        return messageIndex.get(replyToMessageId);
      };

      const currentReplyPreview = buildReplyPreviewNode(
        triggerMessage,
        findReplyTarget(triggerMessage.metadata.replyToMessageId),
      );
      const currentReplyToAttribute = triggerMessage.metadata.replyToMessageId
        ? ` reply_to="${triggerMessage.metadata.replyToMessageId}"`
        : "";

      const xml = `<context>
  <recent_messages>
${normalizedRecent.map((message) => formatNormalMessageNode(message, 
  findReplyTarget(message.metadata.replyToMessageId))).join("\n")}
  </recent_messages>
  <related_history>
${normalizedContext.map((message) => formatNormalMessageNode(message, 
  findReplyTarget(message.metadata.replyToMessageId))).join("\n")}
  </related_history>
</context>
<current_message id="${triggerMessage.messageId}" speaker="${escapeXml(getSpeaker(triggerMessage))}" timestamp="${formatTimestampUtc8(triggerMessage.timestamp)}"${currentReplyToAttribute}>
  ${currentReplyPreview}
  ${escapeXml(triggerMessage.context)}
</current_message>`;

      return [
        { role: "system", content: systemPrompt},
        { role: "user", content: xml }
      ];
    },
  };
}

function buildReplyPreviewNode(
  message: TelegramMessage,
  replyToMessage?: TelegramMessage
): string {
  if (replyToMessage) {
    return `<reply_to_preview speaker="${escapeXml(getSpeaker(replyToMessage))}">${escapeXml(replyToMessage.context)}</reply_to_preview>`;
  }
  if (message.metadata.replyToMessageId) {
    const fallbackSpeaker =
      (message.metadata.replyToUsername ?? "").trim() ||
      (message.metadata.replyToUserId ?? "").trim() ||
      "unknown";
    const fallbackText =
      (message.metadata.replyToPreviewText ?? "").trim() ||
      `unavailable (reply_to=${message.metadata.replyToMessageId})`;
    return `<reply_to_preview speaker="${escapeXml(fallbackSpeaker)}">${escapeXml(fallbackText)}</reply_to_preview>`;
  }
  return "";
}
