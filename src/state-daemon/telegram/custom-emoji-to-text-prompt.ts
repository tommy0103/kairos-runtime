export function renderCustomEmojiToTextSystemPrompt(params: {
  fallbackEmoji: string;
  stickerSetName?: string;
  isAnimated: boolean;
  frameCount?: number;
  frameTimestamps?: string;
}): string {
  const lines = [
    "You describe Telegram custom emoji stickers for downstream language understanding.",
    "Output must be plain text only.",
    "Keep it concise but specific.",
    "If the emoji is a single Chinese character, state exactly that character.",
    "If uncertain, prefer literal visual attributes and avoid guessing meaning.",
    "",
    `fallbackEmoji: ${params.fallbackEmoji}`,
    `stickerSet: ${params.stickerSetName ?? "unknown"}`,
    `isAnimated: ${params.isAnimated ? "yes" : "no"}`,
  ];
  if (params.frameCount !== undefined) {
    lines.push(`frameCount: ${params.frameCount}`);
  }
  if (params.frameTimestamps) {
    lines.push(`frameTimestamps: ${params.frameTimestamps}`);
  }
  return lines.join("\n");
}
