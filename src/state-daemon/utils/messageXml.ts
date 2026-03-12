export type MessageNodeInput = {
  metadata: { isBot: boolean; username: string | null };
  timestamp: number;
  context: string;
};

export function formatMessageNode(message: MessageNodeInput): string {
  if (message.metadata.isBot) {
    return `    <agent_message timestamp="${formatTimestampUtc8(message.timestamp)}">${escapeXml(message.context)}</agent_message>`;
  }
  return `    <message speaker="${escapeXml(getSpeaker(message))}" timestamp="${formatTimestampUtc8(message.timestamp)}">${escapeXml(message.context)}</message>`;
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
