#!/usr/bin/env bun
/**
 * Terminal adapter for kairos-runtime.
 *
 * Same agent loop as Telegram, but reads from stdin/args and writes to stdout.
 * Tools go through logos kernel (logos_exec, logos_read, etc.)
 *
 * Usage:
 *   bun run src/terminal-adapter/main.ts "fix the bug in auth.ts"
 *   echo "deploy the service" | bun run src/terminal-adapter/main.ts
 *   bun run src/terminal-adapter/main.ts   # interactive
 */

import { createOpenAIEnclaveRuntime } from "../enclave-runtime/agent/core/openai";
import { logosPrimitiveTools, initLogosSession } from "../enclave-runtime/agent/tools/logosPrimitives";
import { createFetchWebpageTool } from "../enclave-runtime/agent/tools";
import * as readline from "node:readline";

const API_KEY = process.env.ENCLAVE_API_KEY ?? process.env.API_KEY ?? process.env.ANTHROPIC_API_KEY;
const BASE_URL = process.env.ENCLAVE_BASE_URL ?? process.env.BASE_URL ?? "http://127.0.0.1:11434/v1";
const MODEL = process.env.ENCLAVE_MODEL ?? process.env.MODEL ?? "claude-sonnet-4-20250514";

if (!API_KEY) {
  console.error("API key required: set ENCLAVE_API_KEY, API_KEY, or ANTHROPIC_API_KEY");
  process.exit(1);
}

// Set up for tool loading
process.env.API_KEY ??= API_KEY;
process.env.BASE_URL ??= BASE_URL;
process.env.MODEL ??= MODEL;
process.env.EVOLUTIONS_ROOT ??= ".runtime/evolutions";
process.env.MEMORY_FILES_ROOT ??= ".runtime/memory_files";
process.env.READ_FILE_SAFE_ROOT ??= process.cwd();

// Build tools
function buildTools() {
  const tools: any[] = [...logosPrimitiveTools];
  try { tools.push(createFetchWebpageTool()); } catch {}
  return tools;
}

// Init logos session
const LOGOS_SOCKET = process.env.LOGOS_SOCKET ?? process.env.KAIROS_VFS_SOCKET;
if (LOGOS_SOCKET) {
  process.env.LOGOS_SOCKET = LOGOS_SOCKET;
  await initLogosSession(`terminal-${Date.now()}`, "kairos-terminal").catch(e => {
    console.error("[terminal] logos session failed:", e.message);
  });
}

// Suppress noisy pi-agent-core debug logs
const origLog = console.log;
console.log = (...args: any[]) => {
  const first = String(args[0] ?? "");
  if (first.startsWith("[loopRunner]") || first.startsWith("[dynamic-tools]")
    || first.startsWith("tool_execution") || first.startsWith("{")) return;
  origLog(...args);
};

const runtime = createOpenAIEnclaveRuntime({
  apiKey: API_KEY,
  model: MODEL,
  baseURL: BASE_URL,
  tools: buildTools(),
});

// Get input
async function getInput(): Promise<string> {
  const args = process.argv.slice(2);
  if (args.length > 0) return args.join(" ");

  if (!process.stdin.isTTY) {
    const chunks: string[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk.toString());
    }
    return chunks.join("").trim();
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise(resolve => {
    rl.question("Task: ", answer => { rl.close(); resolve(answer.trim()); });
  });
}

const input = await getInput();
if (!input) {
  console.error("Usage: bun run src/terminal-adapter/main.ts <task>");
  process.exit(1);
}

console.error(`[terminal] task: ${input}`);
console.error(`[terminal] model: ${MODEL}`);

// Run agent
const messages = [
  { role: "system" as const, content: `You are a coding agent. Solve the task using your tools. Be concise.` },
  { role: "user" as const, content: input },
];

let fullOutput = "";
for await (const event of runtime.streamEvents(messages)) {
  switch (event.type) {
    case "message_update":
      if (event.delta) {
        process.stderr.write(event.delta);
        fullOutput += event.delta;
      }
      break;
    case "tool_execution_start":
      process.stderr.write(`\n  [${event.toolName}] `);
      break;
    case "tool_execution_end": {
      const result = event.result;
      let preview = "";
      if (result && typeof result === "object" && "content" in result) {
        const content = (result as any).content;
        if (Array.isArray(content) && content[0]?.text) {
          preview = content[0].text.slice(0, 120);
        }
      } else if (typeof result === "string") {
        preview = result.slice(0, 120);
      }
      process.stderr.write(`${preview}\n`);
      break;
    }
    case "completed":
      break;
    case "failed":
      console.error(`\n[terminal] failed: ${event.error}`);
      process.exit(1);
  }
}

console.error("\n[terminal] done");
console.log(fullOutput);
