import dotenv from "dotenv";
import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Volume } from "@wrangler/shared";

dotenv.config();

const execFileAsync = promisify(execFile);
const app = express();
const port = Number(process.env.HOST_HELPER_PORT ?? 4100);
const sourceRoot = path.resolve(process.env.SOURCE_ROOT ?? "/Volumes");

const seenVolumes = new Map<string, Volume>();
type DiskInfo = {
  deviceIdentifier: string | null;
  volumeUUID: string | null;
  fileSystemName: string | null;
  totalSize: number | null;
  removable: boolean | null;
  readOnly: boolean | null;
};

app.get("/health", (_request, response) => {
  response.json({ ok: true });
});

app.get("/volumes", async (_request, response, next) => {
  try {
    const volumes = await scanVolumes();
    response.json(volumes);
  } catch (error) {
    next(error);
  }
});

app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  response.status(500).json({ error: message });
});

app.listen(port, "0.0.0.0", () => {
  console.log(`Host helper listening on ${port}`);
});

async function scanVolumes(): Promise<Volume[]> {
  const entries = await fs.readdir(sourceRoot, { withFileTypes: true });
  const directories = entries.filter((entry) => entry.isDirectory());
  const nextVolumes: Volume[] = [];

  for (const entry of directories) {
    const mountPath = path.join(sourceRoot, entry.name);
    const info = await readDiskInfo(mountPath);
    const existing = seenVolumes.get(mountPath);
    const now = new Date().toISOString();
    const volume: Volume = {
      id: info.volumeUUID ?? entry.name,
      name: entry.name,
      mountPath,
      deviceIdentifier: info.deviceIdentifier ?? null,
      sizeBytes: info.totalSize ?? null,
      removable: info.removable ?? true,
      writable: !(info.readOnly ?? false),
      fileSystem: info.fileSystemName ?? null,
      insertedAt: existing?.insertedAt ?? now,
      lastSeenAt: now
    };

    seenVolumes.set(mountPath, volume);
    nextVolumes.push(volume);
  }

  for (const key of seenVolumes.keys()) {
    if (!nextVolumes.some((volume) => volume.mountPath === key)) {
      seenVolumes.delete(key);
    }
  }

  return nextVolumes.sort((left, right) => left.name.localeCompare(right.name));
}

async function readDiskInfo(mountPath: string): Promise<DiskInfo> {
  try {
    const { stdout } = await execFileAsync("diskutil", ["info", "-plist", mountPath]);
    return extractBasicInfo(stdout);
  } catch {
    return {
      deviceIdentifier: null,
      volumeUUID: null,
      fileSystemName: null,
      totalSize: null,
      removable: null,
      readOnly: null
    };
  }
}

function extractBasicInfo(plist: string): DiskInfo {
  return {
    deviceIdentifier: matchString(plist, "DeviceIdentifier"),
    volumeUUID: matchString(plist, "VolumeUUID"),
    fileSystemName: matchString(plist, "FilesystemName"),
    totalSize: matchInteger(plist, "TotalSize"),
    removable: matchBoolean(plist, "Removable"),
    readOnly: matchBoolean(plist, "ReadOnlyMedia")
  };
}

function matchString(plist: string, key: string): string | null {
  const match = plist.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]+)</string>`));
  return match ? match[1] : null;
}

function matchInteger(plist: string, key: string): number | null {
  const match = plist.match(new RegExp(`<key>${key}</key>\\s*<integer>(\\d+)</integer>`));
  return match ? Number(match[1]) : null;
}

function matchBoolean(plist: string, key: string): boolean | null {
  const trueMatch = plist.match(new RegExp(`<key>${key}</key>\\s*<true/>`));
  if (trueMatch) {
    return true;
  }

  const falseMatch = plist.match(new RegExp(`<key>${key}</key>\\s*<false/>`));
  if (falseMatch) {
    return false;
  }

  return null;
}
