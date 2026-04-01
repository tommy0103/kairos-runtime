import {
  createClientRuntime,
  createMentionMeTriggerPolicy,
  createMessageGateway,
  createPrivateChatTriggerPolicy,
  createReplyToMeTriggerPolicy,
} from "./gateway";
import { loadStateDaemonConfig } from "@kairos-runtime/app-config";
import { createTelegramAdapter } from "./telegram/adapter";
import { createUserRolesStore } from "./storage";
import { createGrpcEnclaveClient } from "./enclave/client";

const config = loadStateDaemonConfig();
const BOT_TOKEN = config.telegram.botToken;
const AGENT_ENCLAVE_TARGET = config.grpc.enclaveTarget;
const OWNER_USER_ID = config.telegram.ownerUserId;

process.env.AGENT_ENCLAVE_TARGET ??= AGENT_ENCLAVE_TARGET;
process.env.MEMORY_VFS_TARGET ??= config.grpc.vfsTarget;
// logos-native: session clustering, embedding, and archiving handled by logos kernel.
// Only VFS target and enclave target are needed from config.

if (!BOT_TOKEN) {
  throw new Error("BOT_TOKEN is required to start telegram bot.");
}

const telegram = createTelegramAdapter(BOT_TOKEN);
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
