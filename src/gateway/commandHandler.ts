import type { TelegramAdapter, TelegramMessage } from "../telegram/types";
import type { UserRolesStore, UserRole } from "../storage";
import { logger } from "../utils/logger";

/**
 * Handle administrative commands (/status, /block, /unblock, /grant, /revoke, /flush_logs, /view_logs, /help).
 * Returns true if the message was a command and was handled.
 */
export async function handleCommand(
    message: TelegramMessage,
    userRoles: UserRolesStore,
    telegram: TelegramAdapter
): Promise<boolean> {
    // Robust regex to handle /cmd, /cmd@bot, and @bot /cmd formats
    const match = message.context.trim().match(/^(?:\/(\w+)(?:@\S+)?|@\S+\s+\/(\w+))(?:\s+(@\S+))?/i);
    if (!match) return false;

    const cmd = (match[1] ?? match[2]).toLowerCase();
    const arg = match[3]?.trim().slice(1) ?? ""; // remove @

    const callerRole = userRoles.getRole(message.userId);
    const isAdmin = callerRole === "owner" || callerRole === "admin";

    // Help command (accessible to all, but shows different lists)
    if (cmd === "help") {
        let text = " **可用命令**\n\n";
        text += "`/status` - 查看所有角色状态\n";
        text += "`/help` - 显示此帮助信息\n";

        if (isAdmin) {
            text += "\n🛠 **管理员专享**\n";
            text += "`/block @user` - 拉黑用户\n";
            text += "`/unblock @user` - 解除拉黑/降权\n";
            text += "`/grant @user` - 设为管理员\n";
            text += "`/revoke @user` - 移除管理权限\n";
            text += "`/view_logs [n]` - 查看最近 n 条日志\n";
            text += "`/flush_logs` - 清理 1 小时前的日志\n";
        }
        await telegram.reply(message.chatId, text, message.messageId);
        return true;
    }

    // Role-related commands types for safety
    const adminCmds = ["block", "unblock", "grant", "revoke", "flush_logs", "view_logs", "status"] as const;
    const isCommand = (v: string): v is (typeof adminCmds)[number] => (adminCmds as readonly string[]).includes(v);

    if (!isCommand(cmd)) return false;

    // All these commands require admin privileges
    if (!isAdmin) {
        await telegram.reply(message.chatId, "管理员权限不足。", message.messageId);
        return true;
    }

    if (cmd === "status") {
        const roles = userRoles.listAll();
        const text = roles.length === 0 ? "没有角色记录。"
            : roles.map(r => `${r.username ?? r.userId} (${r.userId}) → ${r.role}`).join("\n");
        await telegram.reply(message.chatId, text, message.messageId);
        return true;
    }

    if (cmd === "flush_logs") {
        const deleted = logger.flush(1);
        await telegram.reply(message.chatId, `清理完毕，已删除 1 小时前的 ${deleted} 条日志喵`, message.messageId);
        return true;
    }

    if (cmd === "view_logs") {
        const limit = parseInt(arg) || 20;
        const logs = logger.getRecentLogs(limit);
        if (logs.length === 0) {
            await telegram.reply(message.chatId, "目前没有任何日志记录。", message.messageId);
            return true;
        }
        const text = logs.map((l: any) => {
            const time = new Date(l.timestamp).toLocaleTimeString();
            return `\`[${time}] ${l.level.padEnd(5)} [${l.module}] ${l.message}\``;
        }).join("\n");
        await telegram.reply(message.chatId, `📜 **最近 ${logs.length} 条日志**:\n\n${text}`, message.messageId);
        return true;
    }

    // Role modification commands require a target arg
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
