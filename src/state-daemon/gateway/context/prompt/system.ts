import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { quote } from "./utils";

const CURRENT_DIR = dirname(fileURLToPath(import.meta.url));
const SHARED_MEMORY_DIR = resolve(CURRENT_DIR, "../../../../.runtime/memory_files");

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

    Caution: It's ${new Date().toLocaleString("en-US", { timeZone: "Asia/Shanghai" })} now.
    `;
};
