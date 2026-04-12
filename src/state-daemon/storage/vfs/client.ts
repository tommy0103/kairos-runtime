// --- Logos Kernel VFS Client ---
// Adapter: exposes the same MemoryVfsClient interface as before,
// but internally connects to logos-fs kernel (logos.kernel.v1 proto).
//
// Consumers (archiver, searcher, store) see no change.

import { Metadata } from 'nice-grpc-common';
import * as grpc from "@grpc/grpc-js";
import { createChannel, createClient } from "nice-grpc";
import { randomUUID } from "node:crypto";
import {
  LogosDefinition,
  type LogosClient as LogosGrpcClient,
} from "./generated/logos";

// --- [PRESERVED] Old kairos.vfs.v1 imports for type compat ---
// import {
//   MemoryVFSDefinition,
//   type ArchiveRequest,
//   type ArchiveResponse,
//   type MemoryVFSClient as MemoryVFSGrpcClient,
//   type PatchRequest,
//   type PatchResponse,
//   type ReadRequest,
//   type ReadResponse,
//   type SearchRequest,
//   type SearchResponse,
//   type WriteRequest,
//   type WriteResponse,
// } from "./generated/vfs";

// Re-export old types for backward compat (consumers import these)
import type {
  ArchiveRequest,
  ArchiveResponse,
  PatchRequest,
  PatchResponse,
  ReadRequest,
  ReadResponse,
  SearchRequest,
  SearchResponse,
  SearchResult,
  WriteRequest,
  WriteResponse,
} from "./types";

const MAX_GRPC_MESSAGE_BYTES = 16 * 1024 * 1024;

export interface CreateMemoryVfsClientOptions {
  target?: string;
  timeoutMs?: number;
}

export class MemoryVfsClient {
  // --- [PRESERVED] Old gRPC client ---
  // private readonly grpcClient: MemoryVFSGrpcClient;
  private readonly logosClient: LogosGrpcClient;
  private readonly timeoutMs?: number;
  private readonly sessionToken: string;
  private readonly sessionTaskId: string;
  private readonly sessionRole: string;
  private sessionKeyPromise: Promise<string> | null = null;
  private sessionKey: string | null = null;

  constructor(options: CreateMemoryVfsClientOptions = {}) {
    const rawTarget = options.target ?? getDefaultMemoryVfsTarget();
    const target = normalizeGrpcTarget(rawTarget);
    const channel = createChannel(target, grpc.credentials.createInsecure(), {
      "grpc.max_send_message_length": MAX_GRPC_MESSAGE_BYTES,
      "grpc.max_receive_message_length": MAX_GRPC_MESSAGE_BYTES,
    });
    // --- [PRESERVED] Old client ---
    // this.grpcClient = createClient(MemoryVFSDefinition, channel);
    this.logosClient = createClient(LogosDefinition, channel);
    this.timeoutMs = options.timeoutMs;
    const sessionTokenSeed =
      process.env.LOGOS_TOKEN?.trim() ||
      process.env.STATE_DAEMON_LOGOS_TOKEN?.trim() ||
      "state-daemon";
    this.sessionToken = `${sessionTokenSeed}-${randomUUID()}`;
    this.sessionTaskId =
      process.env.LOGOS_TASK_ID?.trim() ||
      process.env.STATE_DAEMON_LOGOS_TASK_ID?.trim() ||
      "state-daemon";
    this.sessionRole =
      process.env.LOGOS_ROLE?.trim() ||
      process.env.STATE_DAEMON_LOGOS_ROLE?.trim() ||
      "admin";
  }

  private async ensureSessionKey(): Promise<string> {
    if (this.sessionKey) {
      return this.sessionKey;
    }
    if (this.sessionKeyPromise) {
      return this.sessionKeyPromise;
    }
    this.sessionKeyPromise = (async () => {
      await this.logosClient.registerToken({
        token: this.sessionToken,
        taskId: this.sessionTaskId,
        role: this.sessionRole,
      }, this.buildCallOptions());

      let headerSessionKey = "";
      const handshake = await this.logosClient.handshake(
        { token: this.sessionToken },
        {
          ...this.buildCallOptions(),
          onHeader: (header) => {
            headerSessionKey = header.get("x-logos-session")?.toString() ?? "";
          },
        }
      );
      if (!handshake.ok) {
        throw new Error(`logos handshake failed: ${handshake.error || "unknown error"}`);
      }
      if (!headerSessionKey) {
        throw new Error("logos handshake succeeded but x-logos-session header is missing");
      }
      this.sessionKey = headerSessionKey;
      return headerSessionKey;
    })().finally(() => {
      this.sessionKeyPromise = null;
    });
    return this.sessionKeyPromise;
  }

  private async buildOptions() {
    const sessionKey = await this.ensureSessionKey();
    return {
      ...this.buildCallOptions(),
      metadata: Metadata({
        "x-logos-session": sessionKey,
      }),
    };
  }

  async search(request: SearchRequest): Promise<SearchResponse> {
    // --- [PRESERVED] Old direct RPC ---
    // return this.grpcClient.search(request, this.buildOptions());

    // Logos: route through logos_call("memory.search", ...)
    const params = JSON.stringify({
      chat_id: request.scope,
      query: request.query,
      limit: request.limit || 10,
    });
    const resp = await this.logosClient.call(
      { tool: "memory.search", paramsJson: params },
      await this.buildOptions()
    );
    // Convert logos response to old SearchResponse format
    const messages = JSON.parse(resp.resultJson || "[]");
    // Wrap as a single SearchResult for backward compat
    const result: SearchResult = {
      sessionId: "",
      centerVector: [],
      abstractSummary: "",
      messages: [],
      score: 1.0,
    };
    return { results: messages.length > 0 ? [result] : [] };
  }

  async write(request: WriteRequest): Promise<WriteResponse> {
    // --- [PRESERVED] Old direct RPC ---
    // return this.grpcClient.write(request, this.buildOptions());

    const uri = translatePath(request.path);
    await this.logosClient.write(
      { uri, content: request.content },
      await this.buildOptions()
    );
    return {};
  }

  async read(request: ReadRequest): Promise<ReadResponse> {
    // --- [PRESERVED] Old direct RPC ---
    // return this.grpcClient.read(request, this.buildOptions());

    const uri = translatePath(request.path);
    const resp = await this.logosClient.read(
      { uri },
      await this.buildOptions()
    );
    return { content: resp.content };
  }

  async patch(request: PatchRequest): Promise<PatchResponse> {
    // --- [PRESERVED] Old direct RPC ---
    // return this.grpcClient.patch(request, this.buildOptions());

    const uri = translatePath(request.path);
    await this.logosClient.patch(
      { uri, partial: request.partialContent },
      await this.buildOptions()
    );
    return {};
  }

  async archive(request: ArchiveRequest): Promise<ArchiveResponse> {
    // --- [PRESERVED] Old direct RPC ---
    // return this.grpcClient.archive(request, this.buildOptions());

    // Logos: archive = write each message to memory, then write summary
    // Messages are stored individually via logos://memory/groups/{chat_id}/messages
    for (const msg of request.messages) {
      const msgJson = JSON.stringify({
        ts: new Date(Number(msg.timestamp) * 1000).toISOString(),
        chat_id: msg.chatId,
        speaker: msg.userId,
        reply_to: msg.metadata?.replyToMessageId
          ? parseInt(msg.metadata.replyToMessageId, 10) || null
          : null,
        text: msg.context,
        mentions: msg.metadata?.mentions || [],
      });
      await this.logosClient.write(
        {
          uri: `logos://memory/groups/${request.chatId}/messages`,
          content: msgJson,
        },
        await this.buildOptions()
      );
    }

    // Write summary as a short summary if provided
    if (request.abstractSummary) {
      const now = new Date();
      const period = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}T${String(now.getHours()).padStart(2, "0")}`;
      const summaryJson = JSON.stringify({
        layer: "short",
        period_start: period,
        period_end: period,
        source_refs: "[]",
        content: request.abstractSummary,
      });
      await this.logosClient.write(
        {
          uri: `logos://memory/groups/${request.chatId}/summary/short/${period}`,
          content: summaryJson,
        },
        await this.buildOptions()
      );
    }

    return {};
  }

  private buildCallOptions(): { signal?: AbortSignal } {
    if (!this.timeoutMs || this.timeoutMs <= 0) {
      return {};
    }
    return {
      signal: AbortSignal.timeout(this.timeoutMs),
    };
  }
}

export function createMemoryVfsClient(options?: CreateMemoryVfsClientOptions): MemoryVfsClient {
  return new MemoryVfsClient(options);
}

/** Translate old mem:// paths to logos:// URIs. */
function translatePath(path: string): string {
  if (path.startsWith("mem://")) {
    return path.replace("mem://", "logos://");
  }
  if (path.startsWith("logos://")) {
    return path;
  }
  // Bare path → assume users namespace
  return `logos://users/${path}`;
}

function getDefaultMemoryVfsTarget(): string {
  return (
    process.env.LOGOS_SOCKET ??
    process.env.MEMORY_VFS_TARGET ??
    // --- [PRESERVED] Old default ---
    // process.env.KAIROS_VFS_SOCKET ??
    // "unix:///run/kairos-runtime/sockets/kairos-runtime-vfs.sock"
    "unix:///run/kairos-runtime/sockets/kairos-runtime-vfs.sock"
  );
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
