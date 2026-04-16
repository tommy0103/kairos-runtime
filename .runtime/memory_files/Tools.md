# Tools

## send_message
```ts
send_message(text: string, reply_to?: string | number, await_response?: boolean): string
```

- description: Queue a user-visible message for delivery in the current conversation. This is the primary output channel.
- parameters:
  - text (string, required) - Message text to send to the user.
  - reply_to (string | number, optional) - Optional message id to reply to.
  - await_response (boolean, optional) - Set true if you will continue with additional tool calls after sending this message.

## apoptosis
```ts
apoptosis(toolName: string): string
```

- description: Request removing a registered tool by name. Actual removal is handled by the loop runner event listener.
- parameters:
  - toolName (string, required) - Tool name to remove from dynamicToolRegistry.

## evolute
```ts
evolute(code: string): string
```

- description: Register a new tool at runtime from Typescript code (supports import/export module style).
- parameters:
  - code (string, required) - 🚨 **STRICT CODING STANDARDS (MANDATORY):**
              1. **Language:** You MUST write **Strict TypeScript**.
              2. **Type Safety & The `any` Keyword:**
                - **For Business Logic & API:** Usage of `any` is STRICTLY FORBIDDEN. You MUST define strict `interface` or `type` for all intermediate variables, API responses, and parsed JSON (e.g., `interface GithubCommit { ... }`).
                - **For Framework Signatures & Generics:** You are ALLOWED (and expected) to use `any` ONLY to satisfy base framework interfaces, complex generic parameters, or external library boundaries (e.g., `AgentTool<any, any>`). 
                - **Rule of thumb:** Never use `unknown` as a generic parameter if it breaks function signature compatibility. Use `any` for structural compatibility, but use strict types for your actual data payloads.
              3. **Imports:** - You MUST explicitly import all external dependencies using ESM syntax (e.g., `import * as cheerio from 'cheerio';`).
                - For standard Bun/Node built-ins, use `node:` prefix (e.g., `import { join } from 'node:path';`).
                - Even though `fetch` is global in Bun, prefer defining return types for it.
                - DON't USE REQUIRE TO IMPORT ANYTHING.
              4. **Structure:** - Your code MUST export a factory function that returns the tool object.
                - Keep the code self-contained in a single file.
              5. DON'T IMPORT ANYTHING TWICE (e.g. import type { AgentTool } from "@mariozechner/pi-ai" and import  from "@mariozechner/pi-ai" is not allowed).
    
              Typescript code for a tool. You can either provide:
              1) a module with imports + export default,
              2) an exported factory function, e.g. export function createXxxTool(){...},
              3) an object expression (Type is available as Type).
              
              Here is an example:
              ```ts
              import { Type } from "@mariozechner/pi-ai";
              import type { AgentTool } from "@mariozechner/pi-agent-core";
    
              interface EvoluteDetails {
                EvoluteToolName: string;
              }
    
              export function createEchoTool(): AgentTool<any, EvoluteDetails> {
                return {
                  name: "echo_tool",
                  label: "Echo tool",
                  description: "Echo the input text",
                  parameters: Type.Object({
                    text: Type.String({ description: "Text to echo" }),
                  }),
                  execute: async (_toolCallId, params) => ({
                    content: [{ type: "text", text: params.text }],
                    details: { ok: true },
                  }),
                };
              ```
              
              The code will be evaluated in the context of the tool registry, so you can use the tools registered in the tool registry in the code.

## fetch_webpage
```ts
fetch_webpage(url: string): string
```

- description: Fetch webpage content through r.jina.ai by passing a normal URL.
- parameters:
  - url (string, required) - Target webpage URL, e.g. https://example.com/page

## get_weather
```ts
get_weather(city: string): string
```

- description: 获取指定城市的当前天气信息
- parameters:
  - city (string, required) - 城市名称，例如：天津、北京、上海

## high_precision_multiply
```ts
high_precision_multiply(a: string, b: string): string
```

- description: 计算两个任意精度数字的乘积 a * b，支持整数和小数
- parameters:
  - a (string, required) - 第一个乘数（数字字符串）
  - b (string, required) - 第二个乘数（数字字符串）

## list_files_safe
```ts
list_files_safe(path?: string, recursive?: boolean, contains?: string, maxResults?: number): string
```

- description: List files/directories only under /root/kairos-runtime/.runtime/memory_files.
- parameters:
  - path (string, optional) - Relative directory path under src/enclave-runtime/agent/memory_files. Default current root.
  - recursive (boolean, optional) - Whether to list recursively. Default false.
  - contains (string, optional) - Optional substring filter on relative path.
  - maxResults (number, optional) - Maximum entries. Default 200, max 1000.

## mod_exp
```ts
mod_exp(base: string, exponent: string, modulus: string): string
```

- description: 计算大数的模幂运算 (base^exponent) mod modulus
- parameters:
  - base (string, required) - 底数
  - exponent (string, required) - 指数
  - modulus (string, required) - 模数

## mod_pow
```ts
mod_pow(base: string, exponent: string, modulus: string): string
```

- description: 计算大数模幂 a^b mod m
- parameters:
  - base (string, required) - 底数
  - exponent (string, required) - 指数
  - modulus (string, required) - 模数

## read_file_safe
```ts
read_file_safe(path: string): string
```

- description: Read a UTF-8 text file under project root with file-size and path safety checks.
- parameters:
  - path (string, required) - File path relative to READ_FILE_SAFE_ROOT.

## run_safe_bash
```ts
run_safe_bash(command: string, timeoutMs?: number): string
```

- description: Run a read-oriented bash command in /root/kairos-runtime/.runtime/memory_files with safety checks.
- parameters:
  - command (string, required) - Bash command to execute. Dangerous commands are blocked.
  - timeoutMs (number, optional) - Optional timeout in milliseconds. Default 15000, max 60000.

## send_file
```ts
send_file(items: array, caption?: string, reply_to?: string | number, await_response?: boolean): string
```

- description: Send image/audio/file media to the user. Supports multiple items in one call.
- parameters:
  - items (array, required) - Media items to send in order.
  - caption (string, optional) - Optional group-level caption. When multiple groups are sent, caption is applied to the first group.
  - reply_to (string | number, optional) - Optional message id to reply to.
  - await_response (boolean, optional) - Set true if you will continue with additional tool calls after sending.

## write_file_safe
```ts
write_file_safe(path: string, content: string, mode?: string | string): string
```

- description: Write UTF-8 content only under /root/kairos-runtime/.runtime/memory_files. Please use this tool to update Identity.md.
- parameters:
  - path (string, required) - Relative file path under /root/kairos-runtime/.runtime/memory_files.
  - content (string, required) - UTF-8 content to write.
  - mode (string | string, optional) - Write mode: overwrite (default) or append.
