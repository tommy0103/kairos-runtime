import type { LLMMessage } from "../../agent/core/openai";
import type { ContextAssembler } from "./types";

export function createContextAssembler(): ContextAssembler {
  return {
    build: ({ contextMessages, recentMessages, triggerMessage, systemPrompt, userFacts }) => {
      const triggerId = triggerMessage.messageId;
      const mode = process.env.CONTEXT_MODE;

      /**
       * 暴力线性模式 (Bruteforce Mode):
       * 彻底关闭 Reranker、Session 分类和事实提取记忆。
       * 将 1M 上下文全部用于填充原始聊天记录，不进行任何语义加工。
       */
      if (mode === "bruteforce") {
        const history = contextMessages
          .filter((m) => m.messageId !== triggerId)
          .sort((a, b) => a.timestamp - b.timestamp)
          .map((m) => `${getSpeaker(m)} [${formatTimestampUtc8(m.timestamp)}]: ${m.context}`)
          .join("\n");

        const payload = `这是我们所有的聊天记录（按时间线排列）：\n\n${history}\n${getSpeaker(triggerMessage)} [${formatTimestampUtc8(triggerMessage.timestamp)}]: ${triggerMessage.context}`;

        return [
          { role: "system", content: `${systemPrompt}\n\n注意：你现在处于暴力历史注入模式，你拥有完整的聊天记忆，请基于以上全量历史进行回答。` },
          { role: "user", content: payload }
        ];
      }
      
      // 传统模式逻辑...
      const normalizedRecent = recentMessages
        .filter((item) => item.messageId !== triggerId)
        .slice()
        .sort((a, b) => a.timestamp - b.timestamp);
        
      const normalizedContext = contextMessages
        .filter((item) => item.messageId !== triggerId)
        .slice()
        .sort((a, b) => a.timestamp - b.timestamp);

      const memoryXml = userFacts && userFacts.length > 0
        ? `\n<long_term_memory>\n${userFacts.map(f => `  <fact>${escapeXml(f)}</fact>`).join("\n")}\n</long_term_memory>`
        : "";

      const xml = `<context>${memoryXml}
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
        { role: "system", content: systemPrompt },
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
