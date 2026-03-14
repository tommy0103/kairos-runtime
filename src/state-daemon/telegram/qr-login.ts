import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import * as qrcode from "qrcode-terminal";
import { loadStateDaemonConfig } from "../../app-config";

async function start() {
    const config = loadStateDaemonConfig();
    const userbot = config.telegram.userbot;

    if (!userbot) {
        console.error("错误: 未在 .env 中找到 UserBot 配置 (API_ID, API_HASH)");
        process.exit(1);
    }

    console.log("正在连接 Telegram...");
    const client = new TelegramClient(
        new StringSession(""),
        userbot.apiId,
        userbot.apiHash,
        { connectionRetries: 5 }
    );

    await client.connect();
    
    try {
        const user = await client.signInUserWithQrCode(
            { apiId: userbot.apiId, apiHash: userbot.apiHash },
            {
                qrCode: async (qr) => {
                    console.log("\n--- TELEGRAM 扫码登录 ---");
                    console.log("1. 在手机上打开 Telegram");
                    console.log("2. 前往 设置 > 设备 > 链接桌面设备 (Settings > Devices > Link Desktop Device)");
                    console.log("3. 扫描下方二维码:\n");
                    
                    // @ts-ignore
                    qrcode.generate(qr.token.toString(), { small: true });
                    
                    console.log("\n等待扫描中...");
                },
                onError: (err) => {
                    if (err.errorMessage !== "AUTH_TOKEN_EXPIRED") {
                        console.error("扫码登录错误:", err);
                    }
                    return true;
                }
            }
        );
        
        console.log("\n✅ 登录成功!");
        console.log("当前账号: " + user.firstName);
        console.log("\n--- 您的 SESSION STRING (请完整复制) ---");
        console.log(client.session.save());
        console.log("------------------------------------------\n");
        console.log("请复制上面的长字符串，并填入 .env 文件的 TELEGRAM_SESSION_STRING 中。");
        
    } catch (error) {
        console.error("登录失败:", error);
    } finally {
        await client.disconnect();
        process.exit(0);
    }
}

start();
