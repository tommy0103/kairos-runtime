import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { loadEnclaveRuntimeConfig } from "@kairos-runtime/app-config";
import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { LLMMessage } from "./agent/core/openai";
import type { AgentLoopStreamEvent } from "./agent/core/loopRunner";
import { createOpenAIEnclaveRuntime } from "./agent/core/openai";
import { createFetchWebpageTool, createListFilesSafeTool, createReadFileSafeTool, createRunSafeBashTool, createWriteFileSafeTool } from "./agent/tools";

const CURRENT_DIR = dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = resolve(CURRENT_DIR, "../..");
const config = loadEnclaveRuntimeConfig();
const DEFAULT_PROTO_PATH = config.grpc.protoPath;
const DEFAULT_BIND_ADDR = config.grpc.bindAddr;
const MAX_GRPC_MESSAGE_BYTES = 16 * 1024 * 1024;

const API_KEY = config.llm.apiKey;
const baseURL = config.llm.baseURL;
const model = config.llm.model;

if (!API_KEY) {
  throw new Error("API_KEY (or QWEN_API_KEY) is required to start enclave server.");
}

process.env.API_KEY ??= API_KEY;
process.env.BASE_URL ??= baseURL;
process.env.MODEL ??= model;
process.env.RUNTIME_ROOT ??= config.runtime.runtimeRoot;
process.env.PROTO_ROOT ??= config.runtime.protoRoot;
process.env.MEMORY_FILES_ROOT ??= config.runtime.memoryFilesRoot;
process.env.EVOLUTIONS_ROOT ??= config.runtime.evolutionsRoot;
process.env.READ_FILE_SAFE_ROOT ??= WORKSPACE_ROOT;
process.env.ENABLED_TOOLS ??= config.tools.enabled;

// const { createOpenAIEnclaveRuntime } = await import("./agent/core/openai");
// const {
//   createFetchWebpageTool,
//   createListFilesSafeTool,
//   createReadFileSafeTool,
//   createRunSafeBashTool,
//   createWriteFileSafeTool,
// } = await import("./agent/tools");

const toolFactories: Record<string, () => any> = {
  fetch_webpage: createFetchWebpageTool,
  run_safe_bash: createRunSafeBashTool,
  read_file_safe: createReadFileSafeTool,
  write_file_safe: createWriteFileSafeTool,
  list_files_safe: createListFilesSafeTool,
};

function parseEnabledToolNames(): Set<string> {
  const raw = config.tools.enabled?.trim();
  if (!raw) {
    throw new Error("enclaveRuntime.tools.enabled is required and cannot be empty.");
  }
  if (raw.toLowerCase() === "all") {
    return new Set(Object.keys(toolFactories));
  }
  const names = raw
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return new Set(names);
}

function buildEnabledTools(enabledToolNames: Set<string>) {
  return Array.from(enabledToolNames)
    .map((name) => {
      const factory = toolFactories[name];
      if (!factory) {
        console.warn(`[enclave] unknown tool skipped: ${name}`);
        return null;
      }
      return factory();
    })
    .filter((tool): tool is NonNullable<typeof tool> => Boolean(tool));
}

interface GrpcStreamReplyRequest {
  chat_id?: string;
  messages?: Array<{ role?: string; content?: string }>;
  image_urls?: string[];
}

interface GrpcStreamReplyEvent {
  type: string;
  role?: string;
  delta?: string;
  tool_name?: string;
  tool_call_id?: string;
  result_json?: string;
  error?: string;
}

const MAX_RESULT_JSON_LENGTH = 8 * 1024;

function safeSerializeResult(result: unknown): string {
  if (result === undefined) {
    return "";
  }
  const seen = new WeakSet<object>();
  try {
    const raw = JSON.stringify(
      result,
      (_key, value) => {
        if (typeof value === "bigint") {
          return value.toString();
        }
        if (typeof value === "function") {
          return "[Function]";
        }
        if (typeof value === "symbol") {
          return value.toString();
        }
        if (value && typeof value === "object") {
          if (seen.has(value)) {
            return "[Circular]";
          }
          seen.add(value);
        }
        return value;
      }
    );
    if (!raw) {
      return "";
    }
    if (raw.length <= MAX_RESULT_JSON_LENGTH) {
      return raw;
    }
    return JSON.stringify({
      truncated: true,
      originalLength: raw.length,
      preview: raw.slice(0, MAX_RESULT_JSON_LENGTH),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return JSON.stringify({
      serializeError: message,
      resultType: typeof result,
    });
  }
}

const enabledToolNames = parseEnabledToolNames();
const enclaveRuntime = createOpenAIEnclaveRuntime({
  apiKey: API_KEY,
  model,
  baseURL,
  tools: buildEnabledTools(enabledToolNames),
});

const packageDefinition = protoLoader.loadSync(DEFAULT_PROTO_PATH, {
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
        AgentEnclaveService?: {
          service: grpc.ServiceDefinition;
        };
      };
    };
  };
};

const service = loaded.kairos?.enclave?.v1?.AgentEnclaveService?.service;
if (!service) {
  throw new Error("Failed to resolve AgentEnclaveService from proto.");
}

function sanitizeMessages(input: GrpcStreamReplyRequest["messages"]): LLMMessage[] {
  if (!Array.isArray(input)) {
    return [];
  }
  return input
    .map((item) => {
      const role: LLMMessage["role"] =
        item.role === "system" || item.role === "assistant" || item.role === "user"
          ? item.role
          : "user";
      return {
        role,
        content: typeof item.content === "string" ? item.content : "",
      };
    })
    .filter((item) => item.content.trim().length > 0);
}

function toGrpcEvent(event: AgentLoopStreamEvent): GrpcStreamReplyEvent {
  if (!event || typeof event !== "object" || !("type" in event)) {
    return { type: "failed", error: "Invalid enclave event payload." };
  }
  if (event.type === "message_update") {
    return {
      type: "message_update",
      role: "assistant",
      delta: event.delta,
    };
  }
  if (event.type === "tool_execution_start") {
    return {
      type: "tool_execution_start",
      tool_name: event.toolName,
      tool_call_id: event.toolCallId,
    };
  }
  if (event.type === "tool_execution_end") {
    return {
      type: "tool_execution_end",
      tool_name: event.toolName,
      tool_call_id: event.toolCallId,
      result_json: safeSerializeResult(event.result),
    };
  }
  if (event.type === "failed") {
    return { type: "failed", error: event.error };
  }
  return { type: "completed" };
}

function safeWrite(
  call: grpc.ServerWritableStream<GrpcStreamReplyRequest, GrpcStreamReplyEvent>,
  event: GrpcStreamReplyEvent
): boolean {
  try {
    if ((call as any).destroyed || (call as any).cancelled) {
      return false;
    }
    call.write(event);
    return true;
  } catch (error) {
    console.error("[enclave] stream write failed:", error);
    return false;
  }
}

const server = new grpc.Server({
  "grpc.max_send_message_length": MAX_GRPC_MESSAGE_BYTES,
  "grpc.max_receive_message_length": MAX_GRPC_MESSAGE_BYTES,
});
server.addService(service, {
  StreamReply: async (
    call: grpc.ServerWritableStream<GrpcStreamReplyRequest, GrpcStreamReplyEvent>
  ) => {
    call.on("error", (error) => {
      console.error("[enclave] grpc stream error:", error);
    });
    call.on("cancelled", () => {
      console.warn("[enclave] grpc stream cancelled by client");
    });
    try {
      const request = call.request;
      const messages = sanitizeMessages(request.messages);
      const imageUrls = (request.image_urls ?? []).filter((url: string) => url);
      for await (const event of enclaveRuntime.streamEvents(messages, { imageUrls })) {
        const grpcEvent = toGrpcEvent(event);
        if (!safeWrite(call, grpcEvent)) {
          break;
        }
      }
      call.end();
    } catch (error) {
      safeWrite(call, {
        type: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
      call.end();
    }
  },
});

function parseUnixSocketPath(addr: string): string | null {
  if (addr.startsWith("unix://")) {
    const path = addr.slice("unix://".length).trim();
    return path.length > 0 ? path : null;
  }
  if (addr.startsWith("unix:")) {
    const path = addr.slice("unix:".length).trim();
    return path.length > 0 ? path : null;
  }
  return null;
}

function prepareUnixSocket(addr: string): void {
  const socketPath = parseUnixSocketPath(addr);
  if (!socketPath) {
    return;
  }
  const parent = dirname(socketPath);
  mkdirSync(parent, { recursive: true });
  if (existsSync(socketPath)) {
    rmSync(socketPath);
  }
}

function ensureUnixSocketPermissions(addr: string): void {
  const socketPath = parseUnixSocketPath(addr);
  if (!socketPath || !existsSync(socketPath)) {
    return;
  }
  try {
    // Allow host non-root client process to connect to sandbox-created socket.
    chmodSync(socketPath, 0o666);
  } catch (error) {
    console.warn("[enclave] failed to chmod unix socket:", error);
  }
}

prepareUnixSocket(DEFAULT_BIND_ADDR);

server.bindAsync(
  DEFAULT_BIND_ADDR,
  grpc.ServerCredentials.createInsecure(),
  (error) => {
    if (error) {
      console.error("[enclave] failed to bind grpc server:", error);
      process.exit(1);
    }
    ensureUnixSocketPermissions(DEFAULT_BIND_ADDR);
    console.log(`[enclave] grpc server listening on ${DEFAULT_BIND_ADDR}`);
  }
);

process.on("SIGINT", () => {
  server.tryShutdown(() => process.exit(0));
});

process.on("SIGTERM", () => {
  server.tryShutdown(() => process.exit(0));
});
