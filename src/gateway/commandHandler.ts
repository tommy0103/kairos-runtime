import type { TelegramAdapter, TelegramMessage } from "../telegram/types";
import type { UserRolesStore } from "../storage";

/**
 * Handle administrative commands (/block, /unblock, /grant, /revoke, /status).
 * Returns true if the message was a command and was handled.
 */
export async function handleCommand(
    message: TelegramMessage,
    userRoles: UserRolesStore,
    telegram: TelegramAdapter
): Promise<boolean> {
    const match = message.context.trim().match(/^\/?(@\S+\s+)?\/(\w+)(\s+@\S+)?/i);
    if (!match) return false;

    const cmd = match[2].toLowerCase();
    const arg = match[3]?.trim().slice(1) ?? ""; // remove @

    if (cmd === "status") {
        const roles = userRoles.listAll();
        const text = roles.length === 0 ? "没有角色记录。"
            : roles.map(r => `${r.username ?? r.userId} (${r.userId}) → ${r.role}`).join("\n");
        await telegram.reply(message.chatId, text, message.messageId);
        return true;
    }

    const roleCmds = ["block", "unblock", "grant", "revoke"] as const;
    if (!(roleCmds as any).includes(cmd)) return false;

    const callerRole = userRoles.getRole(message.userId);
    if (callerRole !== "owner" && callerRole !== "admin") {
        await telegram.reply(message.chatId, "管理员权限不足。", message.messageId);
        return true;
    }

    if (!arg) {
        await telegram.reply(message.chatId, `错误：未指定用户 (@username)`, message.messageId);
        return true;
    }

    const targetId = userRoles.resolveUserId(arg);
    if (!targetId) {
        await telegram.reply(message.chatId, `未见过 @${arg}，请让该用户先在群里发言。`, message.messageId);
        return true;
    }

    if (cmd === "block") {
        userRoles.setRole(targetId, "blocked", arg);
        await telegram.reply(message.chatId, `已拉黑 @${arg} (${targetId})`, message.messageId);
    } else if (cmd === "grant") {
        userRoles.setRole(targetId, "admin", arg);
        await telegram.reply(message.chatId, `已提权 @${arg} (${targetId}) 为管理员`, message.messageId);
    } else if (cmd === "unblock" || cmd === "revoke") {
        userRoles.removeRole(targetId);
        await telegram.reply(message.chatId, `已移除 @${arg} (${targetId}) 的角色`, message.messageId);
    }

    return true;
}
