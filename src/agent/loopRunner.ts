import {
  agentLoop,
  type AgentContext,
  type AgentMessage,
  type AgentTool,
} from "@mariozechner/pi-agent-core";
import type { Message, Model } from "@mariozechner/pi-ai";

export interface AgentLoopMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface AgentLoopGenerateOptions {
  model?: string;
  temperature?: number;
}

export interface AgentLoopRunner {
  streamText: (
    messages: AgentLoopMessage[],
    options?: AgentLoopGenerateOptions
  ) => AsyncGenerator<string, void, unknown>;
  applyToolsToActiveLoops: () => void;
}

export interface CreateAgentLoopRunnerOptions {
  apiKey: string;
  baseURL: string;
  defaultModel: string;
  getCurrentTools: () => AgentTool<any>[];
}

const DEFAULT_PROVIDER = "openai";

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

function extractSystemPrompt(messages: AgentLoopMessage[]): string {
  return messages
    .filter((item) => item.role === "system")
    .map((item) => item.content)
    .join("\n")
    .trim();
}

function extractLatestUserPrompt(messages: AgentLoopMessage[]): string {
  const latestUserMessage = [...messages]
    .reverse()
    .filter((item): item is AgentLoopMessage & { role: "user" } => item.role === "user")
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

function extractAssistantTextFromMessages(messages: AgentMessage[]): string {
  const lastAssistant = [...messages].reverse().find((item) => (item as any)?.role === "assistant") as
    | { content?: unknown }
    | undefined;
  if (!lastAssistant) {
    return "";
  }
  if (typeof lastAssistant.content === "string") {
    return lastAssistant.content;
  }
  if (!Array.isArray(lastAssistant.content)) {
    return "";
  }
  return (lastAssistant.content as Array<{ type?: string; text?: string }>)
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("");
}

function syncToolsInPlace(context: AgentContext, tools: AgentTool<any>[]) {
  if (!Array.isArray(context.tools)) {
    context.tools = [...tools];
    return;
  }
  context.tools.splice(0, context.tools.length, ...tools);
}

function isLlmMessage(message: AgentMessage): message is Message {
  const role = (message as any)?.role;
  return role === "user" || role === "assistant" || role === "toolResult";
}

export function createAgentLoopRunner(options: CreateAgentLoopRunnerOptions): AgentLoopRunner {
  const activeAgentLoops = new Set<AgentContext>();

  const applyToolsToActiveLoops = () => {
    const tools = options.getCurrentTools();
    for (const activeAgentLoop of activeAgentLoops) {
      syncToolsInPlace(activeAgentLoop, tools);
    }
  };

  const streamText: AgentLoopRunner["streamText"] = async function* (
    messages,
    generateOptions = {}
  ) {
    const model = createCompatibleModel(generateOptions.model ?? options.defaultModel, options.baseURL);
    const prompt = extractLatestUserPrompt(messages);
    const systemPrompt = extractSystemPrompt(messages);
    if (!prompt.trim()) {
      return;
    }

    const queue = createTextStreamQueue();
    let promptFinished = false;
    let promptPromise: Promise<void> | null = null;
    const loopContext: AgentContext = {
      systemPrompt,
      messages: [],
      tools: options.getCurrentTools(),
    };
    const abortController = new AbortController();
    activeAgentLoops.add(loopContext);

    let currentTextHasEmitted = false;
    let currentMessageHasEmitted = false;
    let globalMessageHasEmitted = false;
    try {
      const userPrompt = { role: "user", content: prompt, timestamp: Date.now() } as AgentMessage;
      const stream = agentLoop(
        [userPrompt],
        loopContext,
        {
          model,
          apiKey: options.apiKey,
          temperature: generateOptions.temperature,
          convertToLlm: async (agentMessages) => agentMessages.filter(isLlmMessage),
        },
        abortController.signal
      );

      promptPromise = (async () => {
        // [currentTextHasEmitted, currentMessageHasEmitted, globalMessageHasEmitted] 
        // = [false, false, false];
        for await (const event of stream) {
          if (event.type === "message_update") {
            const assistantEvent = event.assistantMessageEvent;
            if (assistantEvent.type === "text_delta" && assistantEvent.delta) {
              [currentTextHasEmitted, currentMessageHasEmitted, globalMessageHasEmitted] 
              = [true, true, true];
              queue.push(assistantEvent.delta);
              continue;
            }
            if (
              assistantEvent.type === "text_end" &&
              !currentTextHasEmitted &&
              assistantEvent.content
            ) {
              [currentTextHasEmitted, currentMessageHasEmitted, globalMessageHasEmitted] 
              = [false, true, true];
              queue.push(assistantEvent.content);
            }
            if (
              assistantEvent.type === "text_end" && 
              currentMessageHasEmitted 
            ) {
              [currentTextHasEmitted, currentMessageHasEmitted, globalMessageHasEmitted] 
              = [false, true, true];
            }
            continue;
          }

          if (event.type === "message_end") {
            if (!currentMessageHasEmitted) {
              const message = event.message as {
                role?: string;
                content?: Array<{ type?: string; text?: string }>;
              };
              if (message.role !== "assistant" || !Array.isArray(message.content)) {
                continue;
              }
              const fallbackText = message.content
                .filter((block) => block.type === "text" && typeof block.text === "string")
                .map((block) => block.text as string)
                .join("");
              if (fallbackText) {
                [currentTextHasEmitted, currentMessageHasEmitted, globalMessageHasEmitted] 
                = [false, false, true];
                queue.push(fallbackText);
              }
            }
            else {
              [currentTextHasEmitted, currentMessageHasEmitted, globalMessageHasEmitted] 
              = [false, false, true];
            }
            continue;
          }

          if (event.type === "tool_execution_end" && event.toolName === "evolute") {
            const latestTools = options.getCurrentTools();
            syncToolsInPlace(loopContext, latestTools);
          }

          if(event.type === "tool_execution_start") {
            console.log("[Event: tool_execution_start] Tool:", event.toolName, 
              "Params:", event.args,
              "ToolCallId:", event.toolCallId);
          }
        }

        if (!globalMessageHasEmitted) {
          const newMessages = await stream.result();
          const fallbackText = extractAssistantTextFromMessages(newMessages);
          if (fallbackText) {
            globalMessageHasEmitted = true;
            queue.push(fallbackText);
          }
        }

        promptFinished = true;
        queue.finish();
      })().catch((error) => {
        promptFinished = true;
        queue.fail(error);
      });

      for await (const chunk of queue.consume()) {
        yield chunk;
      }
      await promptPromise;
    } finally {
      if (!promptFinished && promptPromise) {
        abortController.abort();
        await promptPromise.catch(() => undefined);
      }
      activeAgentLoops.delete(loopContext);
      loopContext.messages.splice(0, loopContext.messages.length);
    }
  };

  return {
    streamText,
    applyToolsToActiveLoops,
  };
}
