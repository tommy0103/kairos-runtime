// --- Logos Kernel VFS Client ---
// Adapter: exposes the same MemoryVfsClient interface as before,
// but internally connects to logos-fs kernel (logos.kernel.v1 proto).
//
// Consumers (archiver, searcher, store) see no change.

import { Metadata } from "nice-grpc-common";
import * as grpc from "@grpc/grpc-js";
import { createChannel, createClient } from "nice-grpc";
import { randomUUID } from "node:crypto";
import {
  LogosDefinition,
  type LogosClient as LogosGrpcClient,
} from "./generated/logos";
import { SearchMode } from "./generated/vfs";

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
  ChatMessage,
  MessageMetadata,
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
const SEMANTIC_RESULT_MAX_MESSAGES = 6;
const MIN_SEMANTIC_RESULT_SCORE = 0.45;
const SPEAKER_VIEW_MULTIPLIER = 6;

interface ExactSearchTarget {
  chatId: string;
  messageId: number;
}

interface MemorySearchRow {
  msg_id?: number | string | null;
  ts?: string | number | null;
  chat_id?: number | string | null;
  speaker?: string | null;
  reply_to?: number | string | null;
  text?: string | null;
  mentions?: unknown;
}

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
      await this.logosClient.registerToken(
        {
          token: this.sessionToken,
          taskId: this.sessionTaskId,
          role: this.sessionRole,
        },
        this.buildCallOptions(),
      );

      let headerSessionKey = "";
      const handshake = await this.logosClient.handshake(
        { token: this.sessionToken },
        {
          ...this.buildCallOptions(),
          onHeader: (header: { get: (name: string) => unknown }) => {
            const rawSession = header.get("x-logos-session");
            headerSessionKey = rawSession == null ? "" : String(rawSession);
          },
        },
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
    if (request.mode === SearchMode.SEARCH_MODE_EXACT) {
      return this.searchExact(request);
    }
    return this.searchSemanticLike(request);
  }

  async searchSemanticBySpeaker(input: {
    chatId: string;
    speaker: string;
    query: string;
    limit?: number;
  }): Promise<SearchResponse> {
    const chatId = input.chatId.trim();
    const speaker = input.speaker.trim();
    const query = input.query.trim();
    if (!chatId || !speaker || !query) {
      return { results: [] };
    }

    const outputLimit = Math.max(1, input.limit ?? 5);
    const fetchLimit = Math.max(outputLimit * SPEAKER_VIEW_MULTIPLIER, 20);
    const params = JSON.stringify({
      speaker,
      limit: fetchLimit,
    });
    const resp = await this.logosClient.read(
      { uri: `logos://memory/groups/${chatId}/views/by_speaker/${params}` },
      await this.buildOptions(),
    );

    const rows = parseMemorySearchRows(resp.content);
    if (rows.length === 0) {
      return { results: [] };
    }

    const ranked = rows
      .map((row) => {
        const message = toChatMessage(row, chatId);
        if (!message || message.userId !== speaker) {
          return null;
        }
        const score = scoreSemanticAcrossQueries(query, message.context);
        return { message, score };
      })
      .filter((item): item is { message: ChatMessage; score: number } => Boolean(item))
      .filter((item) => item.score >= MIN_SEMANTIC_RESULT_SCORE)
      .sort((a, b) => b.score - a.score);

    if (ranked.length === 0) {
      return { results: [] };
    }

    const messages = ranked
      .slice(0, Math.min(outputLimit, SEMANTIC_RESULT_MAX_MESSAGES))
      .map((item) => item.message);
    const head = messages[0];
    const result: SearchResult = {
      sessionId: buildSyntheticSessionId(head.chatId, head.messageId),
      centerVector: [],
      abstractSummary: buildAbstractSummary(head.context),
      messages,
      // boost user-scoped recall so it wins over generic group recall when both are valid.
      score: Math.min(1, ranked[0].score + 0.08),
    };
    return { results: [result] };
  }

  private async searchSemanticLike(request: SearchRequest): Promise<SearchResponse> {
    const scope = request.scope.trim();
    const query = request.query.trim();
    if (!scope || !query) {
      return { results: [] };
    }

    const limit = request.limit || 10;
    const rankedByMessageId = new Map<string, { message: ChatMessage; score: number }>();
    const queries = buildSemanticSearchQueries(query);
    for (let i = 0; i < queries.length; i += 1) {
      const q = queries[i];
      const rows = await this.callMemorySearch(scope, q, limit);
      for (const row of rows) {
        const message = toChatMessage(row, scope);
        if (!message) {
          continue;
        }
        const score = scoreSemanticCandidate(query, q, message.context, i);
        if (score < MIN_SEMANTIC_RESULT_SCORE) {
          continue;
        }
        const existing = rankedByMessageId.get(message.messageId);
        if (!existing || score > existing.score) {
          rankedByMessageId.set(message.messageId, { message, score });
        }
      }
      if (rankedByMessageId.size >= limit) {
        break;
      }
    }

    const ranked = Array.from(rankedByMessageId.values()).sort((a, b) => b.score - a.score);
    if (ranked.length === 0) {
      return { results: [] };
    }
    const messages = ranked
      .slice(0, Math.min(limit, SEMANTIC_RESULT_MAX_MESSAGES))
      .map((item) => item.message);
    const head = messages[0];
    const result: SearchResult = {
      sessionId: buildSyntheticSessionId(head.chatId, head.messageId),
      centerVector: [],
      abstractSummary: buildAbstractSummary(head.context),
      messages,
      score: ranked[0].score,
    };
    return { results: [result] };
  }

  private async callMemorySearch(chatId: string, query: string, limit: number): Promise<MemorySearchRow[]> {
    const params = JSON.stringify({
      chat_id: chatId,
      query,
      limit,
    });
    const resp = await this.logosClient.call(
      { tool: "memory.search", paramsJson: params },
      await this.buildOptions(),
    );
    return parseMemorySearchRows(resp.resultJson);
  }

  private async searchExact(request: SearchRequest): Promise<SearchResponse> {
    const target = parseExactSearchTarget(request);
    if (!target) {
      return { results: [] };
    }

    const resp = await this.logosClient.read(
      { uri: `logos://memory/groups/${target.chatId}/messages/${target.messageId}` },
      await this.buildOptions(),
    );

    const rows = parseMemorySearchRows(resp.content);
    if (rows.length === 0) {
      return { results: [] };
    }

    const message = toChatMessage(rows[0], target.chatId);
    if (!message) {
      return { results: [] };
    }

    const result: SearchResult = {
      sessionId: buildSyntheticSessionId(message.chatId, message.messageId),
      centerVector: [],
      abstractSummary: buildAbstractSummary(message.context),
      messages: [message],
      score: 1,
    };
    return { results: [result] };
  }

  async write(request: WriteRequest): Promise<WriteResponse> {
    // --- [PRESERVED] Old direct RPC ---
    // return this.grpcClient.write(request, this.buildOptions());

    const uri = translatePath(request.path);
    await this.logosClient.write(
      { uri, content: request.content },
      await this.buildOptions(),
    );
    return { success: true, errorMsg: "" };
  }

  async read(request: ReadRequest): Promise<ReadResponse> {
    // --- [PRESERVED] Old direct RPC ---
    // return this.grpcClient.read(request, this.buildOptions());

    const uri = translatePath(request.path);
    const resp = await this.logosClient.read({ uri }, await this.buildOptions());
    return { success: true, content: resp.content, errorMsg: "" };
  }

  async patch(request: PatchRequest): Promise<PatchResponse> {
    // --- [PRESERVED] Old direct RPC ---
    // return this.grpcClient.patch(request, this.buildOptions());

    const uri = translatePath(request.path);
    await this.logosClient.patch(
      { uri, partial: request.partialContent },
      await this.buildOptions(),
    );
    return { success: true, errorMsg: "" };
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
        await this.buildOptions(),
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
        await this.buildOptions(),
      );
    }

    return { success: true, errorMsg: "" };
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
  // Bare path -> assume users namespace
  return `logos://users/${path}`;
}

function parseExactSearchTarget(request: SearchRequest): ExactSearchTarget | null {
  const chatId = request.scope.trim();
  if (!chatId) {
    return null;
  }

  const query = request.query.trim();
  if (!query) {
    return null;
  }

  let messageCandidate = query;
  if (query.startsWith(`${chatId}:`)) {
    messageCandidate = query.slice(chatId.length + 1);
  } else if (query.includes(":")) {
    const tail = query.split(":").pop();
    messageCandidate = tail ?? "";
  }

  const messageId = toFiniteInt(messageCandidate);
  if (messageId === null) {
    return null;
  }

  return { chatId, messageId };
}

function parseMemorySearchRows(raw: string): MemorySearchRow[] {
  if (!raw || raw.trim() === "" || raw.trim() === "null") {
    return [];
  }

  try {
    const value = JSON.parse(raw) as unknown;
    if (Array.isArray(value)) {
      return value.filter((item): item is MemorySearchRow => Boolean(item) && typeof item === "object");
    }
    if (value && typeof value === "object" && Array.isArray((value as { rows?: unknown }).rows)) {
      return (value as { rows: unknown[] }).rows.filter(
        (item): item is MemorySearchRow => Boolean(item) && typeof item === "object",
      );
    }
    if (value && typeof value === "object") {
      return [value as MemorySearchRow];
    }
  } catch {
    return [];
  }

  return [];
}

function toChatMessage(row: MemorySearchRow, fallbackChatId: string): ChatMessage | null {
  const messageId = toFiniteInt(row.msg_id);
  if (messageId === null) {
    return null;
  }

  const chatIdRaw = row.chat_id ?? fallbackChatId;
  const chatId = String(chatIdRaw ?? "").trim();
  if (!chatId) {
    return null;
  }

  const metadata: MessageMetadata = {
    isBot: false,
    username: "",
    replyToMessageId: toReplyToMessageId(row.reply_to),
    replyToUserId: "",
    isReplyToMe: false,
    isMentionMe: false,
    mentions: parseMentions(row.mentions),
  };

  return {
    userId: typeof row.speaker === "string" && row.speaker.trim() !== "" ? row.speaker : "unknown",
    messageId: String(messageId),
    chatId,
    conversationType: "supergroup",
    context: typeof row.text === "string" ? row.text : "",
    timestamp: normalizeTimestamp(row.ts),
    metadata,
    vector: [],
  };
}

function toReplyToMessageId(value: unknown): string {
  const id = toFiniteInt(value);
  return id === null ? "" : String(id);
}

function parseMentions(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item)).filter((item) => item.length > 0);
  }
  if (typeof value !== "string") {
    return [];
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return [];
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.map((item) => String(item)).filter((item) => item.length > 0);
  } catch {
    return [];
  }
}

function normalizeTimestamp(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1e12 ? Math.floor(value) : Math.floor(value * 1000);
  }
  if (typeof value !== "string") {
    return Date.now();
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return Date.now();
  }

  const asNumber = Number(trimmed);
  if (Number.isFinite(asNumber)) {
    return asNumber > 1e12 ? Math.floor(asNumber) : Math.floor(asNumber * 1000);
  }

  const parsed = Date.parse(trimmed);
  if (Number.isFinite(parsed)) {
    return parsed;
  }

  return Date.now();
}

function toFiniteInt(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return Math.trunc(parsed);
    }
  }
  return null;
}

function buildSyntheticSessionId(chatId: string, messageId: string): string {
  return `recalled:${chatId}:${messageId}`;
}

function buildAbstractSummary(text: string): string {
  const normalized = text.trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "(recalled)";
  }
  if (normalized.length <= 80) {
    return normalized;
  }
  return `${normalized.slice(0, 77)}...`;
}

function buildSemanticSearchQueries(query: string): string[] {
  const normalized = query.trim();
  if (!normalized) {
    return [];
  }

  const candidates: string[] = [normalized];

  const latinTokens = normalized
    .split(/[^\p{L}\p{N}_]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
  for (const token of latinTokens) {
    candidates.push(token);
  }

  const cjk = normalized.replace(/[^\u3400-\u9FFF]/g, "");
  if (cjk.length >= 2) {
    const maxChunks = Math.min(8, cjk.length - 1);
    for (let i = 0; i < maxChunks; i += 1) {
      candidates.push(cjk.slice(i, i + 2));
    }
  }

  const uniq: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    uniq.push(candidate);
    if (uniq.length >= 12) {
      break;
    }
  }
  return uniq;
}

function scoreSemanticCandidate(
  originalQuery: string,
  usedQuery: string,
  context: string,
  usedQueryIndex: number,
): number {
  const queryNorm = normalizeForScore(originalQuery);
  const usedNorm = normalizeForScore(usedQuery);
  const textNorm = normalizeForScore(context);
  if (!textNorm) {
    return 0;
  }
  if (queryNorm && textNorm.includes(queryNorm)) {
    return 1;
  }

  const queryTokens = tokenizeForScore(queryNorm);
  const textTokens = tokenizeForScore(textNorm);
  const overlap = overlapRatio(queryTokens, textTokens);

  let score = Math.sqrt(overlap);
  if (usedQueryIndex === 0) {
    score += 0.12;
  }
  if (usedNorm && textNorm.includes(usedNorm)) {
    score += usedNorm.length >= 4 ? 0.22 : 0.14;
  }
  if (queryTokens.size <= 2 && overlap > 0) {
    score += 0.08;
  }
  return Math.max(0, Math.min(1, score));
}

function scoreSemanticAcrossQueries(query: string, context: string): number {
  const queries = buildSemanticSearchQueries(query);
  if (queries.length === 0) {
    return 0;
  }
  let best = 0;
  for (let i = 0; i < queries.length; i += 1) {
    const score = scoreSemanticCandidate(query, queries[i], context, i);
    if (score > best) {
      best = score;
    }
  }
  return best;
}

function normalizeForScore(input: string): string {
  return input.trim().toLowerCase().replace(/\s+/g, " ");
}

function tokenizeForScore(input: string): Set<string> {
  const tokens = new Set<string>();
  if (!input) {
    return tokens;
  }

  for (const token of input.split(/[^\p{L}\p{N}_]+/u)) {
    if (token.length >= 2) {
      tokens.add(token);
    }
  }

  const cjk = input.replace(/[^\u3400-\u9FFF]/g, "");
  if (cjk.length >= 2) {
    for (let i = 0; i < cjk.length - 1; i += 1) {
      tokens.add(cjk.slice(i, i + 2));
    }
  }

  return tokens;
}

function overlapRatio(queryTokens: Set<string>, textTokens: Set<string>): number {
  if (queryTokens.size === 0 || textTokens.size === 0) {
    return 0;
  }
  let matched = 0;
  for (const token of queryTokens) {
    if (textTokens.has(token)) {
      matched += 1;
    }
  }
  return matched / queryTokens.size;
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
