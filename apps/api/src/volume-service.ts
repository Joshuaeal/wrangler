import fs from "node:fs/promises";
import path from "node:path";
import type { FileEntry, Volume } from "@wrangler/shared";
import { config } from "./config.js";
import { assertInsideRoot } from "./paths.js";

const ignoredVolumeEntries = new Set([
  ".DocumentRevisions-V100",
  ".Spotlight-V100",
  ".Trashes",
  ".TemporaryItems",
  ".fseventsd"
]);

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<T>;
}

export async function listVolumes(): Promise<Volume[]> {
  try {
    return await fetchJson<Volume[]>(`${config.hostHelperUrl}/volumes`);
  } catch {
    const names = await fs.readdir(config.sourceRoot);
    const now = new Date().toISOString();
    return names.map((name) => ({
      id: name,
      name,
      mountPath: path.join(config.sourceRoot, name),
      deviceIdentifier: null,
      sizeBytes: null,
      removable: true,
      writable: false,
      fileSystem: null,
      insertedAt: now,
      lastSeenAt: now
    }));
  }
}

export async function getVolumeOrThrow(volumeId: string): Promise<Volume> {
  const volume = (await listVolumes()).find((entry) => entry.id === volumeId);
  if (!volume) {
    throw new Error(`Volume not found: ${volumeId}`);
  }
  return volume;
}

export async function listVolumeFiles(volume: Volume, relativePath = "."): Promise<FileEntry[]> {
  const root = assertInsideRoot(config.sourceRoot, volume.mountPath);
  const directory = assertInsideRoot(root, path.join(root, relativePath));
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const results = await Promise.all(entries.map(async (entry) => {
    if (shouldIgnoreEntry(entry.name)) {
      return null;
    }

    const absolutePath = path.join(directory, entry.name);

    try {
      const stats = await fs.stat(absolutePath);
      return {
        path: absolutePath,
        relativePath: path.relative(root, absolutePath) || ".",
        kind: entry.isDirectory() ? "directory" : "file",
        size: entry.isDirectory() ? 0 : stats.size,
        modifiedAt: stats.mtime.toISOString()
      } satisfies FileEntry;
    } catch (error) {
      if (isIgnorableFsError(error)) {
        return null;
      }
      throw error;
    }
  }));

  return results
    .filter((entry): entry is FileEntry => entry !== null)
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

export async function listManyVolumeFiles(volumeIds: string[]): Promise<Array<{ volume: Volume; files: FileEntry[] }>> {
  const volumes = await Promise.all(volumeIds.map((volumeId) => getVolumeOrThrow(volumeId)));
  return Promise.all(
    volumes.map(async (volume) => ({
      volume,
      files: await listVolumeFiles(volume)
    }))
  );
}

function shouldIgnoreEntry(name: string): boolean {
  return ignoredVolumeEntries.has(name);
}

function isIgnorableFsError(error: unknown): boolean {
  return error instanceof Error && "code" in error && (
    error.code === "ENOENT" ||
    error.code === "EPERM" ||
    error.code === "EACCES"
  );
}
