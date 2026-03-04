import type { DenseEmbedder } from "../types";

export interface CreateOllamaDenseEmbedderOptions {
  baseUrl?: string;
  model?: string;
  batchSize?: number;
}

interface OllamaEmbedResponse {
  embeddings?: number[][];
}

const DEFAULT_BASE_URL = "http://127.0.0.1:11434";
const DEFAULT_MODEL = "bge-m3";
const DEFAULT_BATCH_SIZE = 32;

const chunk = <T>(items: T[], chunkSize: number): T[][] => {
  if (chunkSize <= 0) return [items];
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    result.push(items.slice(i, i + chunkSize));
  }
  return result;
};

const normalizeVector = (vector: number[]): number[] => {
  const magnitude = Math.hypot(...vector);
  if (magnitude === 0) return vector;
  return vector.map((value) => value / magnitude);
};

const ensureEmbeddings = (
  data: unknown,
  expectedLength: number,
): number[][] => {
  const candidate = (data as OllamaEmbedResponse | null)?.embeddings;
  if (!Array.isArray(candidate)) {
    throw new Error("Invalid Ollama response: embeddings is missing.");
  }
  if (candidate.length !== expectedLength) {
    throw new Error(
      `Invalid Ollama response: expected ${expectedLength} embeddings, got ${candidate.length}.`,
    );
  }
  return candidate;
};

export const createOllamaDenseEmbedder = (
  options: CreateOllamaDenseEmbedderOptions = {},
): DenseEmbedder => {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const model = options.model ?? DEFAULT_MODEL;
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;

  return {
    async embedDense(input: string[]): Promise<number[][]> {
      if (input.length === 0) return [];

      const batches = chunk(input, batchSize);
      const output: number[][] = [];
      for (const batch of batches) {
        const response = await fetch(`${baseUrl}/api/embed`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model,
            input: batch,
          }),
        });

        if (!response.ok) {
          const reason = await response.text().catch(() => "");
          throw new Error(
            `Ollama embed request failed (${response.status}): ${reason}`,
          );
        }

        const data = await response.json();
        output.push(
          ...ensureEmbeddings(data, batch.length).map((vector) =>
            normalizeVector(vector),
          ),
        );
      }
      return output;
    },
  };
};
