import { createLlmFetcher } from "../../utils/llm-adapter";

export interface LlmEndpoint {
  model: string;
  baseURL?: string;
  apiKey?: string;
}

export interface LlmDescriptionResult {
  text: string;
  outputTokens?: number;
}

export function createSemaphore(capacity: number) {
  const size = Math.max(1, Math.floor(capacity));
  let available = size;
  const queue: Array<() => void> = [];

  return {
    async acquire(): Promise<void> {
      if (available > 0) {
        available -= 1;
        return;
      }
      await new Promise<void>((resolve) => queue.push(resolve));
      available -= 1;
    },
    release() {
      available += 1;
      if (available > size) {
        available = size;
      }
      const next = queue.shift();
      if (next) {
        next();
      }
    },
  };
}

export async function callDescriptionLlm(params: {
  model: LlmEndpoint;
  system: string;
  userText: string;
  images: Array<{ url: string }>;
  label?: string;
}): Promise<LlmDescriptionResult> {
  const fetcher = createLlmFetcher({
    baseURL: params.model.baseURL,
    apiKey: params.model.apiKey,
  });

  const payload = {
    model: params.model.model,
    stream: false,
    messages: [
      { role: "system", content: params.system },
      {
        role: "user",
        content: [
          { type: "text", text: params.userText },
          ...params.images.map((item) => ({
            type: "image_url",
            image_url: { url: item.url },
          })),
        ],
      },
    ],
  };

  const response = (await fetcher("/chat/completions", payload)) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { completion_tokens?: number };
  };

  const text = response.choices?.[0]?.message?.content?.trim() ?? "";
  if (!text) {
    throw new Error(`${params.label ?? "llm-description"} returned empty response`);
  }
  return {
    text,
    outputTokens: response.usage?.completion_tokens,
  };
}
