import fsp from "node:fs/promises";
import path from "node:path";
import type { BrowserRoot, FileEntry } from "@wrangler/shared";
import { getDestinationSettings } from "./destination-settings.js";
import { assertInsideRoot } from "./paths.js";

export async function listManagedFiles(rootKey: BrowserRoot, projectSlug: string, relativePath = "."): Promise<FileEntry[]> {
  const rootPath = getManagedRoot(rootKey, projectSlug);
  await fsp.mkdir(rootPath, { recursive: true });
  const directory = assertInsideRoot(rootPath, path.join(rootPath, relativePath));
  await fsp.mkdir(directory, { recursive: true });
  const entries = await fsp.readdir(directory, { withFileTypes: true });

  const results = await Promise.all(
    entries.map(async (entry) => {
      const absolutePath = path.join(directory, entry.name);
      const stats = await fsp.stat(absolutePath);
      return {
        path: absolutePath,
        relativePath: path.relative(rootPath, absolutePath) || ".",
        kind: entry.isDirectory() ? "directory" : "file",
        size: entry.isDirectory() ? 0 : stats.size,
        modifiedAt: stats.mtime.toISOString()
      } satisfies FileEntry;
    })
  );

  return results.sort((left, right) => {
    if (left.kind !== right.kind) {
      return left.kind === "directory" ? -1 : 1;
    }
    return left.relativePath.localeCompare(right.relativePath);
  });
}

export async function createManagedFolder(rootKey: BrowserRoot, projectSlug: string, relativePath: string, folderName: string): Promise<string> {
  const rootPath = getManagedRoot(rootKey, projectSlug);
  const targetDirectory = assertInsideRoot(rootPath, path.join(rootPath, relativePath, folderName));
  await fsp.mkdir(targetDirectory, { recursive: true });
  return targetDirectory;
}

export async function deleteManagedFolder(rootKey: BrowserRoot, projectSlug: string, relativePath: string): Promise<void> {
  const rootPath = getManagedRoot(rootKey, projectSlug);
  const targetDirectory = assertInsideRoot(rootPath, path.join(rootPath, relativePath));
  await fsp.rm(targetDirectory, { recursive: true, force: true });
}

export async function renameManagedFolder(
  rootKey: BrowserRoot,
  projectSlug: string,
  relativePath: string,
  nextName: string
): Promise<string> {
  const rootPath = getManagedRoot(rootKey, projectSlug);
  const currentDirectory = assertInsideRoot(rootPath, path.join(rootPath, relativePath));
  const parentRelativePath = path.dirname(relativePath);
  const targetDirectory = assertInsideRoot(
    rootPath,
    path.join(rootPath, parentRelativePath === "." ? "" : parentRelativePath, nextName)
  );
  await fsp.rename(currentDirectory, targetDirectory);
  return path.relative(rootPath, targetDirectory) || ".";
}

export async function listManagedDirectories(rootKey: BrowserRoot, projectSlug: string): Promise<string[]> {
  const rootPath = getManagedRoot(rootKey, projectSlug);
  await fsp.mkdir(rootPath, { recursive: true });
  const directories = ["."];
  await walkManagedDirectories(rootPath, rootPath, directories);
  return directories.sort((left, right) => left.localeCompare(right));
}

async function walkManagedDirectories(rootPath: string, currentPath: string, directories: string[]): Promise<void> {
  const entries = await fsp.readdir(currentPath, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const absolutePath = path.join(currentPath, entry.name);
    const relativePath = path.relative(rootPath, absolutePath) || ".";
    directories.push(relativePath);
    await walkManagedDirectories(rootPath, absolutePath, directories);
  }
}

function getManagedRoot(rootKey: BrowserRoot, projectSlug: string): string {
  const destinations = getDestinationSettings();
  const baseRoot =
    rootKey === "project"
      ? destinations.projectRoot
      : rootKey === "destA"
        ? destinations.destinationA
        : rootKey === "destB"
          ? destinations.destinationB
          : rootKey === "destC"
            ? destinations.destinationC
            : destinations.destinationA;

  return assertInsideRoot(baseRoot, path.join(baseRoot, projectSlug));
}
