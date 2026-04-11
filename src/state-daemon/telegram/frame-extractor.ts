import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { gunzip } from "node:zlib";
import { promisify } from "node:util";
import sharp from "sharp";

const DEFAULT_MAX_FRAMES = 5;
const FRAME_FPS = 2;
const EMOJI_MAX_EDGE = 512;
const TGS_MIME_TYPE = "application/x-tgsticker";
const gunzipAsync = promisify(gunzip);

export interface Attachment {
  type: "sticker";
  isAnimatedSticker?: boolean;
  isVideoSticker?: boolean;
  mimeType?: string;
}

export interface ExtractFramesResult {
  frames: Buffer[];
  frameTimestamps?: number[];
}

export async function extractFrames(
  buffer: Buffer,
  attachment: Attachment,
  maxFrames = DEFAULT_MAX_FRAMES
): Promise<ExtractFramesResult> {
  const limit = Math.max(1, Math.floor(maxFrames));
  if (!attachment.isAnimatedSticker && !attachment.isVideoSticker) {
    const frame = await normalizeFrame(buffer);
    return { frames: [frame] };
  }

  const root = await mkdtemp(join(tmpdir(), "kairos-emoji-frames-"));
  const inputPath = join(root, `input${guessExtension(attachment.mimeType)}`);
  const lottieJsonPath = join(root, "input-lottie.json");
  const outputPattern = join(root, "frame-%03d.png");

  try {
    if (isTgsSticker(attachment.mimeType)) {
      const lottieJson = await tryInflateTgsToJson(buffer);
      if (lottieJson) {
        await writeFile(lottieJsonPath, lottieJson);
        try {
          await runFfmpeg([
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lottie",
            "-i",
            lottieJsonPath,
            "-vf",
            `fps=${FRAME_FPS}`,
            "-frames:v",
            String(limit),
            outputPattern,
          ]);
        } catch {
          await cleanupExtractedFrames(root);
          await writeFile(inputPath, buffer);
          await runFfmpeg([
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            inputPath,
            "-vf",
            `fps=${FRAME_FPS}`,
            "-frames:v",
            String(limit),
            outputPattern,
          ]);
        }
      } else {
        await writeFile(inputPath, buffer);
        await runFfmpeg([
          "-hide_banner",
          "-loglevel",
          "error",
          "-i",
          inputPath,
          "-vf",
          `fps=${FRAME_FPS}`,
          "-frames:v",
          String(limit),
          outputPattern,
        ]);
      }
    } else {
      await writeFile(inputPath, buffer);
      await runFfmpeg([
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        inputPath,
        "-vf",
        `fps=${FRAME_FPS}`,
        "-frames:v",
        String(limit),
        outputPattern,
      ]);
    }

    const files = await listExtractedFrames(root);

    const frames: Buffer[] = [];
    const timestamps: number[] = [];
    for (let i = 0; i < files.length; i += 1) {
      const raw = await readFile(join(root, files[i]));
      frames.push(await normalizeFrame(raw));
      timestamps.push(i / FRAME_FPS);
    }

    return {
      frames,
      frameTimestamps: timestamps,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export function deduplicateFrames(frames: Buffer[]): Buffer[] {
  const seen = new Set<string>();
  const unique: Buffer[] = [];
  for (const frame of frames) {
    const digest = createHash("sha1").update(frame).digest("hex");
    if (seen.has(digest)) {
      continue;
    }
    seen.add(digest);
    unique.push(frame);
  }
  return unique;
}

async function normalizeFrame(buffer: Buffer): Promise<Buffer> {
  return sharp(buffer)
    .resize(EMOJI_MAX_EDGE, EMOJI_MAX_EDGE, {
      fit: "inside",
      withoutEnlargement: true,
    })
    .png()
    .toBuffer();
}

function guessExtension(mimeType?: string): string {
  switch ((mimeType ?? "").toLowerCase()) {
    case "video/webm":
      return ".webm";
    case "video/mp4":
      return ".mp4";
    case "image/gif":
      return ".gif";
    case TGS_MIME_TYPE:
      return ".tgs";
    default:
      return ".bin";
  }
}

function isTgsSticker(mimeType?: string): boolean {
  return (mimeType ?? "").toLowerCase() === TGS_MIME_TYPE;
}

async function tryInflateTgsToJson(buffer: Buffer): Promise<Buffer | null> {
  try {
    const inflated = await gunzipAsync(buffer);
    const probe = inflated.toString("utf8", 0, Math.min(inflated.length, 256)).trimStart();
    if (!probe.startsWith("{")) {
      return null;
    }
    return inflated;
  } catch {
    return null;
  }
}

async function listExtractedFrames(root: string): Promise<string[]> {
  const files = (await readdir(root))
    .filter((name) => /^frame-\d+\.png$/.test(name))
    .sort();
  if (files.length === 0) {
    throw new Error("no frames extracted");
  }
  return files;
}

async function cleanupExtractedFrames(root: string): Promise<void> {
  const files = (await readdir(root)).filter((name) => /^frame-\d+\.png$/.test(name));
  await Promise.all(files.map((name) => rm(join(root, name), { force: true })));
}

async function runFfmpeg(args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("ffmpeg", args, {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      reject(error);
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(stderr || `ffmpeg exited with code ${code}`));
    });
  });
}
