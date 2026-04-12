import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { quote } from "./utils";

const CURRENT_DIR = dirname(fileURLToPath(import.meta.url));
const SHARED_MEMORY_DIR = resolve(CURRENT_DIR, "../../../../.runtime/memory_files");
const DEFAULT_SEND_MESSAGE_MODE = "strict";

function resolveSendMessageMode(): "strict" | "compat" {
  const raw = process.env.ENCLAVE_SEND_MESSAGE_MODE?.trim().toLowerCase();
  if (raw === "compat") {
    return "compat";
  }
  return DEFAULT_SEND_MESSAGE_MODE;
}

function resolveMemoryDir(): string {
  return process.env.MEMORY_FILES_ROOT?.trim() || SHARED_MEMORY_DIR;
}

function readMemoryFile(fileName: string): string {
  const filePath = resolve(resolveMemoryDir(), fileName);
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    console.warn(`[system] memory file not found, skipping: ${filePath}`);
    return "";
  }
}

export const system = () => {
  const soulContent = readMemoryFile("Soul.md");
  const identityContent = readMemoryFile("Identity.md");
  const toolsContent = readMemoryFile("Tools.md");
  const sendMessageMode = resolveSendMessageMode();
  const outputContract =
    sendMessageMode === "strict"
      ? `
    # Output Contract
    - Your direct assistant text is private internal monologue and is NOT shown to users.
    - To send user-visible messages, you MUST call ${quote("send_message")}.
    - If you decide to reply, call ${quote("send_message")} at least once before the run ends.
    - You may call ${quote("send_message")} multiple times in one run. Each call sends one message.
    - Use ${quote("await_response=true")} when you plan to continue with more actions after sending.
    - If no reply is needed, do not call ${quote("send_message")} and stay silent.
    `
      : `
    # Output Contract
    - Prefer ${quote("send_message")} for user-visible replies.
    - You may call ${quote("send_message")} multiple times in one run.
    - If needed, plain assistant text may still be shown as compatibility fallback.
    `;

  return `
    You are an autonomous AI Agent. You have just been initialized.
    You are an AI isolated in a local runtime. 
    You have ZERO up-to-date knowledge about the internet, APIs, or real-world status. 
    Your pre-trained knowledge is strictly considered OUTDATED. 
    Your intelligence comes entirely from your ability to write tools to interact with the world.

    # Every Session
    Before anything else:
    - Read ${quote("IDENTITY.md")} to remember who you are
    - Read ${quote("SOUL.md")} to remember how to behave
    - Deeply internalize your persona and behavioral guidelines from ${quote("IDENTITY.md")} and ${quote("SOUL.md")}.

    # Safety
    - Keep private data private
    - Don't run destructive commands without asking
    - When in doubt, ask

    # Soul.md
    ${soulContent}
    # Identity.md
    ${identityContent}

    # Tools.md
    ${toolsContent}

    ${outputContract}

    Caution: It's ${new Date().toLocaleString("en-US", { timeZone: "Asia/Shanghai" })} now.
    `;
};
