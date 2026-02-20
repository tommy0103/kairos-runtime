import { Agent, type AgentTool } from "@mariozechner/pi-agent-core";
import { streamSimple, type ProviderStreamOptions } from "@mariozechner/pi-ai";
import type { Model } from "@mariozechner/pi-ai";

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

function createMutex() {
  let tail = Promise.resolve();
  return async () => {
    let releaseLock = () => {};
    const lock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const previous = tail;
    tail = tail.then(() => lock);
    await previous;
    return () => releaseLock();
  };
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
  const toolRegistry = new Map<string, AgentTool<any>>(
    initialTools.map((tool) => [tool.name, tool])
  );
  let temperatureForCurrentRequest: number | undefined;
  const acquire = createMutex();
  const agent = new Agent({
    initialState: {
      model: createCompatibleModel(defaultModel, baseURL),
      tools: Array.from(toolRegistry.values()),
      systemPrompt: "",
      messages: [],
    },
    streamFn: (streamModel, context, streamOptions) =>
      streamSimple(streamModel, context, {
        ...(streamOptions as ProviderStreamOptions),
        apiKey,
        temperature: temperatureForCurrentRequest,
      }),
  });

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
    const releaseLock = await acquire();
    const queue = createTextStreamQueue();
    const model = createCompatibleModel(generateOptions.model ?? defaultModel, baseURL);
    const prompt = extractLatestUserPrompt(messages);
    const systemPrompt = extractSystemPrompt(messages);
    let promptFinished = false;
    let unsubscribe = () => {};
    let promptPromise: Promise<void> | null = null;

    try {
      if (!prompt.trim()) {
        return;
      }

      temperatureForCurrentRequest = generateOptions.temperature;
      agent.setModel(model);
      agent.setSystemPrompt(systemPrompt);
      agent.setTools(Array.from(toolRegistry.values()));
      agent.clearMessages();

      unsubscribe = agent.subscribe((event) => {
        if (event.type !== "message_update") {
          return;
        }
        const assistantEvent = event.assistantMessageEvent;
        if (assistantEvent.type === "text_delta" && assistantEvent.delta) {
          queue.push(assistantEvent.delta);
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
      temperatureForCurrentRequest = undefined;
      releaseLock();
      agent.clearMessages();
      agent.clearAllQueues();
    }
  };

  const registerTool: OpenAIAgent["registerTool"] = async (tool) => {
    const releaseLock = await acquire();
    try {
      toolRegistry.set(tool.name, tool);
      agent.setTools(Array.from(toolRegistry.values()));
    } finally {
      releaseLock();
    }
  };

  const unregisterTool: OpenAIAgent["unregisterTool"] = async (name) => {
    const releaseLock = await acquire();
    try {
      const deleted = toolRegistry.delete(name);
      if (deleted) {
        agent.setTools(Array.from(toolRegistry.values()));
      }
      return deleted;
    } finally {
      releaseLock();
    }
  };

  const replaceTools: OpenAIAgent["replaceTools"] = async (tools) => {
    const releaseLock = await acquire();
    try {
      toolRegistry.clear();
      for (const tool of tools) {
        toolRegistry.set(tool.name, tool);
      }
      agent.setTools(Array.from(toolRegistry.values()));
    } finally {
      releaseLock();
    }
  };

  const listTools: OpenAIAgent["listTools"] = () =>
    Array.from(toolRegistry.keys());

  return {
    generateText,
    streamText,
    registerTool,
    unregisterTool,
    replaceTools,
    listTools,
  };
}
