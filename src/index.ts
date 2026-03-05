import {
  createGrpcEnclaveClient,
  createEvoluteTool,
  createFetchWebpageTool,
  createLocalEnclaveClient,
  createListFilesSafeTool,
  createOpenAIAgent,
  createReadFileSafeTool,
  createRunSafeBashTool,
  createWriteFileSafeTool,
  createUpdateUserMemoryTool,
} from "./agent";
import type { OpenAIAgent } from "./agent";
import {
  createClientRuntime,
  createMentionMeTriggerPolicy,
  createMessageGateway,
  createReplyToMeTriggerPolicy,
  createPrivateChatTriggerPolicy,
} from "./gateway";
import { createTelegramAdapter } from "./telegram/adapter";
import { createUserRolesStore } from "./storage";
import { fetch } from "bun";

const BOT_TOKEN = process.env.BOT_TOKEN;
const API_KEY = process.env.API_KEY ?? process.env.QWEN_API_KEY;
const AGENT_ENCLAVE_TARGET = process.env.AGENT_ENCLAVE_TARGET;
const OWNER_USER_ID = process.env.OWNER_USER_ID;
// const API_KEY = process.env.API_KEY ?? process.env.KIMI_API_KEY;
// const API_KEY = process.env.API_KEY ?? process.env.ARK_API_KEY;
// const API_KEY = process.env.API_KEY ?? process.env.OPENAI_API_KEY;
// const baseURL = process.env.BASE_URL ?? "https://ark.cn-beijing.volces.com/api/v3/";
// const baseURL = process.env.BASE_URL ?? "https://api.kimi.com/coding/v1"
// const baseURL = process.env.BASE_URL ?? "https://api.openai.com/v1";
const baseURL = process.env.BASE_URL ?? "https://coding.dashscope.aliyuncs.com/v1"
// const model = process.env.MODEL ?? "doubao-seed-1-8-251228";
// const model = process.env.MODEL ?? "doubao-seed-2-0-pro-260215";
// const model = process.env.MODEL ?? "kimi-for-coding"
const model = process.env.MODEL ?? "qwen3-coder-next"
// const model = process.env.MODEL ?? "doubao-seed-2-0-code-preview-260215";
// const model = process.env.MODEL ?? "kimi-k2.5";
// const model = process.env.MODEL ?? "gpt-5-mini-2025-08-07"
// const model = process.env.MODEL ?? "gpt-5.2-2025-12-11";
// const model = process.env.MODEL ?? "gpt-5.2-codex"
// const model = process.env.MODEL ?? "gpt-5-pro-2025-10-06"

if (!BOT_TOKEN) {
  throw new Error("BOT_TOKEN is required to start telegram bot.");
}
if (!AGENT_ENCLAVE_TARGET && !API_KEY) {
  throw new Error("API_KEY (or DEEPSEEK_API_KEY) is required to start AI orchestrator.");
}

// let agentRef: OpenAIAgent | null = null;

const toolFactories: Record<string, () => any> = {
  fetch_webpage: createFetchWebpageTool,
  update_user_memory: createUpdateUserMemoryTool,
  // run_safe_bash: createRunSafeBashTool,
  // read_file_safe: createReadFileSafeTool,
  // write_file_safe: createWriteFileSafeTool,
  // list_files_safe: createListFilesSafeTool,
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
const agent = AGENT_ENCLAVE_TARGET
  ? null
  : createOpenAIAgent({
    model,
    baseURL,
    apiKey: API_KEY,
    tools: buildEnabledTools(),
  });
const enclaveClient = AGENT_ENCLAVE_TARGET
  ? createGrpcEnclaveClient({
    target: AGENT_ENCLAVE_TARGET,
  })
  : createLocalEnclaveClient(agent as OpenAIAgent);

const refreshTools = async () => {
  if (!agent) {
    console.warn("refreshTools skipped: gRPC enclave mode is enabled.");
    return;
  }
  enabledToolNames = parseEnabledToolNames();
  await agent.replaceTools(buildEnabledTools());
  console.log(`Tools refreshed: ${agent.listTools().join(", ")}`);
};

process.on("SIGHUP", () => {
  refreshTools().catch((error) => {
    console.error("Failed to refresh tools:", error);
  });
});

const userRoles = createUserRolesStore();
if (OWNER_USER_ID) {
  userRoles.setRole(OWNER_USER_ID, "owner");
  console.log(`Owner registered: ${OWNER_USER_ID}`);
}

const runtime = createClientRuntime({
  enclaveClient,
});
const gateway = createMessageGateway({
  telegram,
  runtime,
  policies: [
    createPrivateChatTriggerPolicy(),
    createReplyToMeTriggerPolicy(),
    createMentionMeTriggerPolicy(),
  ],
  userRoles,
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
