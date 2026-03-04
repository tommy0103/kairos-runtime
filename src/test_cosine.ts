import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { createDenseEmbedder } from "./embedding";

function cosine(vecA: number[], vecB: number[]): number {
  const dot = vecA.reduce((sum, a, i) => sum + a * vecB[i], 0);
  const normA = Math.sqrt(vecA.reduce((sum, a) => sum + a * a, 0));
  const normB = Math.sqrt(vecB.reduce((sum, b) => sum + b * b, 0));
  return dot / (normA * normB);
}

async function main() {
  const embedder = createDenseEmbedder();
  const rl = createInterface({ input, output });

  console.log(`[cosine] provider=${process.env.EMBED_PROVIDER ?? "ollama"}`);
  console.log("[cosine] 输入 exit 可退出。");

  try {
    while (true) {
      const textA = (await rl.question("句子1 > ")).trim();
      if (textA.toLowerCase() === "exit") break;

      const textB = (await rl.question("句子2 > ")).trim();
      if (textB.toLowerCase() === "exit") break;

      const [vecA, vecB] = await embedder.embedDense([textA || "(empty)", textB || "(empty)"]);
      const score = cosine(vecA, vecB);

      console.log(`[cosine] score=${score}`);
    }
  } finally {
    rl.close();
  }
}

main().catch((error) => {
  console.error("[cosine] test failed:", error);
  process.exit(1);
});
