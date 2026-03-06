import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@mariozechner/pi-ai";
import { createUserMemoryStore } from "../../storage/userMemory";

interface UpdateUserMemoryDetails {
  factCount: number;
}

/**
 * 更新用户长期记忆工具
 * 让模型可以主动记录关于用户的重要事实、偏好或长期目标
 */
export function createUpdateUserMemoryTool(): AgentTool<any, UpdateUserMemoryDetails> {
  const store = createUserMemoryStore();

  return {
    name: "update_user_memory",
    label: "Update user memory",
    description:
      "更新或添加关于用户的长期记忆事实。当你从对话中了解到用户的偏好、背景、长期目标或其他值得长期记住的重要事实时，请调用此工具。请使用简洁、客观的陈述句，例如：'用户正在学习 Rust 编程'、'用户习惯在深夜工作'。",
    parameters: Type.Object({
      userId: Type.String({
        description: "目标用户的唯一 ID (通常由上下文提供)",
      }),
      facts: Type.Array(Type.String(), {
        description: "需要记录的一组事实陈述句列表",
      }),
    }),
    execute: async (_toolCallId, params) => {
      try {
        console.log(
          `[Tool: update_user_memory] 正在为用户 ${params.userId} 更新记忆:`,
          params.facts
        );
        for (const fact of params.facts) {
          await store.addFact(params.userId, fact);
        }
        return {
          content: [
            {
              type: "text",
              text: `成功记录了 ${params.facts.length} 条关于用户的新记忆。`,
            },
          ],
          details: { factCount: params.facts.length },
        };
      } catch (error) {
        console.error(`[Tool: update_user_memory] 失败:`, error);
        return {
          content: [
            {
              type: "text",
              text: `记忆更新失败: ${String(error)}`,
            },
          ],
          details: { factCount: 0 },
        };
      }
    },
  };
}
