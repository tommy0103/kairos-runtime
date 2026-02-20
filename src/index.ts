import {
  createFetchWebpageTool,
  createInMemoryAgentRuntime,
  createListFilesSafeTool,
  createOpenAIAgent,
  createReadFileSafeTool,
  createRunSafeBashTool,
  createWriteFileSafeTool,
} from "./agent";
import {
  createMentionMeTriggerPolicy,
  createMessageGateway,
  createReplyToMeTriggerPolicy,
} from "./gateway";
import { createTelegramAdapter } from "./telegram/adapter";

const BOT_TOKEN = process.env.BOT_TOKEN;
const API_KEY = process.env.API_KEY ?? process.env.ARK_API_KEY;

if (!BOT_TOKEN) {
  throw new Error("BOT_TOKEN is required to start telegram bot.");
}
if (!API_KEY) {
  throw new Error("API_KEY (or DEEPSEEK_API_KEY) is required to start AI orchestrator.");
}

const telegram = createTelegramAdapter(BOT_TOKEN);
const agent = createOpenAIAgent({
  model: "doubao-seed-1-8-251228",
  baseURL: "https://ark.cn-beijing.volces.com/api/v3",
  apiKey: API_KEY,
  tools: [
    createFetchWebpageTool(),
    createRunSafeBashTool(),
    createReadFileSafeTool(),
    createWriteFileSafeTool(),
    createListFilesSafeTool(),
  ],
});
const runtime = createInMemoryAgentRuntime({ agent });
const gateway = createMessageGateway({
  telegram,
  runtime,
  policies: [
    createReplyToMeTriggerPolicy(),
    createMentionMeTriggerPolicy(),
  ],
});

process.on("SIGINT", () => {
  gateway.stop();
  telegram.stop();
  process.exit(0);
});

process.on("SIGTERM", () => {
  gateway.stop();
  telegram.stop();
  process.exit(0);
});

telegram.start().then(
  () => {
    console.log("Telegram bot stopped.");
  },
  (error) => {
    console.error("Failed to start telegram bot:", error);
    process.exit(1);
  }
);

console.log("Telegram bot and message gateway are running.");
