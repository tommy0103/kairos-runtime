import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import input from "input";

// 请在这里或通过环境变量填入你的凭证
const apiId = parseInt(process.env.TELEGRAM_API_ID || "0");
const apiHash = process.env.TELEGRAM_API_HASH || "";

(async () => {
  if (apiId === 0 || !apiHash) {
    console.error("请先在环境变量中设置 TELEGRAM_API_ID 和 TELEGRAM_API_HASH");
    process.exit(1);
  }

  const client = new TelegramClient(new StringSession(""), apiId, apiHash, {
    connectionRetries: 5,
  });

  await client.start({
    phoneNumber: async () => await input.text("请输入你的手机号 (带国家码, 如 +86...): "),
    password: async () => await input.text("请输入你的两步验证密码 (如果没有直接回车): "),
    phoneCode: async () => await input.text("请输入你收到的验证码: "),
    onError: (err) => console.log(err),
  });

  console.log("\n--- 登录成功！ ---");
  console.log("你的 STRING_SESSION 是 (请妥善保存，不要泄露):");
  console.log((client.session as any).save());
  console.log("------------------\n");

  await client.disconnect();
})();
