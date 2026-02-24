import type { AgentTool } from "@mariozechner/pi-agent-core";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDynamicToolsFromDirectory } from "./dynamicToolsLoader";
import { createAgentLoopRunner } from "./loopRunner";
import { createEvoluteTool } from "./tools/evolute";
import { createToolsRegistry } from "./toolsRegistry";
import { createToolsDocWriter } from "./toolsDocWriter";

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
const CURRENT_DIR = dirname(fileURLToPath(import.meta.url));
const EVOLUTIONS_DIR = resolve(CURRENT_DIR, "tools/evolutions");

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
  const toolsRegistry = createToolsRegistry(initialTools);
  const toolsDocWriter = createToolsDocWriter();
  const registerDynamicTool = async (tool: AgentTool<any>) => {
    toolsRegistry.registerDynamicTool(tool);
    loopRunner.applyToolsToActiveLoops();
    toolsDocWriter.sync(toolsRegistry.getCurrentTools());
  };
  const evoluteTool = createEvoluteTool(registerDynamicTool);
  toolsRegistry.registerStaticTool(evoluteTool);
  const loopRunner = createAgentLoopRunner({
    apiKey,
    baseURL,
    defaultModel,
    getCurrentTools: () => toolsRegistry.getCurrentTools(),
  });
  toolsDocWriter.sync(toolsRegistry.getCurrentTools());
  void (async () => {
    const loaded = await loadDynamicToolsFromDirectory(EVOLUTIONS_DIR);
    for (const tool of loaded.tools) {
      toolsRegistry.registerDynamicTool(tool);
    }
    if (loaded.tools.length > 0) {
      loopRunner.applyToolsToActiveLoops();
      toolsDocWriter.sync(toolsRegistry.getCurrentTools());
      console.log(
        `[dynamic-tools] loaded from evolutions: ${loaded.tools.map((tool) => tool.name).join(", ")}`
      );
    }
    for (const item of loaded.errors) {
      console.error(`[dynamic-tools] failed loading ${item.filePath}:`, item.error);
    }
  })();

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
    yield* loopRunner.streamText(messages, generateOptions);
  };

  const registerTool: OpenAIAgent["registerTool"] = async (tool) => {
    await registerDynamicTool(tool);
  };

  const unregisterTool: OpenAIAgent["unregisterTool"] = async (name) => {
    const deleted = toolsRegistry.unregisterTool(name);
    if (deleted) {
      loopRunner.applyToolsToActiveLoops();
      toolsDocWriter.sync(toolsRegistry.getCurrentTools());
    }
    return deleted;
  };

  const replaceTools: OpenAIAgent["replaceTools"] = async (tools) => {
    toolsRegistry.replaceStaticTools([...tools, evoluteTool]);
    loopRunner.applyToolsToActiveLoops();
    toolsDocWriter.sync(toolsRegistry.getCurrentTools());
  };

  const listTools: OpenAIAgent["listTools"] = () =>
    toolsRegistry.getCurrentTools().map((tool) => tool.name);

  return {
    generateText,
    streamText,
    registerTool,
    unregisterTool,
    replaceTools,
    listTools,
  };
}
