import type { LLMMessage } from "../types/message";

export interface StreamReplyRequest {
  chatId: number | string;
  messages: LLMMessage[];
  imageUrls?: string[];
}

export type EnclaveOutgoingMediaType = "image" | "audio" | "file";

export interface EnclaveOutgoingMediaItem {
  source: string;
  type: EnclaveOutgoingMediaType;
  mimeType?: string;
  fileName?: string;
}

export type EnclaveStreamEvent =
  | {
      type: "message_update";
      role: "assistant";
      delta: string;
    }
  | {
      type: "send_message";
      delta: string;
      toolCallId?: string;
      awaitResponse?: boolean;
      replyTo?: string;
    }
  | {
      type: "send_file";
      items: EnclaveOutgoingMediaItem[];
      caption?: string;
      toolCallId?: string;
      awaitResponse?: boolean;
      replyTo?: string;
    }
  | {
      type: "tool_execution_start";
      toolName: string;
      toolCallId?: string;
    }
  | {
      type: "tool_execution_end";
      toolName: string;
      toolCallId?: string;
      result?: unknown;
    }
  | {
      type: "tool_mutation";
      mutationType: "add" | "remove" | "update";
      toolName: string;
      jsonSchema: string;
      tsCode: string;
    }
  | {
      type: "completed";
    }
  | {
      type: "failed";
      error: string;
    };

export interface AgentEnclaveClient {
  streamReply: (
    request: StreamReplyRequest
  ) => AsyncIterable<EnclaveStreamEvent>;
}
