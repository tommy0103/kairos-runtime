import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@mariozechner/pi-ai";
import { Value } from "@sinclair/typebox/value";
import { init as initEsmLexer, parse as parseEsm } from "es-module-lexer";
import { $ } from "bun";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

interface EvoluteDetails {
  registeredToolName: string;
}

const EVOLUTE_MODULE_DIR = resolve(process.cwd(), ".evolute-modules");
const TOOL_CODE_DIR = resolve(process.cwd(), "agent/tools/evolutions");
const KEEP_EVOLUTE_MODULES = process.env.EVOLUTE_KEEP_MODULES === "1";
const EVOLUTE_MANAGED_DEPS_FILE = join(EVOLUTE_MODULE_DIR, "package.json");
const BUILTIN_PLAIN_NAMES = new Set(builtinModules.map((name) => name.replace(/^node:/, "")));
const ESM_LEXER_READY = initEsmLexer;

const IGNORED_PACKAGE_NAMES = new Set<string>([
  "bun",
  "node",
  "typescript",
  "@mariozechner/pi-agent-core",
  "@mariozechner/pi-ai",
  "@sinclair/typebox",
]);

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

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

async function compileToolFromCode(code: string): Promise<AgentTool<any>> {
  const source = code.trim();
  if (!source) {
    throw new Error("code is required.");
  }

  console.log("source", source);
  const moduleSource = buildModuleSource(source);
  // const moduleSource = rewriteDefaultImports(buildModuleSource(source));
  // console.log("moduleSource", moduleSource);
  await mkdir(EVOLUTE_MODULE_DIR, { recursive: true });
  const detectedDeps = await detectExternalDependencies(source);
  console.log("detectedDeps", detectedDeps);
  await ensureDependencies(detectedDeps, EVOLUTE_MODULE_DIR);
  const modulePath = join(
    EVOLUTE_MODULE_DIR,
    `tool-${Date.now()}-${Math.random().toString(36).slice(2)}.ts`
  );
  // console.log("modulePath", modulePath);

  await writeFile(modulePath, moduleSource, "utf8");
  let tool: unknown;
  let hasError = false;
  let validatedTool: AgentTool<any> | null = null;
  try {
    const moduleUrl = `${pathToFileURL(modulePath).href}?v=${Date.now()}`;
    const loaded = await import(moduleUrl);
    tool = loaded.default;

    if (tool === undefined) {
      for (const exportedValue of Object.values(loaded)) {
        if (typeof exportedValue === "function") {
          try {
            const instance = await exportedValue();
            if (instance && typeof (instance as any).execute === "function" && (instance as any).name) {
              tool = instance;
              break;
            }
          } catch {
            // Ignore helper functions that are not tool factories.
          }
        } else if (
          exportedValue &&
          typeof exportedValue === "object" &&
          typeof (exportedValue as any).execute === "function" &&
          typeof (exportedValue as any).name === "string"
        ) {
          tool = exportedValue;
          break;
        }
      }
    }

    if (!tool) {
      throw new Error("Cannot find any valid Tool object or factory function in exports.");
    }

    if (typeof tool === "function") {
      tool = await tool();
    }

    validatedTool = validateDynamicTool(tool);
    // console.log("code", code);
    // console.log("validatedTool", validatedTool);
    await mkdir(TOOL_CODE_DIR, { recursive: true });
    const codeUrl = `${TOOL_CODE_DIR}/${validatedTool.name}.ts`;
    await writeFile(codeUrl, code, "utf8");
    await writeDependencySnapshot(validatedTool.name, detectedDeps);
    return validatedTool;
  } catch (error) {
    hasError = true;
    console.error("error", error);
    throw new Error(`Failed to compile tool from code: ${toErrorMessage(error)}`);
  } finally {
    if (!KEEP_EVOLUTE_MODULES && !hasError && validatedTool) {
      await unlink(modulePath).catch(() => undefined);
    }
  }
}

function rewriteBuiltinDefaultImports(source: string): string {
  const defaultImportPattern =
    /import\s+([A-Za-z_$][\w$]*)\s+from\s+["']((?:node:)?[A-Za-z][\w./-]*)["'];?/g;

  return source.replace(defaultImportPattern, (full, localName: string, specifier: string) => {
    const normalized = specifier.replace(/^node:/, "");
    if (!BUILTIN_PLAIN_NAMES.has(normalized)) {
      return full;
    }
    return `import * as ${localName} from "node:${normalized}";`;
  });
}

// function rewriteDefaultImports(source: string): string {
//   // 匹配 import xyz from "pkg" (排除 import { } 和 import * as)
//   const defaultImportPattern = 
//   /import\s+([A-Za-z_$][\w$]*)\s+from\s+["']([^"']+)["'];?/g;

//   return source.replace(defaultImportPattern, (full, localName, specifier) => {
//     // 1. 如果是相对路径 (./utils) 或者绝对路径，为了安全起见，通常不动它（或者你也想动也可以）
//     if (specifier.startsWith(".") || specifier.startsWith("/")) {
//        return full; 
//     }

//     // 2. 如果是 TypeBox 这种本来就必须要 import { Type } 的，或者框架包，跳过
//     // (可选：你可以保留 IGNORED_PACKAGE_NAMES 的过滤)
    
//     // 3. 生成一个中间层
//     // 把 import cheerio from "cheerio"
//     // 变成
//     // import * as __import_cheerio_ns from "cheerio";
//     // const cheerio = __import_cheerio_ns.default ?? __import_cheerio_ns;
    
//     const nsVar = `__ns_${localName}_${Math.random().toString(36).slice(2, 6)}`;
    
//     return `
// import * as ${nsVar} from "${specifier}";
// const ${localName} = ${nsVar}.default ?? ${nsVar};
// `.trim();
//   });
// }

function buildModuleSource(source: string): string {
  const trimmed = source.trim();

  if (/\bexport\s+default\b/.test(source)) {
    return source;
  }

  const exportedFunction = source.match(/\bexport\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/);
  if (exportedFunction?.[1]) {
    return `${source}\n\nexport default ${exportedFunction[1]}();\n`;
  }

  const exportedVar = source.match(/\bexport\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?:=|:)/);
  if (exportedVar?.[1]) {
    return `${source}\n\nexport default ${exportedVar[1]};\n`;
  }

  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return `
import { Type } from "@mariozechner/pi-ai";
const __tool = (
${source}
);
export default __tool;
`;
  }

  throw new Error("Invalid tool code format: LLM must provide 'export default' or a raw object expression.");
}

function normalizePackageName(specifier: string): string | null {
  if (!specifier) {
    return null;
  }
  if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("file:")) {
    return null;
  }
  if (specifier.startsWith("node:") || specifier.startsWith("bun:")) {
    return null;
  }

  const bareSpecifier = specifier.split("?")[0].split("#")[0];
  if (!bareSpecifier) {
    return null;
  }

  if (bareSpecifier.startsWith("@")) {
    const parts = bareSpecifier.split("/");
    if (parts.length < 2) {
      return bareSpecifier;
    }
    return `${parts[0]}/${parts[1]}`;
  }
  return bareSpecifier.split("/")[0];
}

function isIgnoredPackage(packageName: string): boolean {
  if (!packageName) {
    return true;
  }
  if (IGNORED_PACKAGE_NAMES.has(packageName)) {
    return true;
  }
  const plainName = packageName.replace(/^node:/, "");
  if (plainName === "node") {
    return true;
  }
  return BUILTIN_PLAIN_NAMES.has(plainName);
}

async function detectExternalDependencies(code: string): Promise<string[]> {
  const detected = new Set<string>();
  try {
    await ESM_LEXER_READY;
    const [imports] = parseEsm(code);
    for (const item of imports) {
      const specifier = (item.n ?? code.slice(item.s, item.e)).trim();
      if (!specifier) {
        continue;
      }
      const packageName = normalizePackageName(specifier);
      if (!packageName || isIgnoredPackage(packageName)) {
        continue;
      }
      detected.add(packageName);
    }
    return [...detected];
  } catch (error) {
    console.error("error", error);
    throw new Error(`Failed to detect external dependencies: ${toErrorMessage(error)}`);
  }
}

async function ensureDependencies(packageNames: string[], workDir: string): Promise<void> {
  if (packageNames.length === 0) {
    return;
  }
  console.log("packageNames", packageNames);
  await $`bun add ${packageNames.join(" ")}`.cwd(workDir).quiet();
  console.log("ensureDependencies done");
}

async function getManagedDependencyVersions(): Promise<Record<string, string>> {
  try {
    const raw = await readFile(EVOLUTE_MANAGED_DEPS_FILE, "utf8");
    const parsed = JSON.parse(raw) as { dependencies?: Record<string, string> };
    return parsed.dependencies ?? {};
  } catch {
    return {};
  }
}

async function writeDependencySnapshot(
  toolName: string,
  detectedPackageNames: string[]
): Promise<void> {
  const installedVersions = await getManagedDependencyVersions();
  const dependencies: Record<string, string> = {};
  for (const name of detectedPackageNames) {
    if (isIgnoredPackage(name)) {
      continue;
    }
    dependencies[name] = installedVersions[name] ?? "latest";
  }
  const outputPath = join(EVOLUTE_MODULE_DIR, `${toolName}.json`);
  const payload = JSON.stringify({ dependencies }, null, 2);
  await writeFile(outputPath, `${payload}\n`, "utf8");
}

export function createEvoluteTool(
  registerTool: (tool: AgentTool<any>) => Promise<void>
): AgentTool<any, EvoluteDetails> {
  return {
    name: "evolute",
    label: "Evolute tool",
    description:
      "Register a new tool at runtime from Typescript code (supports import/export module style).",
    parameters: Type.Object({
      code: Type.String({
        description:
          `
          🚨 **STRICT CODING STANDARDS (MANDATORY):**
          1. **Language:** You MUST write **Strict TypeScript**.
          2. **Type Safety & The \`any\` Keyword:**
            - **For Business Logic & API:** Usage of \`any\` is STRICTLY FORBIDDEN. You MUST define strict \`interface\` or \`type\` for all intermediate variables, API responses, and parsed JSON (e.g., \`interface GithubCommit { ... }\`).
            - **For Framework Signatures & Generics:** You are ALLOWED (and expected) to use \`any\` ONLY to satisfy base framework interfaces, complex generic parameters, or external library boundaries (e.g., \`AgentTool<any, any>\`). 
            - **Rule of thumb:** Never use \`unknown\` as a generic parameter if it breaks function signature compatibility. Use \`any\` for structural compatibility, but use strict types for your actual data payloads.
          3. **Imports:** - You MUST explicitly import all external dependencies using ESM syntax (e.g., \`import * as cheerio from 'cheerio';\`).
            - For standard Bun/Node built-ins, use \`node:\` prefix (e.g., \`import { join } from 'node:path';\`).
            - Even though \`fetch\` is global in Bun, prefer defining return types for it.
          4. **Structure:** - Your code MUST export a factory function that returns the tool object.
            - Keep the code self-contained in a single file.
          5. DON'T IMPORT ANYTHING TWICE (e.g. import type { AgentTool } from "@mariozechner/pi-ai" and import  from "@mariozechner/pi-ai" is not allowed).

          Typescript code for a tool. You can either provide:
          1) a module with imports + export default,
          2) an exported factory function, e.g. export function createXxxTool(){...},
          3) an object expression (Type is available as Type).
          
          Here is an example:
          \`\`\`ts
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
          \`\`\`
          
          The code will be evaluated in the context of the tool registry, so you can use the tools registered in the tool registry in the code.
          `,
      }),
    }),
    execute: async (_toolCallId, params) => {
      const dynamicTool = await compileToolFromCode(params.code);
      console.log("dynamicTool", dynamicTool);
      await registerTool(dynamicTool);
      return {
        content: [
          {
            type: "text",
            text: `✅ SUCCESS: Tool '${dynamicTool.name}' has been perfectly registered and is NOW AVAILABLE in your tool list! \n\n
            `,
          },
        ],
        details: {
          registeredToolName: dynamicTool.name,
        },
      };
    },
  };
}
