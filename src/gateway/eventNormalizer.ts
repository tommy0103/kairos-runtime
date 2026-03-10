import type { TelegramMessage } from "../types/message";

const DEFAULT_MERGE_WINDOW_MS = 60000;

interface PendingBucket {
  messages: TelegramMessage[];
  timer: ReturnType<typeof setTimeout>;
}

interface FlushedAggregate {
  normalizedMessageId: number;
  sourceMessages: TelegramMessage[];
}

export interface CreateEventNormalizerOptions {
  mergeWindowMs?: number;
  onUpsert: (message: TelegramMessage) => void | Promise<void>;
}

export interface EventNormalizer {
  ingestMessage: (message: TelegramMessage) => void;
  ingestEditedMessage: (message: TelegramMessage) => void;
  flushChatBefore: (chatId: number, timestamp: number) => TelegramMessage[];
  stop: () => void;
}

export function createEventNormalizer(
  options: CreateEventNormalizerOptions
): EventNormalizer {
  const mergeWindowMs = options.mergeWindowMs ?? DEFAULT_MERGE_WINDOW_MS;
  const buckets = new Map<string, PendingBucket>();
  const sourceToNormalizedId = new Map<number, number>();
  const flushedAggregates = new Map<number, FlushedAggregate>();

  const emitUpsert = (message: TelegramMessage) => {
    void Promise.resolve(options.onUpsert(message)).catch((error) => {
      console.error("event normalizer onUpsert failed:", error);
    });
  };

  const rememberFlushedAggregate = (
    sourceMessages: TelegramMessage[],
    normalizedMessage: TelegramMessage
  ) => {
    const aggregate: FlushedAggregate = {
      normalizedMessageId: normalizedMessage.messageId,
      sourceMessages: sourceMessages.map((message) => ({ ...message })),
    };
    flushedAggregates.set(normalizedMessage.messageId, aggregate);
    for (const source of aggregate.sourceMessages) {
      sourceToNormalizedId.set(source.messageId, normalizedMessage.messageId);
    }
  };

  const flushBucket = (key: string) => {
    const pending = buckets.get(key);
    if (!pending) {
      return null;
    }
    clearTimeout(pending.timer);
    buckets.delete(key);
    const sourceMessages = pending.messages.map((message) => ({ ...message }));
    const merged = buildMergedMessage(sourceMessages);
    rememberFlushedAggregate(sourceMessages, merged);
    return merged;
  };

  const flushBucketAndEmit = (key: string) => {
    const merged = flushBucket(key);
    if (!merged) {
      return;
    }
    emitUpsert(merged);
  };

  const armTimer = (key: string) => {
    return setTimeout(() => {
      flushBucketAndEmit(key);
    }, mergeWindowMs);
  };

  const ingestMessage: EventNormalizer["ingestMessage"] = (message) => {
    const key = `${message.chatId}:${message.userId}`;
    const pending = buckets.get(key);
    const mergeable = isMergeCandidate(message);

    if (!mergeable) { // if the message is reply-to-message, it should not be merged?
      if (pending) {
        flushBucketAndEmit(key);
      }
      rememberFlushedAggregate([message], message);
      emitUpsert(message);
      return;
    }

    if (!pending) {
      buckets.set(key, {
        messages: [message],
        timer: armTimer(key),
      });
      return;
    }

    const lastMessage = pending.messages[pending.messages.length - 1];
    if (!canMerge(lastMessage, message, mergeWindowMs)) {
      flushBucketAndEmit(key);
      buckets.set(key, {
        messages: [message],
        timer: armTimer(key),
      });
      return;
    }

    pending.messages.push(message);
    clearTimeout(pending.timer);
    pending.timer = armTimer(key);
  };

  const ingestEditedMessage: EventNormalizer["ingestEditedMessage"] = (message) => {
    const pendingKey = findPendingBucketKeyBySourceId(buckets, message.messageId);
    if (pendingKey) {
      const pending = buckets.get(pendingKey);
      if (!pending) {
        return;
      }
      const idx = pending.messages.findIndex((item) => item.messageId === message.messageId);
      if (idx < 0) {
        return;
      }
      pending.messages[idx] = message;
      clearTimeout(pending.timer);
      pending.timer = armTimer(pendingKey);
      return;
    }

    const normalizedMessageId = sourceToNormalizedId.get(message.messageId);
    if (!normalizedMessageId) {
      return;
    }
    const aggregate = flushedAggregates.get(normalizedMessageId);
    if (!aggregate) {
      return;
    }
    const idx = aggregate.sourceMessages.findIndex(
      (item) => item.messageId === message.messageId
    );
    if (idx < 0) {
      return;
    }
    aggregate.sourceMessages[idx] = message;
    const merged = buildMergedMessage(aggregate.sourceMessages);
    merged.messageId = aggregate.normalizedMessageId;
    rememberFlushedAggregate(aggregate.sourceMessages, merged);
    emitUpsert(merged);
  };

  const flushChatBefore: EventNormalizer["flushChatBefore"] = (
    chatId,
    timestamp
  ) => {
    const flushed: TelegramMessage[] = [];
    for (const [key, pending] of buckets.entries()) {
      if (pending.messages.length === 0) {
        continue;
      }
      const lastMessage = pending.messages[pending.messages.length - 1];
      if (lastMessage.chatId !== chatId || lastMessage.timestamp > timestamp) {
        continue;
      }
      const merged = flushBucket(key);
      if (merged) {
        flushed.push(merged);
      }
    }
    return flushed.sort((a, b) => {
      if (a.timestamp !== b.timestamp) {
        return a.timestamp - b.timestamp;
      }
      return a.messageId - b.messageId;
    });
  };

  const stop: EventNormalizer["stop"] = () => {
    const keys = Array.from(buckets.keys());
    for (const key of keys) {
      flushBucketAndEmit(key);
    }
  };

  return {
    ingestMessage,
    ingestEditedMessage,
    flushChatBefore,
    stop,
  };
}

function findPendingBucketKeyBySourceId(
  buckets: Map<string, PendingBucket>,
  sourceMessageId: number
): string | null {
  for (const [key, pending] of buckets.entries()) {
    if (pending.messages.some((message) => message.messageId === sourceMessageId)) {
      return key;
    }
  }
  return null;
}

function isMergeCandidate(message: TelegramMessage): boolean {
  if (message.metadata.replyToMessageId) {
    return false;
  }
  const text = message.context.trimStart();
  if (!text) {
    return true;
  }
  return !text.startsWith("/");
}

function canMerge(
  previous: TelegramMessage,
  current: TelegramMessage,
  mergeWindowMs: number
): boolean {
  if (previous.chatId !== current.chatId || previous.userId !== current.userId) {
    return false;
  }
  if (!isMergeCandidate(previous) || !isMergeCandidate(current)) {
    return false;
  }
  const delta = current.timestamp - previous.timestamp;
  return delta >= 0 && delta <= mergeWindowMs;
}

function buildMergedMessage(messages: TelegramMessage[]): TelegramMessage {
  if (messages.length <= 1) {
    return messages[0];
  }
  const last = messages[messages.length - 1];
  const mergedMentions = Array.from(
    new Set(messages.flatMap((item) => item.metadata.mentions))
  );
  const mergedContext = messages
    .map((item) => item.context)
    .filter((item) => item.length > 0)
    .join("\n");

  return {
    ...last,
    context: mergedContext,
    timestamp: last.timestamp,
    metadata: {
      ...last.metadata,
      replyToMessageId: null,
      replyToUserId: null,
      isReplyToMe: false,
      isMentionMe: messages.some((item) => item.metadata.isMentionMe),
      mentions: mergedMentions,
    },
  };
}
