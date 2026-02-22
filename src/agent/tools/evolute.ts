import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@mariozechner/pi-ai";
import { Value } from "@sinclair/typebox/value";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

interface EvoluteDetails {
  registeredToolName: string;
}

const EVOLUTE_MODULE_DIR = resolve(process.cwd(), ".evolute-modules");
const KEEP_EVOLUTE_MODULES = process.env.EVOLUTE_KEEP_MODULES === "1";

const DynamicToolSchema = Type.Object(
  {
    name: Type.String({ minLength: 1 }),
    label: Type.Optional(Type.String()),
    description: Type.String({ minLength: 1 }),
    parameters: Type.Object({}, { additionalProperties: true }),
    execute: Type.Any(),
  },
  { additionalProperties: true }
);

function validateDynamicTool(candidate: unknown): AgentTool<any> {
  if (!Value.Check(DynamicToolSchema, candidate)) {
    const firstError = [...Value.Errors(DynamicToolSchema, candidate)][0];
    const message = firstError ? `${firstError.path} ${firstError.message}` : "invalid shape";
    throw new Error(`Dynamic tool schema validation failed: ${message}`);
  }
  const tool = candidate as AgentTool<any> & { execute: unknown };
  if (typeof tool.execute !== "function") {
    throw new Error("Dynamic tool must provide execute().");
  }
  return tool;
}

async function compileToolFromCode(code: string): Promise<AgentTool<any>> {
  const source = code.trim();
  if (!source) {
    throw new Error("code is required.");
  }

  const moduleSource = buildModuleSource(source);
  const transpiled = ts.transpileModule(moduleSource, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
      isolatedModules: true,
    },
    reportDiagnostics: true,
  });

  if (transpiled.diagnostics?.length) {
    const first = transpiled.diagnostics[0];
    const message = ts.flattenDiagnosticMessageText(first.messageText, "\n");
    throw new Error(`TypeScript transpile failed: ${message}`);
  }

  await mkdir(EVOLUTE_MODULE_DIR, { recursive: true });
  const modulePath = join(
    EVOLUTE_MODULE_DIR,
    `tool-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`
  );

  await writeFile(modulePath, transpiled.outputText, "utf8");
  let tool: unknown;
  let hasError = false;
  try {
    const moduleUrl = `${pathToFileURL(modulePath).href}?v=${Date.now()}`;
    const loaded = await import(moduleUrl);
    tool = loaded.default;
    return validateDynamicTool(tool);
  } catch (error) {
    hasError = true;
    throw new Error(`Failed to compile tool from code: ${error}`);
  } finally {
    if (!KEEP_EVOLUTE_MODULES && !hasError) {
      await unlink(modulePath).catch(() => undefined);
    }
  }
}

function buildModuleSource(source: string): string {
  if (/\bexport\s+default\b/.test(source)) {
    return source;
  }

  const exportedFunction = source.match(/\bexport\s+function\s+([A-Za-z_$][\w$]*)\s*\(/);
  if (exportedFunction?.[1]) {
    return `${source}\n\nexport default ${exportedFunction[1]}();\n`;
  }

  const exportedConst = source.match(/\bexport\s+const\s+([A-Za-z_$][\w$]*)\s*=/);
  if (exportedConst?.[1]) {
    return `${source}\n\nexport default ${exportedConst[1]};\n`;
  }

  const looksLikeModule = /\b(import|export)\b/.test(source);
  if (looksLikeModule) {
    return `${source}\n\nexport default undefined;\n`;
  }

  return `
import { Type } from "@mariozechner/pi-ai";
const __tool = (
${source}
);
export default __tool;
`;
}

export function createEvoluteTool(
  registerTool: (tool: AgentTool<any>) => Promise<void>
): AgentTool<any, EvoluteDetails> {
  return {
    name: "evolute",
    label: "Evolute tool",
    description:
      "Register a new tool at runtime from JavaScript code (supports import/export module style).",
    parameters: Type.Object({
      code: Type.String({
        description:
          `JavaScript code for a tool. You can either provide:
          1) a module with imports + export default,
          2) an exported factory function, e.g. export function createXxxTool(){...},
          3) an object expression (Type is available as Type).
          
          Here is an example:
          \`\`\`ts
          import { Type } from "@mariozechner/pi-ai";

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
          \`\`\`
          
          The code will be evaluated in the context of the tool registry, so you can use the tools registered in the tool registry in the code.
          `,
      }),
    }),
    execute: async (_toolCallId, params) => {
      console.log("executing evolute tool", params.code);
      try {
        const dynamicTool = await compileToolFromCode(params.code);
        await registerTool(dynamicTool);
        return {
          content: [
            {
              type: "text",
              text: `Tool registered: ${dynamicTool.name}`,
            },
          ],
          details: {
            registeredToolName: dynamicTool.name,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.log("failed to register tool", message);
        return {
          content: [
            {
              type: "text",
              text: `Failed to register tool: ${message}`,
            },
          ],
          details: {
            registeredToolName: "",
          },
        };
      }
    },
  };
}
