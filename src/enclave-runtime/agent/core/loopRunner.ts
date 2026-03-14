import {
  agentLoop,
  type AgentContext,
  type AgentMessage,
  type AgentTool,
} from "@mariozechner/pi-agent-core";
import type { Message, Model } from "@mariozechner/pi-ai";
import { consumePendingEvolutedTool } from "../tools/evolute";

export interface AgentLoopMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface AgentLoopGenerateOptions {
  model?: string;
  temperature?: number;
}

export interface AgentLoopRunner {
  streamEvents: (
    messages: AgentLoopMessage[],
    options?: AgentLoopGenerateOptions
  ) => AsyncGenerator<AgentLoopStreamEvent, void, unknown>;
  streamText: (
    messages: AgentLoopMessage[],
    options?: AgentLoopGenerateOptions
  ) => AsyncGenerator<string, void, unknown>;
  applyToolsToActiveLoops: () => void;
}

export type AgentLoopStreamEvent =
  | { type: "message_update"; role: "assistant"; delta: string; }
  | { type: "tool_execution_start"; toolName: string; toolCallId?: string; }
  | { type: "tool_execution_end"; toolName: string; toolCallId?: string; result?: unknown; }
  | { type: "completed"; }
  | { type: "failed"; error: string; };

export interface CreateAgentLoopRunnerOptions {
  apiKey: string;
  baseURL: string;
  defaultModel: string;
  getCurrentTools: () => AgentTool<any>[];
  registerDynamicTool: (tool: AgentTool<any>) => Promise<void>;
  unregisterTool: (name: string) => Promise<boolean>;
}

function createCompatibleModel(modelId: string, baseURL: string): Model<"openai-completions"> {
  return {
    id: modelId, name: modelId, api: "openai-completions", provider: "openai", baseUrl: baseURL,
    reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000, maxTokens: 4096
  };
}

function extractSystemPrompt(messages: AgentLoopMessage[]): string {
  return messages.filter((item) => item.role === "system").map((item) => item.content).join("\n").trim();
}

export function createAgentLoopRunner(options: CreateAgentLoopRunnerOptions): AgentLoopRunner {
  const activeAgentLoops = new Set<AgentContext>();
  const applyToolsToActiveLoops = () => {
    const tools = options.getCurrentTools();
    for (const loop of activeAgentLoops) {
      if (Array.isArray(loop.tools)) loop.tools.splice(0, loop.tools.length, ...tools);
      else loop.tools = [...tools];
    }
  };

  const streamEvents: AgentLoopRunner["streamEvents"] = async function* (messages, generateOptions = {}) {
    const model = createCompatibleModel(generateOptions.model ?? options.defaultModel, options.baseURL);
    const systemPrompt = extractSystemPrompt(messages);
    const loopContext: AgentContext = { systemPrompt, messages: [], tools: options.getCurrentTools() };
    const abortController = new AbortController();
    activeAgentLoops.add(loopContext);

    let currentMessageTextBuffer = "";
    let globalMessageHasEmitted = false;
    try {
      const stream = agentLoop(messages as AgentMessage[], loopContext, { model, apiKey: options.apiKey, temperature: generateOptions.temperature, convertToLlm: async (msgs) => msgs.filter((m: any) => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as any }, abortController.signal);

      for await (const event of stream) {
        if (event.type === "message_update") {
          const ae = event.assistantMessageEvent;
          if (ae.type === "text_delta" && ae.delta) { currentMessageTextBuffer += ae.delta; continue; }
          if (ae.type === "text_end" && ae.content) { if (!currentMessageTextBuffer) currentMessageTextBuffer = ae.content; continue; }
          continue;
        }
        if (event.type === "message_end") {
          const msg = event.message as any;
          if (msg.role === "assistant" && currentMessageTextBuffer) {
            globalMessageHasEmitted = true;
            yield { type: "message_update", role: "assistant", delta: currentMessageTextBuffer };
          }
          currentMessageTextBuffer = "";
          continue;
        }
      }
      // 暴力兜底逻辑
      if (!globalMessageHasEmitted && currentMessageTextBuffer.trim().length > 0) {
        yield { type: "message_update", role: "assistant", delta: currentMessageTextBuffer.trim() };
      }
      yield { type: "completed" };
    } catch (error: any) {
      yield { type: "failed", error: error.message || String(error) };
    } finally {
      abortController.abort();
      activeAgentLoops.delete(loopContext);
    }
  };

  return { streamEvents, streamText: async function* (msgs, opts = {}) {
    for await (const ev of streamEvents(msgs, opts)) {
      if (ev.type === "message_update" && ev.delta) yield ev.delta;
      if (ev.type === "failed") throw new Error(ev.error);
    }
  }, applyToolsToActiveLoops };
}
