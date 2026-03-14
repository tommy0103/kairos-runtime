import * as grpc from "@grpc/grpc-js";
import { createChannel, createClient } from "nice-grpc";
import {
  MemoryVFSDefinition,
  type ArchiveRequest,
  type ArchiveResponse,
  type MemoryVFSClient as MemoryVFSGrpcClient,
  type PatchRequest,
  type PatchResponse,
  type ReadRequest,
  type ReadResponse,
  type SearchRequest,
  type SearchResponse,
  type WriteRequest,
  type WriteResponse,
} from "./generated/vfs";

const MAX_GRPC_MESSAGE_BYTES = 16 * 1024 * 1024;

export interface CreateMemoryVfsClientOptions {
  target?: string;
  timeoutMs?: number;
}

export class MemoryVfsClient {
  private readonly grpcClient: MemoryVFSGrpcClient;
  private readonly timeoutMs?: number;

  constructor(options: CreateMemoryVfsClientOptions = {}) {
    const rawTarget = options.target ?? getDefaultMemoryVfsTarget();
    const target = normalizeGrpcTarget(rawTarget);
    const channel = createChannel(target, grpc.credentials.createInsecure(), {
      "grpc.max_send_message_length": MAX_GRPC_MESSAGE_BYTES,
      "grpc.max_receive_message_length": MAX_GRPC_MESSAGE_BYTES,
    });
    this.grpcClient = createClient(MemoryVFSDefinition, channel);
    this.timeoutMs = options.timeoutMs;
  }

  async search(request: SearchRequest): Promise<SearchResponse> {
    return this.grpcClient.search(request, this.buildCallOptions());
  }

  async write(request: WriteRequest): Promise<WriteResponse> {
    return this.grpcClient.write(request, this.buildCallOptions());
  }

  async read(request: ReadRequest): Promise<ReadResponse> {
    return this.grpcClient.read(request, this.buildCallOptions());
  }

  async patch(request: PatchRequest): Promise<PatchResponse> {
    return this.grpcClient.patch(request, this.buildCallOptions());
  }

  async archive(request: ArchiveRequest): Promise<ArchiveResponse> {
    return this.grpcClient.archive(request, this.buildCallOptions());
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

function getDefaultMemoryVfsTarget(): string {
  return (
    process.env.MEMORY_VFS_TARGET ??
    process.env.KAIROS_VFS_SOCKET ??
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
