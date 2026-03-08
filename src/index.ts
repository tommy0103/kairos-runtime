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
import { createUserbotClient } from "./telegram/userbot";
import { createUserRolesStore } from "./storage";

async function main() {
  const BOT_TOKEN = process.env.BOT_TOKEN;
  const API_KEY = process.env.API_KEY ?? process.env.QWEN_API_KEY;
  const AGENT_ENCLAVE_TARGET = process.env.AGENT_ENCLAVE_TARGET;
  const OWNER_USER_ID = process.env.OWNER_USER_ID;
  const baseURL = process.env.BASE_URL ?? "https://coding.dashscope.aliyuncs.com/v1";
  const model = process.env.MODEL ?? "qwen3-coder-next";

  if (!BOT_TOKEN) {
    throw new Error("BOT_TOKEN is required to start telegram bot.");
  }
  if (!AGENT_ENCLAVE_TARGET && !API_KEY) {
    throw new Error("API_KEY is required to start AI orchestrator.");
  }

  const toolFactories: Record<string, () => any> = {
    fetch_webpage: createFetchWebpageTool,
    update_user_memory: createUpdateUserMemoryTool,
  };

  const parseEnabledToolNames = (): Set<string> => {
    const raw = process.env.ENABLED_TOOLS?.trim();
    if (!raw || raw.toLowerCase() === "all") {
      return new Set(Object.keys(toolFactories));
    }
    return new Set(raw.split(",").map((item) => item.trim()).filter(Boolean));
  };

  let enabledToolNames = parseEnabledToolNames();

  const buildEnabledTools = () =>
    Array.from(enabledToolNames)
      .map((name) => toolFactories[name]?.() ?? null)
      .filter(Boolean);

  const telegram = createTelegramAdapter(BOT_TOKEN);

  // 初始化 Userbot (MTProto 数据泵)
  let userbot: any = undefined;
  if (process.env.TELEGRAM_API_ID && process.env.TELEGRAM_API_HASH && process.env.TELEGRAM_STRING_SESSION) {
    try {
      userbot = await createUserbotClient({
        apiId: parseInt(process.env.TELEGRAM_API_ID),
        apiHash: process.env.TELEGRAM_API_HASH,
        stringSession: process.env.TELEGRAM_STRING_SESSION,
      });
      console.log("[Userbot] 暗网数据泵已上线。");
    } catch (err) {
      console.error("[Userbot] 启动失败:", err);
    }
  }

  const agent = AGENT_ENCLAVE_TARGET
    ? null
    : createOpenAIAgent({
      model,
      baseURL,
      apiKey: API_KEY,
      tools: buildEnabledTools(),
    });

  const enclaveClient = AGENT_ENCLAVE_TARGET
    ? createGrpcEnclaveClient({ target: AGENT_ENCLAVE_TARGET })
    : createLocalEnclaveClient(agent as OpenAIAgent);

  const refreshTools = async () => {
    if (!agent) return;
    enabledToolNames = parseEnabledToolNames();
    await agent.replaceTools(buildEnabledTools());
    console.log(`Tools refreshed: ${agent.listTools().join(", ")}`);
  };

  process.on("SIGHUP", () => { refreshTools().catch(console.error); });

  const userRoles = createUserRolesStore();
  if (OWNER_USER_ID) {
    userRoles.setRole(OWNER_USER_ID, "owner");
    console.log(`Owner registered: ${OWNER_USER_ID}`);
  }

  const runtime = createClientRuntime({ enclaveClient, userbot });
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

  const shutdown = () => {
    gateway.stop();
    telegram.stop();
    if (userbot) userbot.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  telegram.start().then(
    () => console.log("Telegram bot stopped."),
    (error) => {
      console.error("Failed to start telegram bot:", error);
      process.exit(1);
    }
  );

  console.log("Telegram bot and message gateway are running.");
}

// 解决 PM2 require() async module 不支持的问题：手动启动主函数并处理错误
main().catch((err) => {
  console.error("Fatal error during startup:", err);
  process.exit(1);
});
