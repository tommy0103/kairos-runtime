import type { LLMMessage, OpenAIAgent } from "../agent";
import type { TelegramAdapter, TelegramMessage } from "../telegram/types";
import type { GatewayContext, GatewayTriggerStrategy } from "./types";

const DEFAULT_SYSTEM_PROMPT = "你是一个简洁、友好的中文助手。";

export interface CreateMessageGatewayOptions {
  telegram: TelegramAdapter;
  agent: OpenAIAgent;
  strategies: GatewayTriggerStrategy[];
  maxHistoryPerChat?: number;
}

export interface MessageGateway {
  stop: () => void;
}

export function createMessageGateway(
  options: CreateMessageGatewayOptions
): MessageGateway {
  const maxHistoryPerChat = options.maxHistoryPerChat ?? 50;
  const historyByChat = new Map<number, TelegramMessage[]>();
  const context: GatewayContext = {
    telegram: options.telegram,
    agent: options.agent,
  };

  const strategies = [...options.strategies].sort(
    (a, b) => a.priority - b.priority
  );

  const unsubscribe = options.telegram.onMessage(async (message) => {
    saveHistory(historyByChat, message, maxHistoryPerChat);
    if (message.metadata.isBot) {
      return;
    }

    const prompt = await pickPrompt(strategies, message, context);
    if (!prompt) {
      return;
    }

    const llmMessages = buildLLMMessages(
      historyByChat.get(message.chatId) ?? [],
      prompt
    );

    await options.telegram.startStream(
      message.chatId,
      message.messageId
    );

    try {
      for await (const chunk of options.agent.streamText(llmMessages)) {
        options.telegram.appendStream(message.chatId, chunk);
      }
      await options.telegram.endStream(message.chatId);
    } catch (error) {
      options.telegram.appendStream(message.chatId, "\n(小猫可能把家拆了，等会儿再试试吧…)");
      await options.telegram.endStream(message.chatId);
      console.error("message gateway stream failed:", error);
    }
  });

  return {
    stop: () => unsubscribe(),
  };
}

async function pickPrompt(
  strategies: GatewayTriggerStrategy[],
  message: TelegramMessage,
  context: GatewayContext
): Promise<string | null> {
  for (const strategy of strategies) {
    const prompt = await strategy.tryTrigger(message, context);
    if (prompt) {
      return prompt;
    }
  }
  return null;
}

function saveHistory(
  historyByChat: Map<number, TelegramMessage[]>,
  message: TelegramMessage,
  maxHistoryPerChat: number
): void {
  const history = historyByChat.get(message.chatId) ?? [];
  history.push(message);
  if (history.length > maxHistoryPerChat) {
    history.splice(0, history.length - maxHistoryPerChat);
  }
  historyByChat.set(message.chatId, history);
}

function generateSystemPrompt(): string {
  // It's placeholder for system prompt, you can change it to your own system prompt.
  return `
  You are an AI agent, and now you wake up.

## Safety

- Keep private data private
- Don't run destructive commands without asking
- When in doubt, ask

## Contacts

You may receive messages from many people or bots (like yourself), They are from different channels.

You have a contacts book to record them that you do not need to worry about who they are.

## Channels

You are able to receive and send messages or files to different channels.

### Receive

Files user uploaded will added to your workspace, the file path will be included in the message header.
  `
}

function buildLLMMessages(
  history: TelegramMessage[],
  prompt: string
): LLMMessage[] {
  const userHistory: LLMMessage[] = history
    .filter((item) => !item.metadata.isBot)
    .map((item) => ({
      role: "user",
      content: item.context,
    }));

  const systemPrompt = generateSystemPrompt();

  return [
    { role: "system", content: systemPrompt },
    ...userHistory,
    { role: "user", content: prompt },
  ];
}
