import type { LLMMessage, TelegramMessage } from "../../../types/message";
import { escapeXml, formatTimestampUtc8 } from "../../../utils/messageXml";

export interface ArchiveAssemblerBuildInput {
  sessionMessages: TelegramMessage[];
  sessionId: string;
  systemPrompt: string;
}

export interface ArchiveAssembler {
  build: (input: ArchiveAssemblerBuildInput) => LLMMessage[];
}

export function createArchiveAssembler(): ArchiveAssembler {
  return {
    build: ({ sessionMessages, sessionId, systemPrompt }) => {
      const sortedMessages = sessionMessages.slice().sort((a, b) => a.timestamp - b.timestamp);
      const xml = `<session_archive id="${escapeXml(sessionId)}">
  <messages>
${sortedMessages.map(formatArchiveMessageNode).join("\n")}
  </messages>
</session_archive>`;

      return [
        { role: "system", content: systemPrompt },
        { role: "user", content: xml },
      ];
    },
  };
}

function formatArchiveMessageNode(message: TelegramMessage): string {
  return `    <message sender_id="${escapeXml(message.userId)}" speaker="${escapeXml(message.metadata.username ?? "unknown")}" timestamp="${formatTimestampUtc8(message.timestamp)}">${escapeXml(message.context)}</message>`;
}
