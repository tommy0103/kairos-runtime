import type { AgentTool } from "@mariozechner/pi-agent-core";
import { loadDynamicToolsFromDirectory } from "../dynamicToolsLoader";
import {
  createAgentLoopRunner,
  type AgentLoopRunner,
  type AgentLoopStreamEvent,
} from "./loopRunner";
import { createApoptosisTool } from "../tools/apoptosis";
import { createEvoluteTool } from "../tools/evolute";
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

export interface EnclaveStreamOptions extends GenerateTextOptions {
  imageUrls?: string[];
}

export interface OpenAIEnclaveRuntime {
  streamEvents: (
    messages: LLMMessage[],
    options?: EnclaveStreamOptions
  ) => AsyncGenerator<AgentLoopStreamEvent, void, unknown>;
  listTools: () => string[];
  replaceTools: (tools: AgentTool<any>[]) => Promise<void>;
}

const DEFAULT_MODEL = "deepseek-chat";
const DEFAULT_BASE_URL = "https://api.deepseek.com/v1";

function getEvolutionsDirFromEnv(): string {
  const evolutionsDir = process.env.EVOLUTIONS_ROOT?.trim();
  if (!evolutionsDir) {
    throw new Error("EVOLUTIONS_ROOT is required for loading dynamic tools.");
  }
  return evolutionsDir;
}

export function createOpenAIAgent(
  options: CreateOpenAIAgentOptions = {}
): OpenAIAgent {
  const core = createAgentCore(options);

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
    yield* core.loopRunner.streamText(messages, generateOptions);
  };

  const registerTool: OpenAIAgent["registerTool"] = async (tool) => {
    await core.registerDynamicTool(tool);
  };

  const unregisterToolApi: OpenAIAgent["unregisterTool"] = async (name) => core.unregisterTool(name);

  const replaceTools: OpenAIAgent["replaceTools"] = async (tools) => {
    await core.replaceTools(tools);
  };

  const listTools: OpenAIAgent["listTools"] = () =>
    core.toolsRegistry.getCurrentTools().map((tool) => tool.name);

  return {
    generateText,
    streamText,
    registerTool,
    unregisterTool: unregisterToolApi,
    replaceTools,
    listTools,
  };
}

export function createOpenAIEnclaveRuntime(
  options: CreateOpenAIAgentOptions = {}
): OpenAIEnclaveRuntime {
  const core = createAgentCore(options);
  return {
    streamEvents: async function* (messages, streamOptions = {}) {
      const { imageUrls, ...generateOptions } = streamOptions;
      yield* core.loopRunner.streamEvents(messages, { ...generateOptions, imageUrls });
    },
    listTools: () => core.toolsRegistry.getCurrentTools().map((tool) => tool.name),
    replaceTools: core.replaceTools,
  };
}

interface AgentCore {
  loopRunner: AgentLoopRunner;
  toolsRegistry: ReturnType<typeof createToolsRegistry>;
  registerDynamicTool: (tool: AgentTool<any>) => Promise<void>;
  unregisterTool: (name: string) => Promise<boolean>;
  replaceTools: (tools: AgentTool<any>[]) => Promise<void>;
}

function createAgentCore(options: CreateOpenAIAgentOptions): AgentCore {
  const apiKey = options.apiKey ?? process.env.API_KEY;
  if (!apiKey) {
    throw new Error("API_KEY is required for OpenAI agent.");
  }

  const defaultModel = options.model ?? DEFAULT_MODEL;
  const baseURL = options.baseURL ?? DEFAULT_BASE_URL;
  const initialTools = options.tools ?? [];
  const toolsRegistry = createToolsRegistry(initialTools);
  const toolsDocWriter = createToolsDocWriter();
  let loopRunner: AgentLoopRunner;
  const registerDynamicTool = async (tool: AgentTool<any>) => {
    toolsRegistry.registerDynamicTool(tool);
    loopRunner.applyToolsToActiveLoops();
    toolsDocWriter.sync(toolsRegistry.getCurrentTools());
  };
  const evoluteTool = createEvoluteTool();
  const apoptosisTool = createApoptosisTool();
  toolsRegistry.registerStaticTool(evoluteTool);
  toolsRegistry.registerStaticTool(apoptosisTool);
  const unregisterTool = async (name: string): Promise<boolean> => {
    const deleted = toolsRegistry.unregisterTool(name);
    if (deleted) {
      loopRunner.applyToolsToActiveLoops();
      toolsDocWriter.sync(toolsRegistry.getCurrentTools());
    }
    return deleted;
  };
  loopRunner = createAgentLoopRunner({
    apiKey,
    baseURL,
    defaultModel,
    getCurrentTools: () => toolsRegistry.getCurrentTools(),
    registerDynamicTool,
    unregisterTool,
  });
  toolsDocWriter.sync(toolsRegistry.getCurrentTools());
  void (async () => {
    const evolutionsDir = getEvolutionsDirFromEnv();
    const loaded = await loadDynamicToolsFromDirectory(evolutionsDir);
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

  const replaceTools = async (tools: AgentTool<any>[]) => {
    toolsRegistry.replaceStaticTools([...tools, evoluteTool, apoptosisTool]);
    loopRunner.applyToolsToActiveLoops();
    toolsDocWriter.sync(toolsRegistry.getCurrentTools());
  };
  return {
    loopRunner,
    toolsRegistry,
    registerDynamicTool,
    unregisterTool,
    replaceTools,
  };
}
