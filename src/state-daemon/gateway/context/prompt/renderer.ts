import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderMarkdownString } from "@velin-dev/core";
import type { RenderLateBindingPromptInput, RenderSystemPromptInput } from "./types";

const CURRENT_DIR = dirname(fileURLToPath(import.meta.url));
const BASE_PATH = resolve(CURRENT_DIR, "../../../package.json");

const systemPromptTemplate = readFileSync(
  resolve(CURRENT_DIR, "./templates/primary-system.velin.md"),
  "utf-8",
);

const lateBindingTemplate = readFileSync(
  resolve(CURRENT_DIR, "./templates/primary-late-binding.velin.md"),
  "utf-8",
);

export async function renderSystemPrompt(input: RenderSystemPromptInput): Promise<string> {
  const { rendered } = await renderMarkdownString(systemPromptTemplate, input, BASE_PATH);
  return rendered;
}

export async function renderLateBindingPrompt(
  input: RenderLateBindingPromptInput,
): Promise<string> {
  const { rendered } = await renderMarkdownString(
    lateBindingTemplate,
    {
      timeZoneLabel: "Asia/Shanghai",
      ...input,
      conversationType: input.conversationType ?? "private",
      isProbeEnabled: input.isProbeEnabled ?? false,
      isProbing: input.isProbing ?? false,
      isMentioned: input.isMentioned ?? false,
      isReplied: input.isReplied ?? false,
      extraGuideline: input.extraGuideline ?? "",
      triggerReason: input.triggerReason ?? "",
    },
    BASE_PATH,
  );
  return rendered;
}
