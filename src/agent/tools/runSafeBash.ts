import { spawn } from "node:child_process";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@mariozechner/pi-ai";
import { SAFE_TOOLS_ROOT } from "./pathSafety";

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_CHARS = 8_000;
const ALLOWED_WORKING_DIRECTORY = SAFE_TOOLS_ROOT;

const FORBIDDEN_PATTERNS: RegExp[] = [
  /\brm\b/i,
  /\bsudo\b/i,
  /\bchmod\b/i,
  /\bchown\b/i,
  /\bmv\b/i,
  /\bdd\b/i,
  /\bmkfs\b/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bkill(?:all)?\b/i,
  /\bpkill\b/i,
  /\bpoweroff\b/i,
  /\bcd\b/i,
  />\s*\//,
];

interface RunSafeBashDetails {
  command: string;
  cwd: string;
  timeoutMs: number;
  exitCode: number | null;
  signal: string | null;
}

function validateCommand(command: string): void {
  const normalized = command.trim();
  if (!normalized) {
    throw new Error("Command is required.");
  }
  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.test(normalized)) {
      throw new Error(`Command blocked by safety rule: ${pattern}`);
    }
  }
}

function clampTimeout(timeoutMs?: number): number {
  if (!timeoutMs || !Number.isFinite(timeoutMs)) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.min(Math.max(Math.floor(timeoutMs), 1_000), MAX_TIMEOUT_MS);
}

function truncate(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) {
    return text;
  }
  return `${text.slice(0, MAX_OUTPUT_CHARS)}\n...[truncated]`;
}

export function createRunSafeBashTool(): AgentTool<any, RunSafeBashDetails> {
  return {
    name: "run_safe_bash",
    label: "Run safe bash command",
    description:
      "Run a read-oriented bash command in ~/memoh-lite/src/agent/tools with safety checks.",
    parameters: Type.Object({
      command: Type.String({
        description: "Bash command to execute. Dangerous commands are blocked.",
      }),
      timeoutMs: Type.Optional(
        Type.Number({
          description: "Optional timeout in milliseconds. Default 15000, max 60000.",
        })
      ),
    }),
    execute: async (_toolCallId, params, signal) => {
      validateCommand(params.command);
      const timeoutMs = clampTimeout(params.timeoutMs);

      const result = await new Promise<{
        stdout: string;
        stderr: string;
        exitCode: number | null;
        signalName: string | null;
      }>((resolve, reject) => {
        const child = spawn("bash", ["-lc", params.command], {
          cwd: ALLOWED_WORKING_DIRECTORY,
          env: process.env,
        });

        let stdout = "";
        let stderr = "";
        let finished = false;
        let timedOut = false;

        const onAbort = () => {
          child.kill("SIGTERM");
          reject(new Error("Command aborted."));
        };

        signal?.addEventListener("abort", onAbort, { once: true });

        const timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
        }, timeoutMs);

        child.stdout.on("data", (chunk) => {
          stdout += String(chunk);
        });
        child.stderr.on("data", (chunk) => {
          stderr += String(chunk);
        });
        child.on("error", (error) => {
          if (finished) {
            return;
          }
          finished = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          reject(error);
        });
        child.on("close", (exitCode, signalName) => {
          if (finished) {
            return;
          }
          finished = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          if (timedOut) {
            reject(new Error(`Command timed out after ${timeoutMs}ms.`));
            return;
          }
          resolve({ stdout, stderr, exitCode, signalName });
        });
      });

      const text = [
        `exitCode: ${result.exitCode ?? "null"}`,
        `signal: ${result.signalName ?? "null"}`,
        "",
        "stdout:",
        truncate(result.stdout || "(empty)"),
        "",
        "stderr:",
        truncate(result.stderr || "(empty)"),
      ].join("\n");

      return {
        content: [{ type: "text", text }],
        details: {
          command: params.command,
          cwd: ALLOWED_WORKING_DIRECTORY,
          timeoutMs,
          exitCode: result.exitCode,
          signal: result.signalName,
        },
      };
    },
  };
}
