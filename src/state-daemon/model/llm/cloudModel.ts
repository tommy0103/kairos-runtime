import type { LLMMessage } from "../../types/message";
import type { CloudModel, CloudModelCompleteInput, CloudModelCompleteOutput } from "./types";
import { createLlmFetcher } from "../../../utils/llm-adapter";

export interface CreateOpenAICloudModelOptions {
  apiKey?: string;
  baseURL?: string;
  model?: string;
}

const DEFAULT_BASE_URL = "https://api.deepseek.com/v1";
const DEFAULT_MODEL = "deepseek-chat";
const MAX_RETRIES = 5;

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string }; delta?: { content?: string } }>;
}

export function createOpenAICloudModel(
  options: CreateOpenAICloudModelOptions = {}
): CloudModel {
  const apiKey = options.apiKey ?? process.env.API_KEY;
  const baseURL = (options.baseURL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const model = options.model ?? DEFAULT_MODEL;

  const fetcher = createLlmFetcher({ baseURL, apiKey });

  return {
    async complete(input: CloudModelCompleteInput): Promise<CloudModelCompleteOutput> {
      if (!apiKey) {
        throw new Error("API_KEY or options.apiKey is required for cloud model.");
      }

      const messages = input.messages.map(toChatMessage);
      let lastError: unknown = null;
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
        try {
          const data = await fetcher("/chat/completions", {
            model,
            messages,
            stream: false,
          }) as ChatCompletionResponse;

          const content = data.choices?.[0]?.message?.content;
          const text = typeof content === "string" ? content : "";
          return { text };
        } catch (error) {
          lastError = error;
          const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
          await sleep(3000);
          if (attempt >= MAX_RETRIES) {
            break;
          }
        }
      }

      throw lastError instanceof Error
        ? lastError
        : new Error("Cloud model request failed after retries.");
    },
  };
}

function toChatMessage(message: LLMMessage): { role: "user" | "assistant" | "system"; content: string } {
  return {
    role: message.role,
    content: message.content,
  };
}
