import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AgentEnclaveClient,
  EnclaveOutgoingMediaItem,
  EnclaveStreamEvent,
  StreamReplyRequest,
} from "./protocol";

const CURRENT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROTO_PATH = resolve(CURRENT_DIR, "./proto/enclave.proto");
const MAX_GRPC_MESSAGE_BYTES = 16 * 1024 * 1024;
const DEFAULT_ENCLAVE_TARGET =
  process.env.AGENT_ENCLAVE_TARGET ??
  process.env.KAIROS_ENCLAVE_SOCKET ??
  "unix:///run/kairos-runtime/sockets/kairos-runtime-enclave.sock";

interface CreateGrpcEnclaveClientOptions {
  target?: string;
  protoPath?: string;
  metadata?: Record<string, string>;
}

interface GrpcStreamReplyRequest {
  chat_id: string;
  messages: Array<{
    role: string;
    content: string;
  }>;
  image_urls: string[];
}

interface GrpcStreamReplyEvent {
  type?: string;
  role?: string;
  delta?: string;
  tool_name?: string;
  tool_call_id?: string;
  result_json?: string;
  await_response?: boolean;
  reply_to?: string;
  error?: string;
}

interface GrpcServiceClient {
  StreamReply(
    request: GrpcStreamReplyRequest,
    metadata?: grpc.Metadata
  ): grpc.ClientReadableStream<GrpcStreamReplyEvent>;
}

let grpcClientCtor: grpc.ServiceClientConstructor | null = null;

function getGrpcClientCtor(protoPath: string): grpc.ServiceClientConstructor {
  if (grpcClientCtor) {
    return grpcClientCtor;
  }
  const packageDefinition = protoLoader.loadSync(protoPath, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const loaded = grpc.loadPackageDefinition(packageDefinition) as {
    kairos?: {
      enclave?: {
        v1?: {
          AgentEnclaveService?: grpc.ServiceClientConstructor;
        };
      };
    };
  };
  const ctor = loaded.kairos?.enclave?.v1?.AgentEnclaveService;
  if (!ctor) {
    throw new Error("Failed to load AgentEnclaveService from proto definition.");
  }
  grpcClientCtor = ctor;
  return ctor;
}

function toGrpcRequest(request: StreamReplyRequest): GrpcStreamReplyRequest {
  return {
    chat_id: String(request.chatId),
    messages: request.messages.map((item) => ({
      role: item.role,
      content: item.content,
    })),
    image_urls: request.imageUrls ?? [],
  };
}

function toMetadata(data?: Record<string, string>): grpc.Metadata | undefined {
  if (!data || Object.keys(data).length === 0) {
    return undefined;
  }
  const metadata = new grpc.Metadata();
  for (const [key, value] of Object.entries(data)) {
    metadata.set(key, value);
  }
  return metadata;
}

function parseSendFilePayload(raw: string | undefined): {
  items: EnclaveOutgoingMediaItem[];
  caption?: string;
} | null {
  if (!raw) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const payload = parsed as {
    items?: Array<{
      source?: unknown;
      type?: unknown;
      mimeType?: unknown;
      fileName?: unknown;
    }>;
    caption?: unknown;
  };

  if (!Array.isArray(payload.items) || payload.items.length === 0) {
    return null;
  }

  const items: EnclaveOutgoingMediaItem[] = [];
  for (const item of payload.items) {
    const source = typeof item?.source === "string" ? item.source.trim() : "";
    const type = item?.type;
    if (!source) {
      continue;
    }
    if (type !== "image" && type !== "audio" && type !== "file") {
      continue;
    }
    const mimeType =
      typeof item?.mimeType === "string" && item.mimeType.trim()
        ? item.mimeType.trim()
        : undefined;
    const fileName =
      typeof item?.fileName === "string" && item.fileName.trim()
        ? item.fileName.trim()
        : undefined;

    items.push({ source, type, mimeType, fileName });
  }

  if (items.length === 0) {
    return null;
  }

  const caption =
    typeof payload.caption === "string" && payload.caption.trim()
      ? payload.caption.trim()
      : undefined;

  return { items, caption };
}

function mapGrpcEvent(event: GrpcStreamReplyEvent): EnclaveStreamEvent {
  const type = event.type ?? "";
  if (type === "message_update") {
    return {
      type: "message_update",
      role: "assistant",
      delta: event.delta ?? "",
    };
  }
  if (type === "send_message") {
    return {
      type: "send_message",
      delta: event.delta ?? "",
      toolCallId: event.tool_call_id,
      awaitResponse: event.await_response ?? false,
      replyTo: event.reply_to,
    };
  }
  if (type === "send_file") {
    const payload = parseSendFilePayload(event.result_json);
    if (!payload) {
      return {
        type: "failed",
        error: "Invalid send_file payload from enclave runtime.",
      };
    }
    return {
      type: "send_file",
      items: payload.items,
      caption: payload.caption,
      toolCallId: event.tool_call_id,
      awaitResponse: event.await_response ?? false,
      replyTo: event.reply_to,
    };
  }
  if (type === "tool_execution_start") {
    return {
      type: "tool_execution_start",
      toolName: event.tool_name ?? "",
      toolCallId: event.tool_call_id,
    };
  }
  if (type === "tool_execution_end") {
    let result: unknown;
    if (event.result_json) {
      try {
        result = JSON.parse(event.result_json);
      } catch {
        result = event.result_json;
      }
    }
    return {
      type: "tool_execution_end",
      toolName: event.tool_name ?? "",
      toolCallId: event.tool_call_id,
      result,
    };
  }
  if (type === "failed") {
    return {
      type: "failed",
      error: event.error ?? "AgentEnclave stream failed.",
    };
  }
  return { type: "completed" };
}

async function* streamFromGrpc(
  client: GrpcServiceClient,
  request: StreamReplyRequest,
  target: string,
  metadata?: grpc.Metadata
): AsyncGenerator<EnclaveStreamEvent, void, unknown> {
  const maxRetries =
    Number.parseInt(process.env.ENCLAVE_CONNECT_RETRIES ?? "120", 10) || 120;
  const retryDelayMs =
    Number.parseInt(process.env.ENCLAVE_CONNECT_RETRY_DELAY_MS ?? "500", 10) || 500;
  const unixPath = parseUnixSocketPath(target);

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const call = client.StreamReply(toGrpcRequest(request), metadata);
    let emittedAnyEvent = false;
    try {
      for await (const rawEvent of call as AsyncIterable<GrpcStreamReplyEvent>) {
        emittedAnyEvent = true;
        yield mapGrpcEvent(rawEvent);
      }
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const retryable = !emittedAnyEvent && isRetryableEnclaveConnectError(message);
      if (retryable && (attempt === 0 || attempt % 10 === 0)) {
        const visible = unixPath ? existsSync(unixPath) : null;
        console.warn(
          `[state-daemon] enclave connect retry attempt=${attempt}/${maxRetries} target=${target} socket_visible=${visible}`
        );
      }
      if (retryable && attempt < maxRetries) {
        await sleep(retryDelayMs);
        continue;
      }
      yield {
        type: "failed",
        error: `enclave grpc failed (target=${target}): ${message}`,
      };
      return;
    }
  }
}

export function createGrpcEnclaveClient(
  options: CreateGrpcEnclaveClientOptions
): AgentEnclaveClient {
  const protoPath = options.protoPath ?? DEFAULT_PROTO_PATH;
  const target = normalizeGrpcTarget(options.target ?? DEFAULT_ENCLAVE_TARGET);
  const ServiceCtor = getGrpcClientCtor(protoPath);
  const client = new ServiceCtor(target, grpc.credentials.createInsecure(), {
    "grpc.max_send_message_length": MAX_GRPC_MESSAGE_BYTES,
    "grpc.max_receive_message_length": MAX_GRPC_MESSAGE_BYTES,
  }) as unknown as GrpcServiceClient;
  const metadata = toMetadata(options.metadata);
  return {
    streamReply: (request: StreamReplyRequest) =>
      streamFromGrpc(client, request, target, metadata),
  };
}

function normalizeGrpcTarget(target: string): string {
  const normalized = target.trim();
  if (normalized.startsWith("unix://")) {
    return normalized;
  }
  if (normalized.startsWith("unix:")) {
    const rest = normalized.slice("unix:".length);
    if (rest.startsWith("/")) {
      return `unix://${rest}`;
    }
    return normalized;
  }
  if (normalized.startsWith("/")) {
    return `unix://${normalized}`;
  }
  return normalized;
}

function isRetryableEnclaveConnectError(message: string): boolean {
  const lowered = message.toLowerCase();
  return (
    lowered.includes("enoent") ||
    lowered.includes("eacces") ||
    lowered.includes("econnrefused") ||
    lowered.includes("unavailable") ||
    lowered.includes("no connection established")
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseUnixSocketPath(target: string): string | null {
  if (target.startsWith("unix://")) {
    const path = target.slice("unix://".length).trim();
    return path.length > 0 ? path : null;
  }
  if (target.startsWith("unix:")) {
    const path = target.slice("unix:".length).trim();
    return path.length > 0 ? path : null;
  }
  return null;
}
