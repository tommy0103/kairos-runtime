import type { AgentTool } from "@mariozechner/pi-agent-core";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CURRENT_DIR = dirname(fileURLToPath(import.meta.url));
// from src/enclave-runtime/agent/core, ../../../ = src/
const SHARED_MEMORY_DIR = resolve(CURRENT_DIR, "../../../.runtime/memory_files");
const DEFAULT_MEMORY_DIR = process.env.MEMORY_FILES_ROOT?.trim() || SHARED_MEMORY_DIR;
export const DEFAULT_TOOLS_MEMORY_FILE = resolve(DEFAULT_MEMORY_DIR, "Tools.md");

function schemaTypeToText(schema: any): string {
  if (!schema || typeof schema !== "object") {
    return "unknown";
  }
  if (Array.isArray(schema.type)) {
    return schema.type.join(" | ");
  }
  if (typeof schema.type === "string") {
    return schema.type;
  }
  if (schema.const !== undefined) {
    return JSON.stringify(schema.const);
  }
  if (Array.isArray(schema.enum)) {
    return schema.enum.map((item: unknown) => JSON.stringify(item)).join(" | ");
  }
  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
    return schema.anyOf.map((item: unknown) => schemaTypeToText(item)).join(" | ");
  }
  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
    return schema.oneOf.map((item: unknown) => schemaTypeToText(item)).join(" | ");
  }
  if (schema.type === "array") {
    return `${schemaTypeToText(schema.items)}[]`;
  }
  return "unknown";
}

function renderToolSignature(tool: AgentTool<any>): string {
  const schema: any = tool.parameters ?? {};
  const properties = (schema.properties ?? {}) as Record<string, any>;
  const required = new Set<string>(Array.isArray(schema.required) ? schema.required : []);
  const params = Object.entries(properties).map(([name, prop]) => {
    const optionalMarker = required.has(name) ? "" : "?";
    return `${name}${optionalMarker}: ${schemaTypeToText(prop)}`;
  });
  return `${tool.name}(${params.join(", ")}): string`;
}

function renderToolsMemory(tools: AgentTool<any>[]): string {
  if (tools.length === 0) {
    return "# Tools\n\nNo tools are currently registered.\n";
  }

  const lines: string[] = ["# Tools", ""];
  for (const tool of tools) {
    lines.push(`## ${tool.name}`);
    lines.push("```ts");
    lines.push(renderToolSignature(tool));
    lines.push("```");
    lines.push("");
    lines.push(`- description: ${tool.description.trim()}`);
    lines.push("- parameters:");
    const schema: any = tool.parameters ?? {};
    const properties = (schema.properties ?? {}) as Record<string, any>;
    const required = new Set<string>(Array.isArray(schema.required) ? schema.required : []);
    for (const [name, prop] of Object.entries(properties)) {
      const requiredText = required.has(name) ? "required" : "optional";
      const typeText = schemaTypeToText(prop);
      const description = typeof prop.description === "string" ? prop.description.trim() : "";
      const suffix = description ? ` - ${description}` : "";
      lines.push(`  - ${name} (${typeText}, ${requiredText})${suffix}`);
    }
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export interface ToolsDocWriter {
  sync: (tools: AgentTool<any>[]) => void;
}

export function createToolsDocWriter(
  toolsMemoryFilePath: string = DEFAULT_TOOLS_MEMORY_FILE
): ToolsDocWriter {
  return {
    sync: (tools) => {
      mkdirSync(dirname(toolsMemoryFilePath), { recursive: true });
      writeFileSync(toolsMemoryFilePath, renderToolsMemory(tools), "utf8");
    },
  };
}
