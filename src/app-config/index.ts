import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
const ENV_REF_PATTERN = /^\$\{ENV:([A-Za-z_][A-Za-z0-9_]*)(?::-(.*))?\}$/;

interface RuntimeConfig {
  runtimeRoot: string;
  protoRoot: string;
  memoryFilesRoot: string;
  evolutionsRoot: string;
}

interface EnclaveRuntimeConfig {
  runtime: RuntimeConfig;
  grpc: {
    bindAddr: string;
    protoPath: string;
  };
  llm: {
    apiKey: string;
    baseURL: string;
    model: string;
  };
  tools: {
    enabled: string;
  };
}

interface StateDaemonConfig {
  runtime: RuntimeConfig;
  grpc: {
    enclaveTarget: string;
    vfsTarget: string;
  };
  telegram: {
    botToken: string;
    ownerUserId: string;
  };
  triggers: {
    editedMessage: boolean;
    privateChat: boolean;
  };
  model: {
    llm: {
      ollama: {
        baseUrl: string;
        model: string;
      };
      cloud: {
        apiKey: string;
        baseURL: string;
        model: string;
      };
    };
    embedding: {
      provider: "ollama" | "native";
      ollamaBaseUrl: string;
      ollamaModel: string;
    };
  };
}

interface AppConfigFileShape {
  runtime?: Partial<RuntimeConfig>;
  enclaveRuntime?: Partial<Omit<EnclaveRuntimeConfig, "runtime">>;
  stateDaemon?: Partial<Omit<StateDaemonConfig, "runtime">>;
}

interface LoadOptions {
  configRoot?: string;
  profile?: string;
}

const CURRENT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(CURRENT_DIR, "../..");
const DEFAULT_CONFIG_ROOT = resolve(REPO_ROOT, ".runtime/appconfig");

function normalizePath(input: string, repoRoot: string): string {
  return isAbsolute(input) ? input : resolve(repoRoot, input);
}

function readJsonFile(path: string): AppConfigFileShape {
  try {
    const raw = readFileSync(path, "utf-8");
    return JSON.parse(raw) as AppConfigFileShape;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to load appconfig file: ${path}. ${reason}`);
  }
}

function isObject(value: unknown): value is Record<string, JsonValue> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function deepMerge<T>(base: T, patch: Partial<T>): T {
  const baseObj = base as unknown as Record<string, JsonValue>;
  const patchObj = patch as unknown as Record<string, JsonValue>;
  const merged: Record<string, JsonValue> = { ...baseObj };
  for (const key of Object.keys(patchObj)) {
    const nextValue = patchObj[key];
    if (nextValue === undefined) {
      continue;
    }
    const currentValue = merged[key];
    if (isObject(currentValue) && isObject(nextValue)) {
      merged[key] = deepMerge(currentValue, nextValue);
      continue;
    }
    merged[key] = nextValue;
  }
  return merged as unknown as T;
}

function requireObject(value: unknown, path: string): Record<string, JsonValue> {
  if (!isObject(value)) {
    throw new Error(`Missing required object at appconfig path "${path}".`);
  }
  return value;
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string") {
    throw new Error(`Missing required string at appconfig path "${path}".`);
  }
  return resolveEnvReference(value, path);
}

function resolveBoolean(value: unknown, path: string, fallback: boolean): boolean {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const resolved = resolveEnvReference(value, path).toLowerCase();
    if (resolved === "true" || resolved === "1") return true;
    if (resolved === "false" || resolved === "0") return false;
  }
  return fallback;
}

function resolveEnvReference(raw: string, path: string): string {
  const trimmed = raw.trim();
  const matched = ENV_REF_PATTERN.exec(trimmed);
  if (!matched) {
    return raw;
  }

  const envName = matched[1];
  const fallback = matched[2];
  const envValue = process.env[envName];
  if (envValue !== undefined && envValue !== "") {
    return envValue;
  }

  if (fallback !== undefined) {
    return fallback;
  }

  throw new Error(
    `Missing required environment variable "${envName}" referenced by appconfig path "${path}".`,
  );
}

function buildRuntimeConfig(patch: Partial<RuntimeConfig> | undefined): RuntimeConfig {
  const runtimeObj = requireObject(patch, "runtime");
  const runtimeRoot = requireString(runtimeObj.runtimeRoot, "runtime.runtimeRoot");
  const protoRoot = requireString(runtimeObj.protoRoot, "runtime.protoRoot");
  const memoryFilesRoot = requireString(runtimeObj.memoryFilesRoot, "runtime.memoryFilesRoot");
  const evolutionsRoot = requireString(runtimeObj.evolutionsRoot, "runtime.evolutionsRoot");
  return {
    runtimeRoot: normalizePath(runtimeRoot, REPO_ROOT),
    protoRoot: normalizePath(protoRoot, REPO_ROOT),
    memoryFilesRoot: normalizePath(memoryFilesRoot, REPO_ROOT),
    evolutionsRoot: normalizePath(evolutionsRoot, REPO_ROOT),
  };
}

function loadConfigFiles(options: LoadOptions): AppConfigFileShape {
  const configRoot = normalizePath(options.configRoot ?? process.env.APPCONFIG_ROOT ?? DEFAULT_CONFIG_ROOT, REPO_ROOT);
  const profile = options.profile ?? process.env.APPCONFIG_PROFILE ?? "local";
  const base = readJsonFile(resolve(configRoot, "base.json"));
  const profilePatch = readJsonFile(resolve(configRoot, "profiles", `${profile}.json`));
  return deepMerge(base, profilePatch);
}

export function loadEnclaveRuntimeConfig(options: LoadOptions = {}): EnclaveRuntimeConfig {
  const mergedFileConfig = loadConfigFiles(options);
  const runtime = buildRuntimeConfig(mergedFileConfig.runtime);
  const enclaveConfig = requireObject(mergedFileConfig.enclaveRuntime, "enclaveRuntime");
  const grpcConfig = requireObject(enclaveConfig.grpc, "enclaveRuntime.grpc");
  const llmConfig = requireObject(enclaveConfig.llm, "enclaveRuntime.llm");
  const toolsConfig = requireObject(enclaveConfig.tools, "enclaveRuntime.tools");

  const bindAddr = process.env.AGENT_ENCLAVE_BIND_ADDR ?? requireString(grpcConfig.bindAddr, "enclaveRuntime.grpc.bindAddr");
  const protoPathRaw = requireString(grpcConfig.protoPath, "enclaveRuntime.grpc.protoPath");
  const apiKey =
    process.env.API_KEY ??
    process.env.QWEN_API_KEY ??
    requireString(llmConfig.apiKey, "enclaveRuntime.llm.apiKey");
  const baseURL = process.env.BASE_URL ?? requireString(llmConfig.baseURL, "enclaveRuntime.llm.baseURL");
  const model = process.env.MODEL ?? requireString(llmConfig.model, "enclaveRuntime.llm.model");
  const enabledTools = process.env.ENABLED_TOOLS ?? requireString(toolsConfig.enabled, "enclaveRuntime.tools.enabled");

  if (process.env.MEMORY_FILES_ROOT) {
    runtime.memoryFilesRoot = normalizePath(process.env.MEMORY_FILES_ROOT, REPO_ROOT);
  }
  if (process.env.EVOLUTIONS_ROOT) {
    runtime.evolutionsRoot = normalizePath(process.env.EVOLUTIONS_ROOT, REPO_ROOT);
  }

  return {
    runtime,
    grpc: {
      bindAddr,
      protoPath: normalizePath(protoPathRaw, REPO_ROOT),
    },
    llm: {
      apiKey,
      baseURL,
      model,
    },
    tools: {
      enabled: enabledTools,
    },
  };
}

export function loadStateDaemonConfig(options: LoadOptions = {}): StateDaemonConfig {
  const mergedFileConfig = loadConfigFiles(options);
  const runtime = buildRuntimeConfig(mergedFileConfig.runtime);
  const stateConfig = requireObject(mergedFileConfig.stateDaemon, "stateDaemon");
  const grpcConfig = requireObject(stateConfig.grpc, "stateDaemon.grpc");
  const telegramConfig = requireObject(stateConfig.telegram, "stateDaemon.telegram");
  const triggersConfig = isObject(stateConfig.triggers) ? stateConfig.triggers : {};
  const modelConfig = requireObject(stateConfig.model, "stateDaemon.model");
  const llmConfig = requireObject(modelConfig.llm, "stateDaemon.model.llm");
  const llmOllamaConfig = requireObject(llmConfig.ollama, "stateDaemon.model.llm.ollama");
  const llmCloudConfig = requireObject(llmConfig.cloud, "stateDaemon.model.llm.cloud");
  const embeddingConfig = requireObject(modelConfig.embedding, "stateDaemon.model.embedding");

  const enclaveTarget =
    process.env.AGENT_ENCLAVE_TARGET ??
    requireString(grpcConfig.enclaveTarget, "stateDaemon.grpc.enclaveTarget");
  const vfsTarget = process.env.MEMORY_VFS_TARGET ?? requireString(grpcConfig.vfsTarget, "stateDaemon.grpc.vfsTarget");
  const botToken = process.env.BOT_TOKEN ?? requireString(telegramConfig.botToken, "stateDaemon.telegram.botToken");
  const ownerUserId =
    process.env.OWNER_USER_ID ?? requireString(telegramConfig.ownerUserId, "stateDaemon.telegram.ownerUserId");
  const llmOllamaBaseUrl =
    process.env.OLLAMA_BASE_URL ??
    requireString(llmOllamaConfig.baseUrl, "stateDaemon.model.llm.ollama.baseUrl");
  const llmOllamaModel =
    process.env.OLLAMA_SESSION_MODEL ??
    requireString(llmOllamaConfig.model, "stateDaemon.model.llm.ollama.model");
  const llmCloudApiKey =
    process.env.STATE_DAEMON_CLOUD_API_KEY ??
    process.env.ARK_API_KEY ??
    process.env.API_KEY ??
    requireString(llmCloudConfig.apiKey, "stateDaemon.model.llm.cloud.apiKey");
  const llmCloudBaseURL =
    process.env.STATE_DAEMON_CLOUD_BASE_URL ??
    requireString(llmCloudConfig.baseURL, "stateDaemon.model.llm.cloud.baseURL");
  const llmCloudModel =
    process.env.STATE_DAEMON_CLOUD_MODEL ??
    requireString(llmCloudConfig.model, "stateDaemon.model.llm.cloud.model");
  const embeddingProvider = (
    process.env.EMBED_PROVIDER ??
    requireString(embeddingConfig.provider, "stateDaemon.model.embedding.provider")
  ).toLowerCase();
  if (embeddingProvider !== "ollama" && embeddingProvider !== "native") {
    throw new Error(
      `Invalid stateDaemon.model.embedding.provider: ${embeddingProvider}. Expected "ollama" or "native".`,
    );
  }
  const embeddingOllamaBaseUrl =
    process.env.OLLAMA_BASE_URL ??
    requireString(embeddingConfig.ollamaBaseUrl, "stateDaemon.model.embedding.ollamaBaseUrl");
  const embeddingOllamaModel =
    process.env.OLLAMA_EMBED_MODEL ??
    requireString(embeddingConfig.ollamaModel, "stateDaemon.model.embedding.ollamaModel");

  if (process.env.MEMORY_FILES_ROOT) {
    runtime.memoryFilesRoot = normalizePath(process.env.MEMORY_FILES_ROOT, REPO_ROOT);
  }

  return {
    runtime,
    grpc: {
      enclaveTarget,
      vfsTarget,
    },
    telegram: {
      botToken,
      ownerUserId,
    },
    triggers: {
      editedMessage: resolveBoolean(triggersConfig.editedMessage, "stateDaemon.triggers.editedMessage", true),
      privateChat: resolveBoolean(triggersConfig.privateChat, "stateDaemon.triggers.privateChat", true),
    },
    model: {
      llm: {
        ollama: {
          baseUrl: llmOllamaBaseUrl,
          model: llmOllamaModel,
        },
        cloud: {
          apiKey: llmCloudApiKey,
          baseURL: llmCloudBaseURL,
          model: llmCloudModel,
        },
      },
      embedding: {
        provider: embeddingProvider,
        ollamaBaseUrl: embeddingOllamaBaseUrl,
        ollamaModel: embeddingOllamaModel,
      },
    },
  };
}
