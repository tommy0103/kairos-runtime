import type { GatewayTriggerPolicy } from "../types";

export function createPrivateChatTriggerPolicy(): GatewayTriggerPolicy {
  return {
    name: "PrivateChat",
    priority: 5, // 优先级最高，确保私信能被最先捕获
    decide: (message, context) => {
      // 只有私信会话才进入本逻辑
      if (message.conversationType !== "private") {
        return { shouldTrigger: false, reason: "none" };
      }

      // 检查权限：只允许 owner 和 member
      const userRoles = context.userRoles;
      if (userRoles) {
          const role = userRoles.getRole(message.userId);
          // 如果既不是 owner 也不是 member，则不触发
          if (role !== "owner" && role !== "member") {
              return { shouldTrigger: false, reason: "none" };
          }
      }

      const prompt = message.context.trim();
      if (!prompt) {
        return { shouldTrigger: false, reason: "none" };
      }
      
      return { shouldTrigger: true, reason: "private_chat", prompt };
    },
  };
}
