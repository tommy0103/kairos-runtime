import { Agent, type AgentTool } from "@mariozechner/pi-agent-core";
import { streamSimple, type ProviderStreamOptions } from "@mariozechner/pi-ai";
import type { Model } from "@mariozechner/pi-ai";
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createEvoluteTool } from "./tools/evolute";

export interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface CreateOpenAIAgentOptions {
  apiKey?: string;
  model?: string;
  baseURL?: string;
  tools?: AgentTool<any>[];
}

export interface GenerateTextOptions {
  model?: string;
  temperature?: number;
}

export interface OpenAIAgent {
  generateText: (messages: LLMMessage[], options?: GenerateTextOptions) => Promise<string>;
  streamText: (
    messages: LLMMessage[],
    options?: GenerateTextOptions
  ) => AsyncGenerator<string, void, unknown>;
  registerTool: (tool: AgentTool<any>) => Promise<void>;
  unregisterTool: (name: string) => Promise<boolean>;
  replaceTools: (tools: AgentTool<any>[]) => Promise<void>;
  listTools: () => string[];
}

const DEFAULT_MODEL = "gpt-4o-mini";
const DEFAULT_BASE_URL = "https://api.deepseek.com/v1";
const DEFAULT_PROVIDER = "openai-compatible";
const CURRENT_DIR = dirname(fileURLToPath(import.meta.url));
const TOOLS_MEMORY_FILE = resolve(CURRENT_DIR, "memory_files/Tools.md");

function createCompatibleModel(modelId: string, baseURL: string): Model<"openai-completions"> {
  return {
    id: modelId,
    name: modelId,
    api: "openai-completions",
    provider: DEFAULT_PROVIDER,
    baseUrl: baseURL,
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 128000,
    maxTokens: 128000,
  };
}

function extractSystemPrompt(messages: LLMMessage[]): string {
  return messages
    .filter((item) => item.role === "system")
    .map((item) => item.content)
    .join("\n")
    .trim();
}

function extractLatestUserPrompt(messages: LLMMessage[]): string {
  const latestUserMessage = [...messages]
    .reverse()
    .filter((item): item is LLMMessage & { role: "user" } => item.role === "user")
    .find((item) => item.content.trim().length > 0);
  return latestUserMessage?.content ?? "";
}

function createTextStreamQueue() {
  const chunks: string[] = [];
  let isDone = false;
  let error: unknown;
  let wakeConsumer: (() => void) | null = null;

  const wake = () => {
    if (!wakeConsumer) {
      return;
    }
    const resolve = wakeConsumer;
    wakeConsumer = null;
    resolve();
  };

  return {
    push(chunk: string) {
      chunks.push(chunk);
      wake();
    },
    finish() {
      isDone = true;
      wake();
    },
    fail(err: unknown) {
      error = err;
      isDone = true;
      wake();
    },
    async *consume(): AsyncGenerator<string, void, unknown> {
      while (!isDone || chunks.length > 0) {
        if (chunks.length > 0) {
          const chunk = chunks.shift();
          if (chunk) {
            yield chunk;
          }
          continue;
        }
        await new Promise<void>((resolve) => {
          wakeConsumer = resolve;
        });
      }
      if (error) {
        throw error;
      }
    },
  };
}

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

export function createOpenAIAgent(
  options: CreateOpenAIAgentOptions = {}
): OpenAIAgent {
  const apiKey = options.apiKey ?? process.env.API_KEY;
  if (!apiKey) {
    throw new Error("API_KEY is required for OpenAI agent.");
  }

  const defaultModel = options.model ?? DEFAULT_MODEL;
  const baseURL = options.baseURL ?? DEFAULT_BASE_URL;
  const initialTools = options.tools ?? [];
  const staticToolRegistry = new Map<string, AgentTool<any>>(
    initialTools.map((tool) => [tool.name, tool])
  );
  const dynamicToolRegistry = new Map<string, AgentTool<any>>();
  const activeAgents = new Set<Agent>();
  const evoluteTool = createEvoluteTool(async (tool) => {
    await registerTool(tool);
  });
  staticToolRegistry.set(evoluteTool.name, evoluteTool);
  const getCurrentTools = () => {
    const merged = new Map<string, AgentTool<any>>(staticToolRegistry);
    for (const [name, tool] of dynamicToolRegistry) {
      merged.set(name, tool);
    }
    return Array.from(merged.values());
  };
  const applyToolsToActiveAgents = () => {
    const tools = getCurrentTools();
    for (const activeAgent of activeAgents) {
      activeAgent.setTools(tools);
    }
  };
  const syncToolsMemoryFile = () => {
    const tools = getCurrentTools();
    const content = renderToolsMemory(tools);
    writeFileSync(TOOLS_MEMORY_FILE, content, "utf8");
  };
  syncToolsMemoryFile();

  const generateText: OpenAIAgent["generateText"] = async (
    messages,
    generateOptions = {}
  ) => {
    let output = "";
    for await (const chunk of streamText(messages, generateOptions)) {
      output += chunk;
    }
    return output;
  };

  const streamText: OpenAIAgent["streamText"] = async function* (
    messages,
    generateOptions = {}
  ) {
    const model = createCompatibleModel(generateOptions.model ?? defaultModel, baseURL);
    const prompt = extractLatestUserPrompt(messages);
    const systemPrompt = extractSystemPrompt(messages);
    if (!prompt.trim()) {
      return;
    }

    const queue = createTextStreamQueue();
    let promptFinished = false;
    let unsubscribe = () => {};
    let promptPromise: Promise<void> | null = null;
    let hasEmittedText = false;
    const agent = new Agent({
      initialState: {
        model,
        tools: getCurrentTools(),
        systemPrompt,
        messages: [],
      },
      streamFn: (streamModel, context, streamOptions) =>
        streamSimple(streamModel, context, {
          ...(streamOptions as ProviderStreamOptions),
          apiKey,
          temperature: generateOptions.temperature,
        }),
    });
    activeAgents.add(agent);

    try {
      unsubscribe = agent.subscribe((event) => {
        if (event.type !== "message_update") {
          return;
        }
        const assistantEvent = event.assistantMessageEvent;
        if (assistantEvent.type === "text_delta" && assistantEvent.delta) {
          hasEmittedText = true;
          queue.push(assistantEvent.delta);
          return;
        }
        if (
          assistantEvent.type === "text_end" &&
          !hasEmittedText &&
          assistantEvent.content
        ) {
          hasEmittedText = true;
          queue.push(assistantEvent.content);
        }
      });

      promptPromise = agent
        .prompt({ role: "user", content: prompt, timestamp: Date.now() })
        .then(() => {
          promptFinished = true;
          queue.finish();
        })
        .catch((error) => {
          promptFinished = true;
          queue.fail(error);
        });

      for await (const chunk of queue.consume()) {
        yield chunk;
      }
      await promptPromise;
    } finally {
      if (!promptFinished && promptPromise) {
        agent.abort();
        await promptPromise.catch(() => undefined);
      }
      unsubscribe();
      activeAgents.delete(agent);
      agent.clearMessages();
      agent.clearAllQueues();
    }
  };

  const registerTool: OpenAIAgent["registerTool"] = async (tool) => {
    dynamicToolRegistry.set(tool.name, tool);
    applyToolsToActiveAgents();
    syncToolsMemoryFile();
  };

  const unregisterTool: OpenAIAgent["unregisterTool"] = async (name) => {
    const deletedDynamic = dynamicToolRegistry.delete(name);
    const deletedStatic = staticToolRegistry.delete(name);
    const deleted = deletedDynamic || deletedStatic;
    if (deleted) {
      applyToolsToActiveAgents();
      syncToolsMemoryFile();
    }
    return deleted;
  };

  const replaceTools: OpenAIAgent["replaceTools"] = async (tools) => {
    staticToolRegistry.clear();
    for (const tool of tools) {
      staticToolRegistry.set(tool.name, tool);
    }
    applyToolsToActiveAgents();
    syncToolsMemoryFile();
  };

  const listTools: OpenAIAgent["listTools"] = () =>
    getCurrentTools().map((tool) => tool.name);

  return {
    generateText,
    streamText,
    registerTool,
    unregisterTool,
    replaceTools,
    listTools,
  };
}
