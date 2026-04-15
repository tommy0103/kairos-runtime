import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@mariozechner/pi-ai";
import { stat } from "node:fs/promises";
import { extname, isAbsolute } from "node:path";

const MAX_ITEMS = 20;
const MAX_SOURCE_CHARS = 2048;
const MAX_CAPTION_CHARS = 1024;
const MAX_FILENAME_CHARS = 128;
const MAX_MIME_CHARS = 120;
const MAX_LOCAL_FILE_BYTES = 100 * 1024 * 1024;

type MediaType = "image" | "audio" | "file";

interface SendFileItemDetails {
  source: string;
  type: MediaType;
  mimeType?: string;
  fileName?: string;
}

interface SendFileDetails {
  items: SendFileItemDetails[];
  caption?: string;
  replyTo?: string;
  awaitResponse: boolean;
}

interface SendFileParams {
  items: Array<{
    source: string;
    type?: string;
    mime_type?: string;
    file_name?: string;
  }>;
  caption?: string;
  reply_to?: string | number;
  await_response?: boolean;
}

const IMAGE_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
  ".bmp",
  ".tif",
  ".tiff",
]);

const AUDIO_EXTENSIONS = new Set([
  ".mp3",
  ".m4a",
  ".aac",
  ".wav",
  ".ogg",
  ".opus",
  ".flac",
]);

function normalizeReplyTo(input: unknown): string | undefined {
  if (typeof input === "number" && Number.isFinite(input)) {
    return String(Math.trunc(input));
  }
  if (typeof input === "string") {
    const normalized = input.trim();
    return normalized.length > 0 ? normalized : undefined;
  }
  return undefined;
}

function normalizeCaption(input: unknown): string | undefined {
  if (typeof input !== "string") {
    return undefined;
  }
  const normalized = input.trim();
  if (!normalized) {
    return undefined;
  }
  if (normalized.length > MAX_CAPTION_CHARS) {
    throw new Error(`send_file.caption too long. Max ${MAX_CAPTION_CHARS} chars.`);
  }
  return normalized;
}

function normalizeMimeType(input: unknown): string | undefined {
  if (typeof input !== "string") {
    return undefined;
  }
  const normalized = input.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized.length > MAX_MIME_CHARS) {
    throw new Error(`send_file.items[].mime_type too long. Max ${MAX_MIME_CHARS} chars.`);
  }
  return normalized;
}

function normalizeFileName(input: unknown): string | undefined {
  if (typeof input !== "string") {
    return undefined;
  }
  const normalized = input.trim();
  if (!normalized) {
    return undefined;
  }
  if (normalized.length > MAX_FILENAME_CHARS) {
    throw new Error(`send_file.items[].file_name too long. Max ${MAX_FILENAME_CHARS} chars.`);
  }
  return normalized;
}

function parseMediaType(input: unknown): MediaType | undefined {
  if (typeof input !== "string") {
    return undefined;
  }
  const normalized = input.trim().toLowerCase();
  if (normalized === "image" || normalized === "audio" || normalized === "file") {
    return normalized;
  }
  throw new Error("send_file.items[].type must be one of: image, audio, file.");
}

function isHttpUrl(source: string): boolean {
  try {
    const parsed = new URL(source);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function isFileUrl(source: string): boolean {
  try {
    const parsed = new URL(source);
    return parsed.protocol === "file:";
  } catch {
    return false;
  }
}

function toLocalPath(source: string): string {
  if (isFileUrl(source)) {
    const parsed = new URL(source);
    return decodeURIComponent(parsed.pathname);
  }
  return source;
}

function getSourceExtension(source: string): string {
  if (isHttpUrl(source) || isFileUrl(source)) {
    try {
      const parsed = new URL(source);
      return extname(parsed.pathname).toLowerCase();
    } catch {
      return "";
    }
  }
  return extname(source).toLowerCase();
}

function inferMediaType(source: string, mimeType?: string): MediaType {
  if (mimeType?.startsWith("image/")) {
    return "image";
  }
  if (mimeType?.startsWith("audio/")) {
    return "audio";
  }

  const extension = getSourceExtension(source);
  if (IMAGE_EXTENSIONS.has(extension)) {
    return "image";
  }
  if (AUDIO_EXTENSIONS.has(extension)) {
    return "audio";
  }
  return "file";
}

async function validateSource(source: string): Promise<void> {
  if (isHttpUrl(source)) {
    return;
  }

  const localPath = toLocalPath(source);
  if (!isAbsolute(localPath)) {
    throw new Error(
      "send_file.items[].source must be an absolute local path, file:// URL, or http(s) URL."
    );
  }

  const fileStat = await stat(localPath);
  if (!fileStat.isFile()) {
    throw new Error(`send_file source is not a file: ${localPath}`);
  }
  if (fileStat.size > MAX_LOCAL_FILE_BYTES) {
    throw new Error(
      `send_file source too large: ${localPath}. Max ${MAX_LOCAL_FILE_BYTES} bytes.`
    );
  }
}

export function createSendFileTool(): AgentTool<any, SendFileDetails> {
  return {
    name: "send_file",
    label: "Send file",
    description:
      "Send image/audio/file media to the user. Supports multiple items in one call.",
    parameters: Type.Object({
      items: Type.Array(
        Type.Object({
          source: Type.String({
            description:
              "Absolute local path, file:// URL, or http(s) URL pointing to the media.",
          }),
          type: Type.Optional(
            Type.Union(
              [Type.Literal("image"), Type.Literal("audio"), Type.Literal("file")],
              {
                description:
                  "Optional explicit type. If omitted, the runtime infers it from mime/ext.",
              }
            )
          ),
          mime_type: Type.Optional(
            Type.String({
              description: "Optional MIME type hint (e.g. image/png, audio/mpeg).",
            })
          ),
          file_name: Type.Optional(
            Type.String({
              description: "Optional filename hint when uploading local files.",
            })
          ),
        }),
        {
          minItems: 1,
          maxItems: MAX_ITEMS,
          description: "Media items to send in order.",
        }
      ),
      caption: Type.Optional(
        Type.String({
          description:
            "Optional group-level caption. When multiple groups are sent, caption is applied to the first group.",
        })
      ),
      reply_to: Type.Optional(
        Type.Union(
          [Type.String(), Type.Number()],
          { description: "Optional message id to reply to." }
        )
      ),
      await_response: Type.Optional(
        Type.Boolean({
          description:
            "Set true if you will continue with additional tool calls after sending.",
        })
      ),
    }),
    execute: async (_toolCallId, params: SendFileParams) => {
      if (!Array.isArray(params.items) || params.items.length === 0) {
        throw new Error("send_file.items cannot be empty.");
      }
      if (params.items.length > MAX_ITEMS) {
        throw new Error(`send_file.items too many. Max ${MAX_ITEMS}.`);
      }

      const normalizedItems: SendFileItemDetails[] = [];
      for (const item of params.items) {
        const source = typeof item?.source === "string" ? item.source.trim() : "";
        if (!source) {
          throw new Error("send_file.items[].source cannot be empty.");
        }
        if (source.length > MAX_SOURCE_CHARS) {
          throw new Error(
            `send_file.items[].source too long. Max ${MAX_SOURCE_CHARS} chars.`
          );
        }
        await validateSource(source);

        const mimeType = normalizeMimeType(item.mime_type);
        const explicitType = parseMediaType(item.type);
        const resolvedType = explicitType ?? inferMediaType(source, mimeType);
        const fileName = normalizeFileName(item.file_name);

        normalizedItems.push({
          source,
          type: resolvedType,
          mimeType,
          fileName,
        });
      }

      const caption = normalizeCaption(params.caption);
      const replyTo = normalizeReplyTo(params.reply_to);
      const awaitResponse = params.await_response === true;

      return {
        content: [
          {
            type: "text",
            text: `Queued media batch (${normalizedItems.length} item${normalizedItems.length === 1 ? "" : "s"}).`,
          },
        ],
        details: {
          items: normalizedItems,
          caption,
          replyTo,
          awaitResponse,
        },
      };
    },
  };
}
