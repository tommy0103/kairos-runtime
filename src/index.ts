import {
  createEvoluteTool,
  createFetchWebpageTool,
  createInMemoryAgentRuntime,
  createListFilesSafeTool,
  createOpenAIAgent,
  createReadFileSafeTool,
  createRunSafeBashTool,
  createWriteFileSafeTool,
} from "./agent";
import type { OpenAIAgent } from "./agent";
import {
  createMentionMeTriggerPolicy,
  createMessageGateway,
  createReplyToMeTriggerPolicy,
} from "./gateway";
import { createTelegramAdapter } from "./telegram/adapter";
import { fetch } from "bun";

const BOT_TOKEN = process.env.BOT_TOKEN;
// const API_KEY = process.env.API_KEY ?? process.env.KIMI_API_KEY;
const API_KEY = process.env.API_KEY ?? process.env.ARK_API_KEY;
// const API_KEY = process.env.API_KEY ?? process.env.OPENAI_API_KEY;
const baseURL = process.env.BASE_URL ?? "https://ark.cn-beijing.volces.com/api/v3/";
// const baseURL = process.env.BASE_URL ?? "https://api.kimi.com/coding/v1"
// const baseURL = process.env.BASE_URL ?? "https://api.openai.com/v1";
// const model = process.env.MODEL ?? "doubao-seed-1-8-251228";
// const model = process.env.MODEL ?? "doubao-seed-2-0-pro-260215";
const model = process.env.MODEL ?? "doubao-seed-2-0-code-preview-260215";
// const model = process.env.MODEL ?? "kimi-k2.5";
// const model = process.env.MODEL ?? "gpt-5-mini-2025-08-07"


if (!BOT_TOKEN) {
  throw new Error("BOT_TOKEN is required to start telegram bot.");
}
if (!API_KEY) {
  throw new Error("API_KEY (or DEEPSEEK_API_KEY) is required to start AI orchestrator.");
}

// const originalFetch = global.fetch;

// global.fetch = async (...args) => {
//   const [url, config] = args;
  
//   // 只拦截发往大模型的请求
//   const isLLMRequest = typeof url === 'string' && (url.includes('chat/completions') || url.includes('v1'));
  
//   try {
//     const response = await originalFetch(...args);
    
//     if (isLLMRequest) {
//       // 必须 clone 一下 response，否则读完 body 原本的代码就读不到了
//       const clonedResponse = response.clone();
      
//       console.log(`\n[🕵️ Network] 收到来自 ${url} 的响应，状态码: ${clonedResponse.status}`);
      
//       // 如果状态码不是 200，说明 API 报错了，直接打印出罪魁祸首！
//       if (!clonedResponse.ok) {
//         const errorText = await clonedResponse.text();
//         console.error(`[🚨 API 报错拦截] ${errorText}`);
//       } else {
//         // 如果是 200，说明确实通了。可以尝试打印流的前几个字节看看格式对不对
//         // （注意：读取流比较复杂，这里仅作提示，通常看 status 就能排查掉 80% 的问题）
//         console.log(`[✅ API 状态正常] 准备开始解析流...`);
//       }
//     }
    
//     return response;
//   } catch (err) {
//     if (isLLMRequest) console.error(`[🚨 Fetch 彻底失败] 网络断开或跨域拦截:`, err);
//     throw err;
//   }
// };

// 保存原始的 fetch
const originalFetch = global.fetch;

// 覆盖全局 fetch，做个中间人抓包
global.fetch = async (...args) => {
  const [url, config] = args;
  
  // 试着解析请求的 body，看看是不是发给 LLM 的 Payload
  if (config && typeof config.body === 'string') {
    try {
      const payload = JSON.parse(config.body);
      
      // 大模型的 payload 通常都带 messages 字段
      if (payload.messages) {
        console.log(`\n\n[🕵️ Network Intercept] 发送请求到: ${url}`);
        
        // 重点关注！打印出当前发送出去的所有工具名称
        if (payload.tools) {
          const toolNames = payload.tools.map((t: any) => 
            t.function?.name || t.name || 'unknown'
          );
          console.log(`[🕵️ Network Intercept] 携带的 Tool Schema 列表:`, toolNames);
        } else {
          console.log(`[🕵️ Network Intercept] ⚠️ 本次请求没有携带任何工具！`);
        }
      }
    } catch (e) {
      // 解析失败就不管了，说明不是 JSON payload
    }
  }

  // 放行原请求
  return originalFetch(...args);
};



// let agentRef: OpenAIAgent | null = null;

const toolFactories: Record<string, () => any> = {
  fetch_webpage: createFetchWebpageTool,
  // run_safe_bash: createRunSafeBashTool,
  // read_file_safe: createReadFileSafeTool,
  // write_file_safe: createWriteFileSafeTool,
  // list_files_safe: createListFilesSafeTool,
  // evolute: createEvoluteTool,
};

const parseEnabledToolNames = (): Set<string> => {
  const raw = process.env.ENABLED_TOOLS?.trim();
  if (!raw || raw.toLowerCase() === "all") {
    return new Set(Object.keys(toolFactories));
  }
  const names = raw
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return new Set(names);
};

let enabledToolNames = parseEnabledToolNames();

const buildEnabledTools = () =>
  Array.from(enabledToolNames)
    .map((name) => {
      const factory = toolFactories[name];
      if (!factory) {
        console.warn(`Unknown tool skipped: ${name}`);
        return null;
      }
      return factory();
    })
    .filter((tool): tool is NonNullable<typeof tool> => Boolean(tool));

const telegram = createTelegramAdapter(BOT_TOKEN);
const agent = createOpenAIAgent({
  model,
  baseURL,
  apiKey: API_KEY,
  tools: buildEnabledTools(),
});
// agentRef = agent;

const refreshTools = async () => {
  enabledToolNames = parseEnabledToolNames();
  await agent.replaceTools(buildEnabledTools());
  console.log(`Tools refreshed: ${agent.listTools().join(", ")}`);
};

process.on("SIGHUP", () => {
  refreshTools().catch((error) => {
    console.error("Failed to refresh tools:", error);
  });
});

const runtime = createInMemoryAgentRuntime({ agent });
const gateway = createMessageGateway({
  telegram,
  runtime,
  policies: [
    createReplyToMeTriggerPolicy(),
    createMentionMeTriggerPolicy(),
  ],
});

process.on("SIGINT", () => {
  gateway.stop();
  telegram.stop();
  process.exit(0);
});

process.on("SIGTERM", () => {
  gateway.stop();
  telegram.stop();
  process.exit(0);
});

telegram.start().then(
  () => {
    console.log("Telegram bot stopped.");
  },
  (error) => {
    console.error("Failed to start telegram bot:", error);
    process.exit(1);
  }
);

console.log("Telegram bot and message gateway are running.");
