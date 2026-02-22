import {
  createEvoluteTool,
  createFetchWebpageTool,
  createInMemoryAgentRuntime,
  createListFilesSafeTool,
  createOpenAIAgent,
  createReadFileSafeTool,
  createRunSafeBashTool,
  createWriteFileSafeTool,
} from "./agent";
import type { OpenAIAgent } from "./agent";
import {
  createMentionMeTriggerPolicy,
  createMessageGateway,
  createReplyToMeTriggerPolicy,
} from "./gateway";
import { createTelegramAdapter } from "./telegram/adapter";

const BOT_TOKEN = process.env.BOT_TOKEN;
const API_KEY = process.env.API_KEY ?? process.env.ARK_API_KEY;
const baseURL = process.env.BASE_URL ?? "https://ark.cn-beijing.volces.com/api/v3";
const model = process.env.MODEL ?? "doubao-seed-1-8-251228";

if (!BOT_TOKEN) {
  throw new Error("BOT_TOKEN is required to start telegram bot.");
}
if (!API_KEY) {
  throw new Error("API_KEY (or DEEPSEEK_API_KEY) is required to start AI orchestrator.");
}

// let agentRef: OpenAIAgent | null = null;

const toolFactories: Record<string, () => any> = {
  fetch_webpage: createFetchWebpageTool,
  // run_safe_bash: createRunSafeBashTool,
  read_file_safe: createReadFileSafeTool,
  write_file_safe: createWriteFileSafeTool,
  list_files_safe: createListFilesSafeTool,
  // evolute: createEvoluteTool,
};

const parseEnabledToolNames = (): Set<string> => {
  const raw = process.env.ENABLED_TOOLS?.trim();
  if (!raw || raw.toLowerCase() === "all") {
    return new Set(Object.keys(toolFactories));
  }
  const names = raw
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return new Set(names);
};

let enabledToolNames = parseEnabledToolNames();

const buildEnabledTools = () =>
  Array.from(enabledToolNames)
    .map((name) => {
      const factory = toolFactories[name];
      if (!factory) {
        console.warn(`Unknown tool skipped: ${name}`);
        return null;
      }
      return factory();
    })
    .filter((tool): tool is NonNullable<typeof tool> => Boolean(tool));

const telegram = createTelegramAdapter(BOT_TOKEN);
const agent = createOpenAIAgent({
  model,
  baseURL,
  apiKey: API_KEY,
  tools: buildEnabledTools(),
});
// agentRef = agent;

const refreshTools = async () => {
  enabledToolNames = parseEnabledToolNames();
  await agent.replaceTools(buildEnabledTools());
  console.log(`Tools refreshed: ${agent.listTools().join(", ")}`);
};

process.on("SIGHUP", () => {
  refreshTools().catch((error) => {
    console.error("Failed to refresh tools:", error);
  });
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
