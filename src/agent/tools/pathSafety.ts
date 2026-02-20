import { resolve, sep } from "node:path";

export const SAFE_TOOLS_ROOT = `${
  process.env.HOME ?? "/home/tomiya"
}/memoh-lite/src/agent/memory_files`;

export function resolveSafePath(inputPath: string): string {
  const normalized = inputPath.trim();
  if (!normalized) {
    throw new Error("Path is required.");
  }
  const absolutePath = resolve(SAFE_TOOLS_ROOT, normalized);
  const safeRoot = resolve(SAFE_TOOLS_ROOT);
  if (absolutePath !== safeRoot && !absolutePath.startsWith(`${safeRoot}${sep}`)) {
    throw new Error("Path is outside the allowed tools directory.");
  }
  return absolutePath;
}
