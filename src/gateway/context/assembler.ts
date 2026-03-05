import type { LLMMessage } from "../../agent/core/openai";
import type { ContextAssembler } from "./types";

export function createContextAssembler(): ContextAssembler {
  return {
    build: ({ contextMessages, recentMessages, triggerMessage, systemPrompt, userFacts }) => {
      const triggerId = triggerMessage.messageId;
      
      // 过滤并按时间排序最近的消息
      const normalizedRecent = recentMessages
        .filter((item) => item.messageId !== triggerId)
        .slice()
        .sort((a, b) => a.timestamp - b.timestamp);
        
      // 过滤并按时间排序语义相关的历史消息
      const normalizedContext = contextMessages
        .filter((item) => item.messageId !== triggerId)
        .slice()
        .sort((a, b) => a.timestamp - b.timestamp);

      /**
       * 长期记忆事实 (Facts) 组织逻辑：
       * 如果存在 userFacts 且不为空，则将其包装在 <long_term_memory> 标签内。
       * 这是为了让模型了解它对该用户已掌握的事实，作为对话背景。
       */
      const memoryXml = userFacts && userFacts.length > 0
        ? `\n<long_term_memory>\n${userFacts.map(f => `  <fact>${escapeXml(f)}</fact>`).join("\n")}\n</long_term_memory>`
        : "";

      // 构建最终发送给 LLM 的上下文 XML 结构
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
