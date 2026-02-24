import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@mariozechner/pi-ai";
import { Value } from "@sinclair/typebox/value";
import { readdir, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { pathToFileURL } from "node:url";

export interface LoadDynamicToolsResult {
  tools: AgentTool<any>[];
  errors: Array<{ filePath: string; error: unknown }>;
}

const DynamicToolSchema = Type.Object(
  {
    name: Type.String({ minLength: 1 }),
    label: Type.Optional(Type.String()),
    description: Type.String({ minLength: 1 }),
    parameters: Type.Object({}, { additionalProperties: true }),
    execute: Type.Any(),
  },
  { additionalProperties: true }
);

function validateDynamicTool(candidate: unknown): AgentTool<any> | null {
  if (!Value.Check(DynamicToolSchema, candidate)) {
    return null;
  }
  const tool = candidate as AgentTool<any> & { execute: unknown };
  if (typeof tool.execute !== "function") {
    return null;
  }
  return tool;
}

async function unwrapExportedTool(exportedValue: unknown): Promise<AgentTool<any> | null> {
  if (typeof exportedValue === "function") {
    const created = await exportedValue();
    return validateDynamicTool(created);
  }
  return validateDynamicTool(exportedValue);
}

async function loadToolFromFile(filePath: string): Promise<AgentTool<any>> {
  const fileStat = await stat(filePath);
  const moduleUrl = `${pathToFileURL(filePath).href}?v=${fileStat.mtimeMs}`;
  const loaded = await import(moduleUrl);

  const candidates = [loaded.default, ...Object.values(loaded)];
  for (const candidate of candidates) {
    try {
      const tool = await unwrapExportedTool(candidate);
      if (tool) {
        return tool;
      }
    } catch {
      // Ignore values that are not tool factories.
    }
  }

  throw new Error("No valid AgentTool export found.");
}

export async function loadDynamicToolsFromDirectory(
  directoryPath: string
): Promise<LoadDynamicToolsResult> {
  let entries: string[] = [];
  try {
    entries = await readdir(directoryPath);
  } catch (error) {
    return {
      tools: [],
      errors: [{ filePath: directoryPath, error }],
    };
  }

  const toolFiles = entries
    .filter((entry) => extname(entry).toLowerCase() === ".ts")
    .map((entry) => join(directoryPath, entry));

  const tools: AgentTool<any>[] = [];
  const errors: Array<{ filePath: string; error: unknown }> = [];
  for (const filePath of toolFiles) {
    try {
      tools.push(await loadToolFromFile(filePath));
    } catch (error) {
      errors.push({ filePath, error });
    }
  }

  return { tools, errors };
}
