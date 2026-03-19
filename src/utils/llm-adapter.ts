/**
 * Unified LLM Fetch Adapter Layer
 * Provides a single chokepoint for all LLM API requests in the system.
 */

export interface LLMAdapterOptions {
  baseURL?: string;
  apiKey?: string;
  headers?: Record<string, string>;
}

/**
 * Get unified headers for LLM requests.
 * This is where we inject global overrides like User-Agent.
 */
export function getLLMHeaders(customHeaders?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...customHeaders,
  };

  // Inject global User-Agent override if present
  const forceUA = process.env.OPENAI_FORCE_USER_AGENT?.trim();
  if (forceUA) {
    headers["User-Agent"] = forceUA;
  }

  return headers;
}

/**
 * A custom fetch wrapper for LLM calls.
 * Can be used directly or passed to SDKs that accept a custom fetch function.
 */
export async function customLlmFetch(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  const headers = new Headers(init?.headers);
  
  // Inject global User-Agent override if present
  const forceUA = process.env.OPENAI_FORCE_USER_AGENT?.trim();
  if (forceUA) {
    headers.set("User-Agent", forceUA);
  }

  const modifiedInit: RequestInit = {
    ...init,
    headers,
  };

  try {
    const response = await fetch(input, modifiedInit);
    return response;
  } catch (error) {
    console.error(`[LLM Adapter] Network error:`, error);
    throw error;
  }
}

/**
 * Factory function to create a simplified fetcher for direct API calls.
 * Useful for Ollama or simple REST calls.
 */
export function createLlmFetcher(options: LLMAdapterOptions) {
  return async (endpoint: string, payload: any, fetchOptions?: RequestInit) => {
    const baseURL = options.baseURL?.replace(/\/+$/, "") || "";
    const url = endpoint.startsWith("http") ? endpoint : `${baseURL}${endpoint}`;
    
    const headers = getLLMHeaders(options.headers);
    if (options.apiKey) {
      headers["Authorization"] = `Bearer ${options.apiKey}`;
    }

    const response = await customLlmFetch(url, {
      method: "POST",
      body: JSON.stringify(payload),
      ...fetchOptions,
      headers: {
        ...headers,
        ...fetchOptions?.headers,
      },
    });

    if (!response.ok) {
      const reason = await response.text().catch(() => "");
      throw new Error(`LLM API Error (${response.status}): ${reason}`);
    }

    return response.json();
  };
}
