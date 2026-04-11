import sharp from "sharp";
import { renderCustomEmojiToTextSystemPrompt } from "./custom-emoji-to-text-prompt";
import { deduplicateFrames, extractFrames, type Attachment } from "./frame-extractor";
import type { ImageAltTextRecord } from "./image-to-text-store";
import { callDescriptionLlm, createSemaphore, type LlmEndpoint } from "./llm-description";

const EMOJI_MAX_EDGE = 512;
const BOT_API_CUSTOM_EMOJI_BATCH_LIMIT = 200;

export interface CustomEmojiToTextResolver {
  resolve(emojiIds: Map<string, string>): Promise<void>;
  getError(customEmojiId: string): string | undefined;
  getPackName(customEmojiId: string): string | undefined;
  getAltText(customEmojiId: string): string | undefined;
}

const emojiCacheKey = (customEmojiId: string): string => `emoji:${customEmojiId}`;

const prepareStaticImageUrl = async (buffer: Buffer): Promise<string> => {
  const resized = await sharp(buffer)
    .resize(EMOJI_MAX_EDGE, EMOJI_MAX_EDGE, {
      fit: "inside",
      withoutEnlargement: true,
    })
    .png()
    .toBuffer();
  return `data:image/png;base64,${resized.toString("base64")}`;
};

export function createCustomEmojiToTextResolver(params: {
  enabled: boolean;
  model?: LlmEndpoint;
  maxConcurrency?: number;
  maxFrames?: number;
  lookupByHash: (hash: string) => ImageAltTextRecord | null;
  persist: (record: ImageAltTextRecord) => void;
  getCustomEmojiStickers: (customEmojiIds: string[]) => Promise<Array<{
    id: string;
    file_id: string;
    is_animated: boolean;
    is_video: boolean;
    mime_type?: string;
    set_name?: string;
  }>>;
  downloadFile: (fileId: string) => Promise<Buffer>;
  resolvePackTitle: (setName: string) => Promise<string | undefined>;
}): CustomEmojiToTextResolver {
  const semaphore = createSemaphore(params.maxConcurrency ?? 3);
  const inflightByKey = new Map<string, Promise<void>>();
  const errors = new Map<string, string>();
  const packNames = new Map<string, string>();

  const resolveOne = (
    customEmojiId: string,
    fallbackEmoji: string,
    sticker: {
      file_id: string;
      is_animated: boolean;
      is_video: boolean;
      mime_type?: string;
      set_name?: string;
    }
  ): Promise<void> => {
    const cacheKey = emojiCacheKey(customEmojiId);

    const existing = inflightByKey.get(cacheKey);
    if (existing) {
      return existing;
    }

    const task = (async () => {
      const cached = params.lookupByHash(cacheKey);
      if (cached) {
        if (cached.stickerSetName) {
          packNames.set(customEmojiId, cached.stickerSetName);
        }
        errors.delete(customEmojiId);
        return;
      }

      await semaphore.acquire();
      try {
        const recheck = params.lookupByHash(cacheKey);
        if (recheck) {
          if (recheck.stickerSetName) {
            packNames.set(customEmojiId, recheck.stickerSetName);
          }
          errors.delete(customEmojiId);
          return;
        }

        const model = params.model;
        if (!model) {
          throw new Error("customEmojiToText.model is required when customEmojiToText.enabled=true");
        }

        const buffer = await params.downloadFile(sticker.file_id);
        let isAnimated = sticker.is_animated || sticker.is_video;
        const packTitle = sticker.set_name
          ? await params.resolvePackTitle(sticker.set_name)
          : undefined;
        if (packTitle) {
          packNames.set(customEmojiId, packTitle);
        } else if (sticker.set_name) {
          packNames.set(customEmojiId, sticker.set_name);
        }

        let images: Array<{ url: string }>;
        let frameCount: number | undefined;
        let timestamps: string | undefined;

        if (isAnimated) {
          const syntheticAtt: Attachment = {
            type: "sticker",
            isAnimatedSticker: sticker.is_animated,
            isVideoSticker: sticker.is_video,
            mimeType: sticker.mime_type,
          };
          const extractionResult = await extractFrames(buffer, syntheticAtt, params.maxFrames);
          const uniqueFrames = deduplicateFrames(extractionResult.frames);
          if (uniqueFrames.length === 1) {
            isAnimated = false;
          }
          images = uniqueFrames.map((buf) => ({
            url: `data:image/png;base64,${buf.toString("base64")}`,
          }));
          frameCount = uniqueFrames.length;
          timestamps = extractionResult.frameTimestamps
            ? extractionResult.frameTimestamps.map((t) => `${t.toFixed(1)}s`).join(", ")
            : undefined;
        } else {
          const url = await prepareStaticImageUrl(buffer);
          images = [{ url }];
        }

        const system = renderCustomEmojiToTextSystemPrompt({
          fallbackEmoji,
          stickerSetName: packTitle ?? sticker.set_name,
          isAnimated,
          frameCount,
          frameTimestamps: timestamps,
        });

        const result = await callDescriptionLlm({
          model,
          system,
          userText: "Describe this custom emoji.",
          images,
          label: "custom-emoji-to-text",
        });
        const altText = result.text.trim();
        if (!altText) {
          throw new Error("Custom-emoji-to-text model returned empty alt text");
        }

        params.persist({
          imageHash: cacheKey,
          altText,
          altTextTokens: result.outputTokens,
          ...(packTitle ?? sticker.set_name ? { stickerSetName: packTitle ?? sticker.set_name } : {}),
        });
        errors.delete(customEmojiId);
      } finally {
        semaphore.release();
      }
    })();

    inflightByKey.set(cacheKey, task);
    void task.finally(() => inflightByKey.delete(cacheKey));
    return task;
  };

  return {
    async resolve(emojiIds) {
      if (!params.enabled || emojiIds.size === 0) {
        return;
      }

      const uncached = new Map<string, string>();
      for (const [id, fallback] of emojiIds) {
        const cached = params.lookupByHash(emojiCacheKey(id));
        if (cached) {
          if (cached.stickerSetName) {
            packNames.set(id, cached.stickerSetName);
          }
          continue;
        }
        uncached.set(id, fallback);
      }
      if (uncached.size === 0) {
        return;
      }

      const ids = [...uncached.keys()];
      const stickers: Array<{
        id: string;
        file_id: string;
        is_animated: boolean;
        is_video: boolean;
        mime_type?: string;
        set_name?: string;
      }> = [];
      const batches = chunkBy(ids, BOT_API_CUSTOM_EMOJI_BATCH_LIMIT);
      for (const batch of batches) {
        try {
          const batchStickers = await params.getCustomEmojiStickers(batch);
          stickers.push(...batchStickers);
        } catch (err) {
          for (const id of batch) {
            errors.set(id, err instanceof Error ? err.message : String(err));
          }
        }
      }
      if (stickers.length === 0) {
        return;
      }

      const stickerMap = new Map<string, typeof stickers[0]>();
      for (const sticker of stickers) {
        stickerMap.set(sticker.id, sticker);
      }

      const tasks: Promise<void>[] = [];
      for (const [id, fallback] of uncached) {
        const sticker = stickerMap.get(id);
        if (!sticker) {
          errors.set(id, "sticker not found");
          continue;
        }
        tasks.push(
          resolveOne(id, fallback, sticker).catch((err) => {
            errors.set(id, err instanceof Error ? err.message : String(err));
          })
        );
      }
      await Promise.all(tasks);
    },

    getError(customEmojiId) {
      return errors.get(customEmojiId);
    },

    getPackName(customEmojiId) {
      return packNames.get(customEmojiId);
    },

    getAltText(customEmojiId) {
      return params.lookupByHash(emojiCacheKey(customEmojiId))?.altText;
    },
  };
}

function chunkBy<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  const safeSize = Math.max(1, Math.floor(size));
  for (let i = 0; i < items.length; i += safeSize) {
    chunks.push(items.slice(i, i + safeSize));
  }
  return chunks;
}

export { emojiCacheKey };
