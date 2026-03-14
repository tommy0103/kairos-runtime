import {
  createClientRuntime,
  createMentionMeTriggerPolicy,
  createMessageGateway,
  createPrivateChatTriggerPolicy,
  createReplyToMeTriggerPolicy,
} from "./gateway";
import { loadStateDaemonConfig } from "@kairos-runtime/app-config";
import { createAdapter, type TelegramConfig } from "./telegram";
import { createUserRolesStore } from "./storage";
import { createGrpcEnclaveClient } from "./enclave/client";

const config = loadStateDaemonConfig();
const AGENT_ENCLAVE_TARGET = config.grpc.enclaveTarget;
const OWNER_USER_ID = config.telegram.ownerUserId;

process.env.AGENT_ENCLAVE_TARGET ??= AGENT_ENCLAVE_TARGET;
process.env.MEMORY_VFS_TARGET ??= config.grpc.vfsTarget;
process.env.MEMORY_FILES_ROOT ??= config.runtime.memoryFilesRoot;
process.env.OLLAMA_BASE_URL ??= config.model.llm.ollama.baseUrl;
process.env.OLLAMA_SESSION_MODEL ??= config.model.llm.ollama.model;
process.env.OLLAMA_EMBED_MODEL ??= config.model.embedding.ollamaModel;
process.env.EMBED_PROVIDER ??= config.model.embedding.provider;
process.env.ARK_API_KEY ??= config.model.llm.cloud.apiKey;

if (config.telegram.mode === "bot" && !config.telegram.botToken) {
  throw new Error("BOT_TOKEN is required to start telegram bot.");
}

if (config.telegram.mode === "userbot" && !config.telegram.userbot) {
  throw new Error("UserBot configuration is required for userbot mode.");
}

const telegram = createAdapter(config.telegram as TelegramConfig);
const enclaveClient = createGrpcEnclaveClient({
  target: AGENT_ENCLAVE_TARGET,
});

console.log(`[state-daemon] AGENT_ENCLAVE_TARGET=${AGENT_ENCLAVE_TARGET}`);

process.on("SIGHUP", () => {});

const userRoles = createUserRolesStore();
if (OWNER_USER_ID) {
  userRoles.setRole(OWNER_USER_ID, "owner");
  console.log(`Owner registered: ${OWNER_USER_ID}`);
}

const runtime = createClientRuntime({
  enclaveClient,
  modelConfig: config.model,
});

const policies = [
  createReplyToMeTriggerPolicy(),
  createMentionMeTriggerPolicy(),
  ...(config.triggers.privateChat ? [createPrivateChatTriggerPolicy()] : []),
];

const gateway = createMessageGateway({
  telegram,
  runtime,
  policies,
  userRoles,
  enableEditedMessageTrigger: config.triggers.editedMessage,
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
