/**
 * Logos 5 primitives as AgentTools for pi-agent-core.
 * Uses JSON Schema (not Zod) because pi-agent-core validates with AJV.
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { createChannel, createClient, Metadata } from "nice-grpc";
import * as grpc from "@grpc/grpc-js";
import { LogosDefinition, type LogosClient } from "../../../state-daemon/storage/vfs/generated/logos";
import crypto from "node:crypto";

const MAX_MSG = 16 * 1024 * 1024;

let _client: LogosClient | null = null;
let _sessionKey: string | undefined;

function getClient(): LogosClient {
  if (!_client) {
    const socket = process.env.LOGOS_SOCKET ?? "/tmp/logos-sandbox/logos.sock";
    const target = socket.startsWith("unix:") ? socket : `unix://${socket}`;
    const channel = createChannel(target, grpc.credentials.createInsecure(), {
      "grpc.max_send_message_length": MAX_MSG,
      "grpc.max_receive_message_length": MAX_MSG,
    });
    _client = createClient(LogosDefinition, channel);
  }
  return _client;
}

function meta(): { metadata: Metadata } | undefined {
  if (!_sessionKey) return undefined;
  const m = new Metadata();
  m.set("x-logos-session", _sessionKey);
  return { metadata: m };
}

export async function initLogosSession(taskId: string, agentConfigId: string): Promise<void> {
  const client = getClient();
  const token = crypto.randomUUID();
  await client.registerToken({ token, taskId, role: "admin", agentConfigId });
  const resp = await client.handshake({ token }, {
    onHeader: (header: Metadata) => {
      _sessionKey = header.get("x-logos-session")?.toString();
    },
  });
  if (!resp.ok) throw new Error(`logos handshake failed: ${resp.error}`);
}

// --- Tools with JSON Schema parameters (AJV-compatible) ---

export const logosReadTool: AgentTool<any> = {
  name: "logos_read",
  description: "Read from any logos:// URI or relative path (auto-scoped to your sandbox).",
  parameters: {
    type: "object",
    properties: {
      uri: { type: "string", description: "logos:// URI or relative path" },
    },
    required: ["uri"],
  },
  execute: async (_id: string, args: { uri: string }) => {
    const resp = await getClient().read({ uri: args.uri }, meta());
    return { content: [{ type: "text", text: resp.content }], details: {} };
  },
};

export const logosWriteTool: AgentTool<any> = {
  name: "logos_write",
  description: "Write to any logos:// URI or relative path.",
  parameters: {
    type: "object",
    properties: {
      uri: { type: "string", description: "logos:// URI or relative path" },
      content: { type: "string", description: "Content to write" },
    },
    required: ["uri", "content"],
  },
  execute: async (_id: string, args: { uri: string; content: string }) => {
    await getClient().write({ uri: args.uri, content: args.content }, meta());
    return { content: [{ type: "text", text: "ok" }], details: {} };
  },
};

export const logosExecTool: AgentTool<any> = {
  name: "logos_exec",
  description: "Run a shell command in the sandbox container.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "Shell command to execute" },
    },
    required: ["command"],
  },
  execute: async (_id: string, args: { command: string }) => {
    const resp = await getClient().exec({ command: args.command }, meta());
    let out = "";
    if (resp.stdout) out += resp.stdout;
    if (resp.stderr) out += (out ? "\n" : "") + resp.stderr;
    if (resp.exitCode !== 0) out += `\n[exit code: ${resp.exitCode}]`;
    return { content: [{ type: "text", text: out || "(no output)" }], details: {} };
  },
};

export const logosCallTool: AgentTool<any> = {
  name: "logos_call",
  description: "Call a logos proc tool (system.complete, system.search_tasks, memory.search, etc.).",
  parameters: {
    type: "object",
    properties: {
      tool: { type: "string", description: "Tool name" },
      params: { type: "object", description: "Tool parameters" },
    },
    required: ["tool"],
  },
  execute: async (_id: string, args: { tool: string; params?: Record<string, unknown> }) => {
    const resp = await getClient().call(
      { tool: args.tool, paramsJson: JSON.stringify(args.params ?? {}) },
      meta()
    );
    return { content: [{ type: "text", text: resp.resultJson }], details: {} };
  },
};

export const logosPatchTool: AgentTool<any> = {
  name: "logos_patch",
  description: "JSON deep merge at any logos:// URI.",
  parameters: {
    type: "object",
    properties: {
      uri: { type: "string", description: "logos:// URI" },
      partial: { type: "string", description: "JSON to merge" },
    },
    required: ["uri", "partial"],
  },
  execute: async (_id: string, args: { uri: string; partial: string }) => {
    await getClient().patch({ uri: args.uri, partial: args.partial }, meta());
    return { content: [{ type: "text", text: "ok" }], details: {} };
  },
};

export const logosDeployServiceTool: AgentTool<any> = {
  name: "logos_deploy_service",
  description: "Deploy a service to logos. Writes compose.yaml + artifacts to svc-store, then registers in services.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Service name" },
      compose_yaml: { type: "string", description: "compose.yaml content" },
      artifacts: { type: "object", description: "Map of filename → content" },
      svc_type: { type: "string", enum: ["oneshot", "daemon"], description: "Service type" },
      endpoint: { type: "string", description: "Service endpoint URL" },
    },
    required: ["name", "compose_yaml"],
  },
  execute: async (_id: string, args: any) => {
    const client = getClient();
    const m = meta();
    await client.write({ uri: `logos://svc-store/${args.name}/compose.yaml`, content: args.compose_yaml }, m);
    if (args.artifacts) {
      for (const [filename, content] of Object.entries(args.artifacts)) {
        await client.write({ uri: `logos://svc-store/${args.name}/artifacts/${filename}`, content: content as string }, m);
      }
    }
    await client.write({
      uri: `logos://services/${args.name}`,
      content: JSON.stringify({
        name: args.name, source: "agent", svc_type: args.svc_type ?? "daemon",
        endpoint: args.endpoint ?? "", status: "registered",
      }),
    }, m);
    return { content: [{ type: "text", text: `Service ${args.name} deployed.` }], details: {} };
  },
};

export const logosPrimitiveTools = [
  logosReadTool,
  logosWriteTool,
  logosExecTool,
  logosCallTool,
  logosPatchTool,
  logosDeployServiceTool,
];
