import { escapeXml, formatMessageNode, formatTimestampUtc8, getSpeaker } from "../../utils/messageXml";
import type { ContextAssembler } from "./core/types";

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
${normalizedContext.map(formatMessageNode).join("\n")}
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
