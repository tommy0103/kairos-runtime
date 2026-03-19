import type { LocalModel, LocalModelCompleteInput, LocalModelCompleteOutput } from "./types";
import { createLlmFetcher } from "../../../utils/llm-adapter";

export interface CreateOllamaLocalModelOptions {
  baseUrl?: string;
  model?: string;
}

const DEFAULT_BASE_URL = "http://127.0.0.1:11434";
const DEFAULT_MODEL = "qwen3.5:0.8b";

interface OllamaGenerateResponse {
  response?: string;
  done?: boolean;
}

export function createOllamaLocalModel(
  options: CreateOllamaLocalModelOptions = {}
): LocalModel {
  const baseUrl = (options.baseUrl ?? process.env.OLLAMA_BASE_URL ?? DEFAULT_BASE_URL).replace(
    /\/+$/,
    ""
  );
  const model =
    options.model ?? process.env.OLLAMA_SESSION_MODEL ?? DEFAULT_MODEL;

  const fetcher = createLlmFetcher({ baseURL: baseUrl });

  return {
    async complete(input: LocalModelCompleteInput): Promise<LocalModelCompleteOutput> {
      const { prompt } = input;
      if (input.attachments?.length) {
        throw new Error("Ollama local model does not support attachments yet.");
      }

      const data = await fetcher("/api/generate", {
        model,
        prompt,
        stream: false,
      }) as OllamaGenerateResponse;

      const text = typeof data.response === "string" ? data.response : "";
      return { text };
    },
  };
}
