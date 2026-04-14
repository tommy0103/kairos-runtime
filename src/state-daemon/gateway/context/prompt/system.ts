import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { RenderSystemPromptInput, SendMessageMode, SystemPromptFile } from "./types";

const CURRENT_DIR = dirname(fileURLToPath(import.meta.url));
const SHARED_MEMORY_DIR = resolve(CURRENT_DIR, "../../../../.runtime/memory_files");
const DEFAULT_SEND_MESSAGE_MODE: SendMessageMode = "strict";
export const DEFAULT_TIME_ZONE = "Asia/Shanghai";

const DEFAULT_SYSTEM_FILE_NAMES = ["Soul.md", "Identity.md", "Tools.md"] as const;

export function resolveSendMessageMode(): SendMessageMode {
  const raw = process.env.ENCLAVE_SEND_MESSAGE_MODE?.trim().toLowerCase();
  if (raw === "compat") {
    return "compat";
  }
  return DEFAULT_SEND_MESSAGE_MODE;
}

export function resolveMemoryDir(): string {
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

export function loadSystemFilesFromMemory(
  fileNames: readonly string[] = DEFAULT_SYSTEM_FILE_NAMES,
): SystemPromptFile[] {
  return fileNames.map((fileName) => ({
    filename: fileName,
    content: readMemoryFile(fileName),
  }));
}

export function buildSystemPromptInput(params?: {
  sendMessageMode?: SendMessageMode;
  systemFiles?: SystemPromptFile[];
}): RenderSystemPromptInput {
  return {
    sendMessageMode: params?.sendMessageMode ?? resolveSendMessageMode(),
    systemFiles: params?.systemFiles ?? loadSystemFilesFromMemory(),
  };
}

export function formatTimeNow(timeZone: string = DEFAULT_TIME_ZONE): string {
  try {
    return new Date().toLocaleString("en-US", {
      timeZone,
      hour12: false,
    });
  } catch {
    return new Date().toISOString();
  }
}
