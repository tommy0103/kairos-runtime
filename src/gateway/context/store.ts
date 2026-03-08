import { gamma, max } from "mathjs";
import { createDenseEmbedder, type DenseEmbedder } from "../../embedding";
import type { CloudModel, LocalModel } from "../../llm";
import type { TelegramMessage } from "../../telegram/types";
import {
  decideSessionByLlm,
  decideSessionByReranker,
  type SessionDeciderResult,
  type SessionSummary,
} from "./sessionDecider";
import type {
  ChatControlBlock,
  ContextStore,
  MessageNode,
  SessionControlBlock,
  SessionStatus,
} from "./types";

export interface CreateInMemoryContextStoreOptions {
  embedder?: DenseEmbedder;
  similarityThreshold?: number;
  shortMessageThreshold?: number;
  alphaTime?: number;
  lambda?: number;
  alphaCenter?: number;
  maxContextMessages?: number;
  maxSessionsPerChat?: number;
  /** When set with localModel, used as fallback when pickBestSession returns null. */
  sessionDecider?: (input: {
    message: TelegramMessage;
    sessions: SessionSummary[];
    localModel?: LocalModel;
    cloudModel?: CloudModel;
  }) => Promise<SessionDeciderResult>;
  localModel?: LocalModel;
  /** Optional cloud model for summarizing session topic when 5 new messages accumulate. */
  cloudModel?: CloudModel;
}

const GHOST_CONTEXT_WINDOW_MS = 30 * 1000;
const MEDIUM_MESSAGE_LENGTH = 8;
const SHORT_MESSAGE_LENGTH = 4;
const RECENT_SESSIONS_COUNT = 5;
const RECENT_CHAT_MESSAGES_COUNT = 10;
const SESSION_LRU_EXPIRE_MS = 60 * 60 * 1000;
const TOPIC_SUMMARY_CONCAT_MAX = 3;
const TOPIC_SUMMARY_CLOUD_BATCH = 5;
const IMPOSSIBLE_SIMILARITY_SCORE_THRESHOLD = 0.35;

export function createInMemoryContextStore(
  options: CreateInMemoryContextStoreOptions = {}
): ContextStore {
  const embedder = options.embedder ?? createDenseEmbedder();
  const similarityThreshold = options.similarityThreshold ?? 0.60;
  const shortMessageThreshold = options.shortMessageThreshold ?? 0.45;
  // const alphaTime = options.alphaTime ?? 0.25;
  // const lambda = options.lambda ?? 1 / (2 * 60 * 1000);
  const gammaTime = 0.85;
  const lambda = options.lambda ?? 0.0022;
  const alphaCenter = options.alphaCenter ?? 0.4;
  const maxContextMessages = options.maxContextMessages ?? 250;
  const maxSessionsPerChat = options.maxSessionsPerChat ?? 32;
  const chatControlBlocks = new Map<number, ChatControlBlock>();
  // const sessionDecider = options.sessionDecider ?? decideSessionByLlm;
  const sessionDecider = options.sessionDecider ?? decideSessionByReranker;
  const localModel = options.localModel;
  const cloudModel = options.cloudModel;

  return {
    ingestMessage: async ({ message }) => {
      // console.log("ingestMessage", message);
      const now = message.timestamp;
      const chatId = message.chatId;
      const messageId = message.messageId;
      const mode = process.env.CONTEXT_MODE;

      /**
       * 暴力模式优化：
       * 如果开启了 bruteforce 模式，我们直接将消息存入节点，
       * 彻底跳过 Embedding 计算和 Reranker 会话切分逻辑。
       * 这样可以极大地降低 CPU 负载并防止 OOM。
       */
      if (mode === "bruteforce") {
        const ccb = getOrCreateChatControlBlock(chatControlBlocks, chatId);
        const node: MessageNode = {
          message,
          messageId,
          timestamp: message.timestamp,
          replyToId: null,
          childrenIds: [],
          sessionId: "bruteforce_global",
          vector: [], // 暴力模式不需要向量
        };
        ccb.messageNodes.set(messageId, node);
        updateLastMessageNodeId(ccb, node);
        return;
      }

      const isShortMessage = message.context.length <= SHORT_MESSAGE_LENGTH;
      const ccb = getOrCreateChatControlBlock(chatControlBlocks, chatId);
      downgradeExpiredSessions(ccb, now, SESSION_LRU_EXPIRE_MS);
      const existing = ccb.messageNodes.get(messageId);
      if (existing) {
        existing.message = message;
        existing.timestamp = message.timestamp;
        updateLastMessageNodeId(ccb, existing);
        return;
      }

      const textForEmbedding = buildEmbeddingTextWithGhostContext(ccb, message);
      // const textForEmbedding = message.context;
      const vector = await embedMessage(embedder, textForEmbedding);
      // console.log("vector", vector);
      const replyToId = message.metadata.replyToMessageId;
      const replyTarget = replyToId ? ccb.messageNodes.get(replyToId) ?? null : null;
      const replySession = replyTarget
        ? ccb.sessionControlBlocks.get(replyTarget.sessionId) ?? null
        : null;

      const node: MessageNode = {
        message,
        messageId,
        timestamp: message.timestamp,
        replyToId: replyTarget?.messageId ?? null,
        childrenIds: [],
        sessionId: "",
        vector,
      };

      let targetSession: SessionControlBlock | null = null;
      let shouldUpdateCenter = true;

      if (replySession) {
        targetSession = replySession;
        // let currentAlphaTime = alphaTime;
        // if (message.context.length < 15) {
        //   currentAlphaTime += 0.15;
        // }
        const score = scoreMessageToSession(vector, targetSession, now, gammaTime, lambda);
        shouldUpdateCenter = score >= similarityThreshold && !isShortMessage;
        setSessionActive(ccb, targetSession.sessionId);
      } else {
        const best = pickBestSession(
          ccb,
          vector,
          now,
          gammaTime,
          lambda,
          message.context.length <= MEDIUM_MESSAGE_LENGTH,
          isShortMessage,
          similarityThreshold,
          shortMessageThreshold
        );
        if (best && best.session) {
          targetSession = best.session;
        }
        // const start = performance.now();
        if (best.score >= IMPOSSIBLE_SIMILARITY_SCORE_THRESHOLD) {
          targetSession = await tryAssignSessionByDecider({
            targetSession,
            ccb,
            message,
            localModel,
            cloudModel,
            sessionDecider,
          });
        }
        // const elapsed = performance.now() - start;
        // console.log("tryAssignSessionByDecider", elapsed, "ms", ccb.sessionControlBlocks.size, "sessions");
      }

      if (!targetSession) {
        // evictOldestSessionIfNeeded(ccb, maxSessionsPerChat); // TODO: 需要修改
        targetSession = createSession(ccb, node, now, isShortMessage);
      }

      node.sessionId = targetSession.sessionId;
      ccb.messageNodes.set(node.messageId, node);
      updateLastMessageNodeId(ccb, node);
      targetSession.messageIds.add(node.messageId);
      targetSession.lastActiveTime = now;
      if (!isShortMessage) {
        targetSession.recentVector = vector.slice();
      }

      const isReplyWithinSameSession = Boolean(
        replyTarget && replyTarget.sessionId === targetSession.sessionId
      ); // TODO: 需要修改
      if (isReplyWithinSameSession && node.replyToId) {
        const parent = ccb.messageNodes.get(node.replyToId);
        if (parent) {
          parent.childrenIds.push(node.messageId);
        }
        targetSession.rootMessageIds.delete(node.messageId);
      } else {
        node.replyToId = null;
        targetSession.rootMessageIds.add(node.messageId);
      }

      if (shouldUpdateCenter) {
        targetSession.centerVector = updateCenterVector(
          targetSession.centerVector,
          vector,
          alphaCenter
        );
      }
      // await updateTopicSummary(ccb, targetSession, cloudModel);
      void updateTopicSummary(ccb, targetSession, cloudModel).catch(error => console.error("updateTopicSummary error", error));
    },
    getContextByAnchor: ({ chatId, messageId }) => {
      const ccb = chatControlBlocks.get(chatId);
      if (!ccb) {
        return [[], []];
      }
      const node = ccb.messageNodes.get(messageId);
      if (!node) {
        return [[], []];
      }

      const session = ccb.sessionControlBlocks.get(node.sessionId);
      if (!session) {
        const recentMessages = Array.from(ccb.messageNodes.values())
          .sort((a, b) => a.timestamp - b.timestamp)
          .slice(-RECENT_CHAT_MESSAGES_COUNT)
          .map((item) => item.message);
        return [recentMessages, []];
      }

      const allSessionMessages = [...session.messageIds]
        .map((id) => ccb.messageNodes.get(id))
        .filter((item): item is MessageNode => Boolean(item))
        .sort((a, b) => a.timestamp - b.timestamp)
        .map((item) => item.message);
      const sessionMessages =
        allSessionMessages.length <= maxContextMessages
          ? allSessionMessages
          : allSessionMessages.slice(allSessionMessages.length - maxContextMessages);
      const sessionMessageIds = new Set(sessionMessages.map((item) => item.messageId));
      const recentMessages = Array.from(ccb.messageNodes.values())
        .sort((a, b) => b.timestamp - a.timestamp)
        .filter((item) => !sessionMessageIds.has(item.messageId))
        .slice(0, RECENT_CHAT_MESSAGES_COUNT)
        .sort((a, b) => a.timestamp - b.timestamp)
        .map((item) => item.message);
      return [recentMessages, sessionMessages];
    },
    getLinearContext: ({ chatId, limit }) => {
      const ccb = chatControlBlocks.get(chatId);
      if (!ccb) return [];

      // 获取所有消息节点，按时间倒序排列以获取最新的 limit 条
      const allMessages = Array.from(ccb.messageNodes.values())
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, limit)
        // 再次正序排列，确保发给模型时是符合对话逻辑的时间流
        .sort((a, b) => a.timestamp - b.timestamp)
        .map((node) => node.message);

      return allMessages;
    },
    getSessionIdForMessage: ({ chatId, messageId }) => {
      const ccb = chatControlBlocks.get(chatId);
      if (!ccb) return null;
      const node = ccb.messageNodes.get(messageId);
      return node?.sessionId ?? null;
    },
    debugPrintSessionControlBlocks: ({
      chatId,
      includeVectors = false,
      log = console.log,
    } = {}) => {
      const targetChatIds =
        typeof chatId === "number"
          ? [chatId]
          : Array.from(chatControlBlocks.keys()).sort((a, b) => a - b);

      if (targetChatIds.length === 0) {
        log("[context/debug] no chat control blocks.");
        return;
      }

      for (const targetChatId of targetChatIds) {
        const ccb = chatControlBlocks.get(targetChatId);
        if (!ccb) {
          log(`[context/debug] chat ${targetChatId} not found.`);
          continue;
        }

        const sessions = Array.from(ccb.sessionControlBlocks.values()).sort(
          (a, b) => b.lastActiveTime - a.lastActiveTime
        );
        log(
          `[context/debug] chat=${targetChatId} sessions=${sessions.length} messages=${ccb.messageNodes.size}`
        );
        for (const session of sessions) {
          const summary = {
            sessionId: session.sessionId,
            topicSummary: session.topicSummary,
            lastSummarizedMessageCount: session.lastSummarizedMessageCount,
            status: session.status,
            lastActiveTime: session.lastActiveTime,
            messageCount: session.messageIds.size,
            rootMessageCount: session.rootMessageIds.size,
            messageIds: Array.from(session.messageIds).sort((a, b) => a - b),
            rootMessageIds: Array.from(session.rootMessageIds).sort((a, b) => a - b),
            centerVectorDim: session.centerVector.length,
            recentVectorDim: session.recentVector?.length ?? 0,
            centerVector: includeVectors ? session.centerVector : undefined,
            recentVector: includeVectors ? session.recentVector : undefined,
          };
          log("[context/debug] session", summary);
        }
      }
    },
  };
}

function getOrCreateChatControlBlock(
  chatControlBlocks: Map<number, ChatControlBlock>,
  chatId: number
): ChatControlBlock {
  const existing = chatControlBlocks.get(chatId);
  if (existing) {
    return existing;
  }
  const next: ChatControlBlock = {
    chatId,
    sessionControlBlocks: new Map<string, SessionControlBlock>(),
    messageNodes: new Map<number, MessageNode>(),
    lastMessageNodeId: null,
    nextSessionSeq: 1,
  };
  chatControlBlocks.set(chatId, next);
  return next;
}

function buildEmbeddingTextWithGhostContext(
  ccb: ChatControlBlock,
  message: TelegramMessage
): string {
  const currentText = message.context;
  if (message.metadata.replyToMessageId) {
    return currentText;
  }

  const lastNode =
    typeof ccb.lastMessageNodeId === "number"
      ? ccb.messageNodes.get(ccb.lastMessageNodeId) ?? null
      : null;
  if (!lastNode) {
    return currentText;
  }
  if (lastNode.message.userId !== message.userId) {
    return currentText;
  }

  // const delta = message.timestamp - lastNode.timestamp;
  // if (delta < 0 || delta >= GHOST_CONTEXT_WINDOW_MS) {
  //   return currentText;
  // }
  if (lastNode.message.context.length >= MEDIUM_MESSAGE_LENGTH && currentText.length >= MEDIUM_MESSAGE_LENGTH) {
    return currentText;
  }

  return `${lastNode.message.context}\n${currentText}`;
}

function updateLastMessageNodeId(ccb: ChatControlBlock, candidate: MessageNode): void {
  const previous =
    typeof ccb.lastMessageNodeId === "number"
      ? ccb.messageNodes.get(ccb.lastMessageNodeId) ?? null
      : null;
  if (!previous || candidate.timestamp >= previous.timestamp) {
    ccb.lastMessageNodeId = candidate.messageId;
  }
}

async function archiveSession(session: SessionControlBlock): Promise<void> {
  await Promise.resolve();
}

function downgradeSessionStatus(session: SessionControlBlock): void {
  if (session.status === "L1_ACTIVE") {
    session.status = "L2_BACKGROUND";
  } else if (session.status === "L2_BACKGROUND") {
    session.status = "L3_ARCHIVED";
  }
}

async function downgradeExpiredSessions(
  ccb: ChatControlBlock,
  now: number,
  expireAfterMs: number
): Promise<void> {
  for (const session of ccb.sessionControlBlocks.values()) {
    if (now - session.lastActiveTime > expireAfterMs) {
      downgradeSessionStatus(session);
      if (session.status === "L3_ARCHIVED") {
        await archiveSession(session);
        ccb.sessionControlBlocks.delete(session.sessionId);
        for (const messageId of session.messageIds) {
          ccb.messageNodes.delete(messageId);
        }
      }
    }
  }
}

async function embedMessage(embedder: DenseEmbedder, text: string): Promise<number[]> {
  const vector = await embedder.embedDense(text.trim() || "(empty)");
  if (!Array.isArray(vector) || vector.length === 0) {
    throw new Error("Embedding provider returned an empty vector.");
  }
  return vector;
}

function pickBestSession(
  ccb: ChatControlBlock,
  vector: number[],
  now: number,
  alphaTime: number,
  lambda: number,
  isMediumMessage: boolean,
  isShortMessage: boolean,
  similarityThreshold: number,
  shortMessageThreshold: number
): { session: SessionControlBlock | null; score: number } {
  let winner: { session: SessionControlBlock; score: number } | null = null;
  for (const session of ccb.sessionControlBlocks.values()) {
    const score = scoreMessageToSession(vector, session, now, alphaTime, lambda);
    console.log(session.sessionId, score);
    if (!winner || score > winner.score) {
      winner = { session, score };
    }
  }
  if (winner && winner.score >= similarityThreshold) {
    return winner;
  }
  
  if(isMediumMessage) {
    const recentSessions = Array.from(ccb.sessionControlBlocks.values())
      .sort((a, b) => b.lastActiveTime - a.lastActiveTime)
      .slice(0, RECENT_SESSIONS_COUNT);

    let shortWinner: { session: SessionControlBlock; score: number } | null = null;
    for (const session of recentSessions) {
      const score = scoreMessageToSession(vector, session, now, alphaTime, lambda);
      // console.log("short", session.sessionId, score);
      if (!shortWinner || score > shortWinner.score) {
        shortWinner = { session, score };
      }
    }

    if (shortWinner && shortWinner.score > shortMessageThreshold) {
      return shortWinner;
    }
  }

  if(isShortMessage) {
    const recentSessions = Array.from(ccb.sessionControlBlocks.values())
      .sort((a, b) => b.lastActiveTime - a.lastActiveTime);
    return { session: recentSessions[0], score: 0 };
  }
  return {session: null, score: winner?.score ?? 0};
}

async function tryAssignSessionByDecider(input: {
  targetSession: SessionControlBlock | null;
  ccb: ChatControlBlock;
  message: TelegramMessage;
  localModel: LocalModel | undefined;
  cloudModel: CloudModel | undefined;
  sessionDecider: (input: {
    message: TelegramMessage;
    sessions: SessionSummary[];
    localModel?: LocalModel;
    cloudModel?: CloudModel;
  }) => Promise<SessionDeciderResult>;
}): Promise<SessionControlBlock | null> {
  const { targetSession, ccb, message, localModel, cloudModel, sessionDecider } = input;
  if (targetSession || (!localModel && !cloudModel) || ccb.sessionControlBlocks.size === 0) {
    return targetSession;
  }

  const sessions: SessionSummary[] = Array.from(ccb.sessionControlBlocks.values()).map((s) => ({
    sessionId: s.sessionId,
    topicSummary: s.topicSummary,
  }));
  const decision = await sessionDecider({
    message,
    sessions,
    localModel,
    cloudModel,
  });
  if (decision.action === "assign" && ccb.sessionControlBlocks.has(decision.sessionId)) {
    return ccb.sessionControlBlocks.get(decision.sessionId)!;
  }
  return targetSession;
}
function scoreMessage(
  vector1: number[],
  vector2: number[] | null | undefined,
  now: number,
  lastActiveTime: number,
  gammaTime: number,
  lambda: number
): number | null {
  if(!vector2) {
    return null;
  }
  const cosineScore = cosine(vector1, vector2);
  const deltaT = Math.max(0, (now - lastActiveTime) / 3600000);
  const timeWeight = Math.exp(-lambda * deltaT);
  const timeScore = Math.pow(timeWeight, gammaTime);
  return timeScore * cosineScore;
}

function scoreMessageToSession(
  vector: number[],
  session: SessionControlBlock,
  now: number,
  gammaTime: number,
  lambda: number
): number {
  // const cosineScore = cosine(vector, session.centerVector);
  // const deltaT = Math.max(0, (now - session.lastActiveTime) / 3600000);
  // // const timeScore = alphaTime * Math.exp(-lambda * deltaT);
  // // return cosineScore + timeScore;
  // const timeWeight = Math.exp(-lambda * deltaT);
  // const timeScore = Math.pow(timeWeight, gammaTime);
  // return timeScore * cosineScore;
  const centerScore =
    scoreMessage(vector, session.centerVector, now, session.lastActiveTime, gammaTime, lambda) ?? 0.999;
  const recentScore =
    scoreMessage(vector, session.recentVector, now, session.lastActiveTime, gammaTime, lambda) ?? 0;
  return Math.max(centerScore, recentScore);
  // return Math.max(scoreMessage(vector, session.centerVector, now, session.lastActiveTime, gammaTime, lambda), scoreMessage(vector, session.centerVector, now, session.lastActiveTime, gammaTime, lambda));
}

function cosine(vecA: number[], vecB: number[]): number {
  const dot = vecA.reduce((sum, a, i) => sum + a * vecB[i], 0);
  const normA = Math.sqrt(vecA.reduce((sum, a) => sum + a * a, 0));
  const normB = Math.sqrt(vecB.reduce((sum, b) => sum + b * b, 0));
  return dot / (normA * normB);
}

function createSession(
  ccb: ChatControlBlock,
  node: MessageNode,
  now: number,
  isShortMessage: boolean
): SessionControlBlock {
  const sessionId = `${ccb.chatId}:${ccb.nextSessionSeq++}`;
  const session: SessionControlBlock = {
    sessionId,
    topicSummary: buildTopicSummary(node.message.context),
    lastSummarizedMessageCount: 1,
    centerVector: node.vector.slice(),
    recentVector: isShortMessage ? null : node.vector.slice(),
    status: "L2_BACKGROUND",
    lastActiveTime: now,
    messageIds: new Set<number>(),
    rootMessageIds: new Set<number>(),
  };
  ccb.sessionControlBlocks.set(sessionId, session);
  return session;
}

function setSessionActive(ccb: ChatControlBlock, activeSessionId: string): void {
  // for (const session of ccb.sessionControlBlocks.values()) {
  //   session.status = session.sessionId === activeSessionId ? "L1_ACTIVE" : "L2_BACKGROUND";
  // }
  const session = ccb.sessionControlBlocks.get(activeSessionId);
  if (session) {
    session.status = "L1_ACTIVE";
  }
}

function updateCenterVector(previous: number[], current: number[], alphaCenter: number): number[] {
    // const n = Math.max(previous.length, current.length);
    // const next = new Array<number>(n);
    // for (let i = 0; i < n; i += 1) {
    //   const prev = previous[i] ?? 0;
    //   const curr = current[i] ?? 0;
    //   next[i] = alphaCenter * curr + (1 - alphaCenter) * prev;
    // }
    // return next;
    return previous.map((p, i) => alphaCenter * current[i] + (1 - alphaCenter) * p);
}

function buildTopicSummary(text: string): string {
  const normalized = text.trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "(empty)";
  }
  const maxLength = 80;
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 3)}...`;
}

function getSessionMessagesSorted(
  ccb: ChatControlBlock,
  session: SessionControlBlock
): MessageNode[] {
  return [...session.messageIds]
    .map((id) => ccb.messageNodes.get(id))
    .filter((item): item is MessageNode => Boolean(item))
    .sort((a, b) => a.timestamp - b.timestamp);
}

async function updateTopicSummary(
  ccb: ChatControlBlock,
  session: SessionControlBlock,
  cloudModel: LocalModel | undefined
): Promise<void> {
  const nodes = getSessionMessagesSorted(ccb, session);
  const N = nodes.length;
  const lastSummarized = session.lastSummarizedMessageCount ?? 0;
  if (N <= TOPIC_SUMMARY_CONCAT_MAX) {
    session.topicSummary = nodes
      .map((n) => n.message.context.trim())
      .filter(Boolean)
      .join("\n") || "(empty)";
    session.lastSummarizedMessageCount = N;
    return;
  }
  const newCount = N - lastSummarized;
  if (newCount < TOPIC_SUMMARY_CLOUD_BATCH) {
    return;
  }
  if (!cloudModel) {
    session.lastSummarizedMessageCount = N;
    return;
  }
  const from = lastSummarized;
  const batch = nodes.slice(from, from + TOPIC_SUMMARY_CLOUD_BATCH);
  const newTexts = batch.map((n) => n.message.context.trim()).filter(Boolean);
  const prompt = `You are a session summarizer. Given the previous topic summary and new messages, output a single short topic summary (one line, under 80 chars).

Previous topic summary:
${session.topicSummary}

New messages:
${newTexts.join("\n")}

Output only the new topic summary, no explanation:`;
  const { text } = await cloudModel.complete({ prompt });
  session.topicSummary = text.trim().slice(0, 80) || session.topicSummary;
  session.lastSummarizedMessageCount = from + TOPIC_SUMMARY_CLOUD_BATCH;
}

// function evictOldestSessionIfNeeded(ccb: ChatControlBlock, maxSessionsPerChat: number): void {
//   if (ccb.sessionControlBlocks.size < maxSessionsPerChat) {
//     return;
//   }
//   let oldest: SessionControlBlock | null = null;
//   for (const session of ccb.sessionControlBlocks.values()) {
//     if (!oldest || session.lastActiveTime < oldest.lastActiveTime) {
//       oldest = session;
//     }
//   }
//   if (!oldest) {
//     return;
//   }
//   ccb.sessionControlBlocks.delete(oldest.sessionId);
//   for (const messageId of oldest.messageIds) {
//     ccb.messageNodes.delete(messageId);
//   }
// }
