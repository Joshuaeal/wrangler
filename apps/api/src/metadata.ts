import path from "node:path";
import { spawn } from "node:child_process";
import type { Volume } from "@wrangler/shared";
import { config } from "./config.js";
import { assertInsideRoot } from "./paths.js";

export type SourceMetadata = {
  fileName: string;
  relativePath: string;
  fileType: string | null;
  mimeType: string | null;
  cameraMake: string | null;
  cameraModel: string | null;
  lensModel: string | null;
  reelName: string | null;
  clipName: string | null;
  timecode: string | null;
  createdAt: string | null;
  durationSeconds: number | null;
  frameRate: number | null;
  resolution: string | null;
  videoCodec: string | null;
  audioCodec: string | null;
  audioChannels: number | null;
  sampleRate: number | null;
  colorSpace: string | null;
  gamma: string | null;
  iso: number | null;
  shutterSpeed: string | null;
  whiteBalance: string | null;
  aperture: string | null;
  raw: Record<string, string | number | null>;
};

export async function readVolumeMetadata(volume: Volume, relativePath: string): Promise<SourceMetadata> {
  const root = assertInsideRoot(config.sourceRoot, volume.mountPath);
  const absolutePath = assertInsideRoot(root, path.join(root, relativePath));
  const [exif, ffprobe] = await Promise.all([
    runExiftool(absolutePath),
    runFfprobe(absolutePath)
  ]);

  const videoStream = ffprobe.streams.find((stream) => stream.codec_type === "video");
  const audioStream = ffprobe.streams.find((stream) => stream.codec_type === "audio");

  return {
    fileName: path.basename(relativePath),
    relativePath,
    fileType: pickString(exif, ["FileType", "FileTypeExtension"]),
    mimeType: pickString(exif, ["MIMEType"]),
    cameraMake: pickString(exif, ["Make", "CameraMake"]),
    cameraModel: pickString(exif, ["Model", "CameraModelName", "CameraModel"]),
    lensModel: pickString(exif, ["LensModel", "LensType"]),
    reelName: pickString(exif, ["ReelName", "TapeName"]),
    clipName: pickString(exif, ["ClipName", "SourceFile"]),
    timecode: pickString(exif, ["TimeCode", "StartTimecode", "MediaCreateDate"]),
    createdAt: pickString(exif, ["CreateDate", "MediaCreateDate", "DateTimeOriginal"]),
    durationSeconds: pickNumber(exif, ["Duration#"]) ?? pickDurationFromFfprobe(ffprobe.format.duration),
    frameRate: pickFrameRate(videoStream?.avg_frame_rate) ?? pickFrameRate(videoStream?.r_frame_rate),
    resolution: videoStream?.width && videoStream?.height ? `${videoStream.width}x${videoStream.height}` : null,
    videoCodec: videoStream?.codec_name ?? null,
    audioCodec: audioStream?.codec_name ?? null,
    audioChannels: audioStream?.channels ?? null,
    sampleRate: audioStream?.sample_rate ? Number(audioStream.sample_rate) : null,
    colorSpace: pickString(exif, ["ColorSpace", "ColorRepresentation"]) ?? videoStream?.color_space ?? null,
    gamma: pickString(exif, ["Gamma", "TransferCharacteristic"]),
    iso: pickNumber(exif, ["ISO", "ISOSetting"]),
    shutterSpeed: pickString(exif, ["ShutterSpeed", "ShutterAngle"]),
    whiteBalance: pickString(exif, ["WhiteBalance", "WhiteBalanceFineTune"]),
    aperture: pickString(exif, ["Aperture", "FNumber"]),
    raw: buildWranglerMetadata(exif)
  };
}

async function runExiftool(filePath: string): Promise<Record<string, unknown>> {
  const output = await runCommand("exiftool", ["-j", "-n", filePath]);
  const parsed = JSON.parse(output) as Array<Record<string, unknown>>;
  return parsed[0] ?? {};
}

async function runFfprobe(filePath: string): Promise<{
  format: { duration?: string };
  streams: Array<{
    codec_type?: string;
    codec_name?: string;
    avg_frame_rate?: string;
    r_frame_rate?: string;
    width?: number;
    height?: number;
    channels?: number;
    sample_rate?: string;
    color_space?: string;
  }>;
}> {
  const output = await runCommand("ffprobe", [
    "-v",
    "quiet",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    filePath
  ]);
  return JSON.parse(output) as {
    format: { duration?: string };
    streams: Array<{
      codec_type?: string;
      codec_name?: string;
      avg_frame_rate?: string;
      r_frame_rate?: string;
      width?: number;
      height?: number;
      channels?: number;
      sample_rate?: string;
      color_space?: string;
    }>;
  };
}

async function runCommand(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "pipe" });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }

      reject(new Error(stderr || `${command} exited with code ${code}`));
    });
  });
}

function pickString(input: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function pickNumber(input: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return null;
}

function pickDurationFromFfprobe(duration: string | undefined): number | null {
  if (!duration) {
    return null;
  }
  const parsed = Number(duration);
  return Number.isFinite(parsed) ? parsed : null;
}

function pickFrameRate(frameRate: string | undefined): number | null {
  if (!frameRate || frameRate === "0/0") {
    return null;
  }
  const [numerator, denominator] = frameRate.split("/").map(Number);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
    return null;
  }
  return numerator / denominator;
}

function buildWranglerMetadata(input: Record<string, unknown>): Record<string, string | number | null> {
  const keys = [
    "Make",
    "Model",
    "LensModel",
    "ReelName",
    "ClipName",
    "TimeCode",
    "CreateDate",
    "MediaCreateDate",
    "ColorSpace",
    "Gamma",
    "ISO",
    "ShutterSpeed",
    "WhiteBalance",
    "Aperture"
  ];

  return Object.fromEntries(
    keys.map((key) => {
      const value = input[key];
      return [key, typeof value === "string" || typeof value === "number" ? value : null];
    })
  );
}
