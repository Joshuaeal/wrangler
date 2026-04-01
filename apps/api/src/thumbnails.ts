import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import sharp from "sharp";
import type { Volume } from "@wrangler/shared";
import { config } from "./config.js";
import { assertInsideRoot } from "./paths.js";

const imageExtensions = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
  ".tif",
  ".tiff",
  ".heic",
  ".heif",
  ".bmp"
]);

const videoExtensions = new Set([
  ".mp4",
  ".mov",
  ".m4v",
  ".avi",
  ".mkv",
  ".webm"
]);

export async function buildVolumeThumbnail(volume: Volume, relativePath: string, maxSize = 320): Promise<Buffer | null> {
  const root = assertInsideRoot(config.sourceRoot, volume.mountPath);
  const absolutePath = assertInsideRoot(root, path.join(root, relativePath));

  if (!canGenerateThumbnail(absolutePath)) {
    return null;
  }

  const stats = await fs.stat(absolutePath);
  if (!stats.isFile()) {
    return null;
  }

  if (isVideoFile(absolutePath)) {
    return buildVideoThumbnail(absolutePath, maxSize);
  }

  return sharp(absolutePath)
    .rotate()
    .resize(maxSize, maxSize, {
      fit: "inside",
      withoutEnlargement: true
    })
    .jpeg({ quality: 80 })
    .toBuffer();
}

export function canGenerateThumbnail(filePath: string): boolean {
  return isImageFile(filePath) || isVideoFile(filePath);
}

function isImageFile(filePath: string): boolean {
  return imageExtensions.has(path.extname(filePath).toLowerCase());
}

function isVideoFile(filePath: string): boolean {
  return videoExtensions.has(path.extname(filePath).toLowerCase());
}

async function buildVideoThumbnail(filePath: string, maxSize: number): Promise<Buffer> {
  const outputPath = path.join(
    os.tmpdir(),
    `wrangler-thumb-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`
  );

  try {
    await runFfmpeg([
      "-y",
      "-ss",
      "00:00:01",
      "-i",
      filePath,
      "-frames:v",
      "1",
      "-vf",
      `scale=${maxSize}:${maxSize}:force_original_aspect_ratio=decrease`,
      outputPath
    ]);

    return await fs.readFile(outputPath);
  } finally {
    await fs.rm(outputPath, { force: true }).catch(() => undefined);
  }
}

async function runFfmpeg(args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: "pipe" });
    let stderr = "";

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
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
