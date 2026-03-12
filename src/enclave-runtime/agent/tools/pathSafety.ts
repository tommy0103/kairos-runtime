import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const CURRENT_DIR = dirname(fileURLToPath(import.meta.url));
// from src/enclave-runtime/agent/tools, ../../../ = src/
const DEFAULT_MEMORY_FILES_ROOT = resolve(CURRENT_DIR, "../../../.runtime/memory_files");

export const SAFE_TOOLS_ROOT =
  process.env.MEMORY_FILES_ROOT?.trim() || DEFAULT_MEMORY_FILES_ROOT;

export function resolveSafePath(inputPath: string): string {
  const normalized = inputPath.trim();
  if (!normalized) {
    throw new Error("Path is required.");
  }
  const configuredRoot = resolve(SAFE_TOOLS_ROOT);
  const safeRoot = configuredRoot;
  const absolutePath = resolve(safeRoot, normalized);
  if (absolutePath !== safeRoot && !absolutePath.startsWith(`${safeRoot}${sep}`)) {
    throw new Error("Path is outside the allowed tools directory.");
  }
  return absolutePath;
}
