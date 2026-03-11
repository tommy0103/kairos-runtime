import {
  createMemoryVfsClient,
  SearchMode,
  type MemoryVfsClient,
  type SearchResult,
} from "../../../storage/vfs";

const DEFAULT_SEMANTIC_LIMIT = 3;

export interface ContextSearcher {
  searchByMessageId: (input: { chatId: number; messageId: number | string }) => Promise<SearchResult | null>;
  searchSemantic: (input: { chatId: number; query: string; limit?: number }) => Promise<SearchResult[]>;
}

export interface CreateContextSearcherOptions {
  vfsClient?: Pick<MemoryVfsClient, "search">;
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
    searchSemantic: async ({ chatId, query, limit }) => {
      const normalizedQuery = query.trim();
      if (!normalizedQuery) {
        return [];
      }
      const normalizedLimit = limit && limit > 0 ? Math.floor(limit) : defaultSemanticLimit;
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
