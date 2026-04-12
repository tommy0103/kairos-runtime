import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@mariozechner/pi-ai";

const MAX_TEXT_CHARS = 4000;

interface SendMessageDetails {
  text: string;
  replyTo?: string;
  awaitResponse: boolean;
}

function normalizeReplyTo(input: unknown): string | undefined {
  if (typeof input === "number" && Number.isFinite(input)) {
    return String(Math.trunc(input));
  }
  if (typeof input === "string") {
    const normalized = input.trim();
    return normalized.length > 0 ? normalized : undefined;
  }
  return undefined;
}

export function createSendMessageTool(): AgentTool<any, SendMessageDetails> {
  return {
    name: "send_message",
    label: "Send message",
    description:
      "Queue a user-visible message for delivery in the current conversation. This is the primary output channel.",
    parameters: Type.Object({
      text: Type.String({
        description: "Message text to send to the user.",
      }),
      reply_to: Type.Optional(
        Type.Union(
          [Type.String(), Type.Number()],
          { description: "Optional message id to reply to." }
        )
      ),
      await_response: Type.Optional(
        Type.Boolean({
          description:
            "Set true if you will continue with additional tool calls after sending this message.",
        })
      ),
    }),
    execute: async (_toolCallId, params) => {
      const text = params.text.trim();
      if (!text) {
        throw new Error("send_message.text cannot be empty.");
      }
      if (text.length > MAX_TEXT_CHARS) {
        throw new Error(`send_message.text too long. Max ${MAX_TEXT_CHARS} chars.`);
      }
      const replyTo = normalizeReplyTo(params.reply_to);
      const awaitResponse = params.await_response === true;

      return {
        content: [{ type: "text", text: `Queued message (${text.length} chars).` }],
        details: {
          text,
          replyTo,
          awaitResponse,
        },
      };
    },
  };
}
