import type { DenseEmbedder } from "../types";
import { createLlmFetcher } from "../../../../utils/llm-adapter";

export interface CreateOllamaDenseEmbedderOptions {
  baseUrl?: string;
  model?: string;
}

interface OllamaEmbedResponse {
  embedding?: number[];  
}

const DEFAULT_BASE_URL = "http://127.0.0.1:11434";
const DEFAULT_MODEL = "bge-m3";

const normalizeVector = (vector: number[]): number[] => {
  const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  if (magnitude === 0) return vector;
  return vector.map((value) => value / magnitude);
};

export const createOllamaDenseEmbedder = (
  options: CreateOllamaDenseEmbedderOptions = {},
): DenseEmbedder => {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const model = options.model ?? DEFAULT_MODEL;

  const fetcher = createLlmFetcher({ baseURL: baseUrl });

  return {
    async embedDense(text: string): Promise<number[]> {
      const input = text.trim() || "(empty)";
      
      try {
        const data = await fetcher("/api/embeddings", {
          model,
          prompt: input,
        }) as OllamaEmbedResponse;

        const embedding = data?.embedding;
        if(!Array.isArray(embedding)) {
          throw new Error("Invalid Ollama response: embedding is missing.");
        }
        return embedding;
      } catch (error: any) {
        console.log("input", input);
        console.log("body", JSON.stringify({
          model,
          prompt: input,
        }));
        throw new Error(
          `Ollama embed request failed: ${error.message}`,
        );
      }
    },
  };
};
