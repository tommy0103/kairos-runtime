import {
  createMemoryVfsClient,
  SearchMode,
  type MemoryVfsClient,
  type SearchResult,
} from "../../../storage/vfs";

const DEFAULT_SEMANTIC_LIMIT = 3;

export interface ContextSearcher {
  searchByMessageId: (input: { chatId: number; messageId: number | string }) => Promise<SearchResult | null>;
  searchSemantic: (input: {
    chatId: number;
    query: string;
    limit?: number;
    speakerId?: string | null;
    targetSpeakerIds?: string[];
  }) => Promise<SearchResult[]>;
}

export interface CreateContextSearcherOptions {
  vfsClient?: Pick<MemoryVfsClient, "search"> & Partial<Pick<MemoryVfsClient, "searchSemanticBySpeaker">>;
  defaultSemanticLimit?: number;
}

export function createContextSearcher(options: CreateContextSearcherOptions = {}): ContextSearcher {
  const vfsClient = options.vfsClient ?? createMemoryVfsClient();
  const defaultSemanticLimit =
    options.defaultSemanticLimit && options.defaultSemanticLimit > 0
      ? Math.floor(options.defaultSemanticLimit)
      : DEFAULT_SEMANTIC_LIMIT;

  return {
    searchByMessageId: async ({ chatId, messageId }) => {
      const scope = String(chatId);
      const query = `${scope}:${String(messageId)}`;
      const response = await vfsClient.search({
        query,
        scope,
        limit: 1,
        mode: SearchMode.SEARCH_MODE_EXACT,
      });
      return response.results[0] ?? null;
    },
    searchSemantic: async ({ chatId, query, limit, speakerId, targetSpeakerIds }) => {
      const normalizedQuery = query.trim();
      if (!normalizedQuery) {
        return [];
      }
      const normalizedLimit = limit && limit > 0 ? Math.floor(limit) : defaultSemanticLimit;
      const speakers = normalizeSpeakerIds(targetSpeakerIds, speakerId);
      if (speakers.length > 0) {
        if (typeof vfsClient.searchSemanticBySpeaker !== "function") {
          return [];
        }
        const scopedResults: SearchResult[] = [];
        for (const speaker of speakers) {
          const speakerResponse = await vfsClient.searchSemanticBySpeaker({
            chatId: String(chatId),
            speaker,
            query: normalizedQuery,
            limit: normalizedLimit,
          });
          scopedResults.push(...speakerResponse.results);
        }
        return mergeSearchResults(scopedResults, normalizedLimit);
      }

      const response = await vfsClient.search({
        query: normalizedQuery,
        scope: String(chatId),
        limit: normalizedLimit,
        mode: SearchMode.SEARCH_MODE_SEMANTIC,
      });
      return response.results;
    },
  };
}

function mergeSearchResults(results: SearchResult[], limit: number): SearchResult[] {
  const merged = new Map<string, SearchResult>();
  for (let i = 0; i < results.length; i += 1) {
    const result = results[i];
    const key = result.sessionId || result.messages[0]?.messageId || `idx:${i}`;
    const existing = merged.get(key);
    if (!existing || result.score > existing.score) {
      merged.set(key, result);
    }
  }
  return Array.from(merged.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, limit));
}

function normalizeSpeakerIds(targetSpeakerIds?: string[], speakerId?: string | null): string[] {
  const out: string[] = [];
  const push = (value: string | null | undefined) => {
    const normalized = (value ?? "").trim();
    if (!normalized || out.includes(normalized)) {
      return;
    }
    out.push(normalized);
  };

  for (const item of targetSpeakerIds ?? []) {
    push(item);
  }
  push(speakerId);
  return out;
}
