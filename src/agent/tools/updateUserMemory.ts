import { createUserMemoryStore } from "../../storage/userMemory";

/**
 * 更新用户长期记忆工具
 * 让模型可以主动记录关于用户的重要事实、偏好或长期目标
 */
export function createUpdateUserMemoryTool() {
  const store = createUserMemoryStore();

  return {
    name: "update_user_memory",
    description: "更新或添加关于用户的长期记忆事实。当你从对话中了解到用户的偏好、背景、长期目标或其他值得长期记住的重要事实时，请调用此工具。请使用简洁、客观的陈述句，例如：'用户正在学习 Rust 编程'、'用户习惯在深夜工作'。",
    parameters: {
      type: "object",
      properties: {
        userId: {
          type: "string",
          description: "目标用户的唯一 ID (通常由上下文提供)"
        },
        facts: {
          type: "array",
          items: {
            type: "string"
          },
          description: "需要记录的一组事实陈述句列表"
        }
      },
      required: ["userId", "facts"]
    },
    execute: async ({ userId, facts }: { userId: string; facts: string[] }) => {
      try {
        console.log(`[Tool: update_user_memory] 正在为用户 ${userId} 更新记忆:`, facts);
        for (const fact of facts) {
          await store.addFact(userId, fact);
        }
        return { success: true, message: `成功记录了 ${facts.length} 条关于用户的新记忆。` };
      } catch (error) {
        console.error(`[Tool: update_user_memory] 失败:`, error);
        return { success: false, error: String(error) };
      }
    }
  };
}
