import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { config } from "./config.js";
import { getDestinationSettings } from "./destination-settings.js";
import {
  addJobEvent,
  clearCopyRecords,
  clearCopyRecordsForDestination,
  getJobById,
  getProjectById,
  getSelectedSources,
  listCopyRecords,
  saveCopyRecord,
  updateJobStatus
} from "./db.js";
import { assertInsideRoot } from "./paths.js";
import type { SourceSelection } from "@wrangler/shared";

type DestinationKind = "project" | "destA" | "destB" | "destC" | "destD";
const ignoredVolumeEntries = new Set([
  ".DocumentRevisions-V100",
  ".Spotlight-V100",
  ".Trashes",
  ".TemporaryItems",
  ".fseventsd"
]);

export async function runJob(jobId: string): Promise<void> {
  const project = getProjectByIdForJob(jobId);
  const selectedSources = getSelectedSources(jobId);
  const destinations = getDestinationSettings();
  const totalSelections = selectedSources.reduce((sum, source) => sum + source.entries.length, 0);

  clearCopyRecords(jobId);

  updateJobStatus(jobId, "scanning", { summary: "Scanning selected files" });
  addJobEvent(jobId, "scanning", `Scanning ${totalSelections} selected paths from ${selectedSources.length} source volume(s).`);

  const projectRoot = assertInsideRoot(destinations.projectRoot, path.join(destinations.projectRoot, project.slug));
  await fsp.mkdir(projectRoot, { recursive: true });

  updateJobStatus(jobId, "copyingToProject", { summary: "Copying source files into the project folder" });
  for (const source of selectedSources) {
    await syncSelectedPaths(jobId, source, projectRoot, "project");
  }

  updateJobStatus(jobId, "hashingProject", { summary: "Generating checksums for the project copy" });
  await checksumDestination(jobId, projectRoot, "project", true);

  const enabledDestinations = [
    { kind: "destA" as const, label: "Destination A", root: destinations.destinationA, enabled: true },
    { kind: "destB" as const, label: "Destination B", root: destinations.destinationB, enabled: destinations.destinationBEnabled },
    { kind: "destC" as const, label: "Destination C", root: destinations.destinationC, enabled: destinations.destinationCEnabled }
  ].filter((destination) => destination.enabled);

  for (const destination of enabledDestinations) {
    updateJobStatus(jobId, "copyingToDestinations", { summary: `Copying the project folder to ${destination.label}` });
    await syncDirectory(jobId, projectRoot, destination.root, destination.kind);

    updateJobStatus(jobId, "verifyingDestinations", { summary: `Verifying ${destination.label} against the project manifest` });
    await checksumDestination(jobId, destination.root, destination.kind, false);
  }

  updateJobStatus(jobId, "completed", { summary: "Ingest completed successfully.", error: null });
  addJobEvent(jobId, "completed", "Ingest completed successfully.");
}

export async function syncSelectedPaths(
  jobId: string,
  source: SourceSelection,
  destinationRoot: string,
  destinationKind: DestinationKind
): Promise<void> {
  let copiedCount = 0;

  for (const entry of source.entries) {
    const targetRoot = assertInsideRoot(destinationRoot, path.join(destinationRoot, entry.targetPath || "."));
    await fsp.mkdir(targetRoot, { recursive: true });
    await syncSingleSelection(source.sourceRoot ?? "", targetRoot, entry.sourcePath);
    copiedCount += 1;
  }

  addJobEvent(jobId, destinationKind, `Copied ${copiedCount} selected source item(s) into ${destinationRoot}.`);
}

export async function syncDirectory(jobId: string, sourceRoot: string, destinationBase: string, destinationKind: DestinationKind): Promise<void> {
  const project = getProjectByIdForJob(jobId);
  const destinationRoot = path.join(destinationBase, project.slug);
  await fsp.mkdir(destinationRoot, { recursive: true });

  await runRsync(["-a", appendSlash(sourceRoot), appendSlash(destinationRoot)]);
  addJobEvent(jobId, destinationKind, `Mirrored ${sourceRoot} into ${destinationRoot}.`);
}

export async function checksumDestination(
  jobId: string,
  destinationBase: string,
  destinationKind: DestinationKind,
  overwrite: boolean
): Promise<void> {
  const destinationRoot = getDestinationRoot(jobId, destinationBase, destinationKind);
  const files = await walkFiles(destinationRoot);
  if (overwrite) {
    clearCopyRecordsForDestination(jobId, destinationKind);
  }

  const manifest =
    destinationKind === "project"
      ? null
      : new Map(
          listCopyRecords(jobId)
            .filter((record) => record.destinationKind === "project")
            .map((record) => [record.relativePath, record.checksum])
        );

  for (const filePath of files) {
    const relativePath = path.relative(destinationRoot, filePath);
    const stats = await fsp.stat(filePath);
    const checksum = await sha256File(filePath);

     if (manifest) {
      const expectedChecksum = manifest.get(relativePath);
      if (!expectedChecksum) {
        throw new Error(`Destination ${destinationKind} contains unexpected file ${relativePath}`);
      }
      if (expectedChecksum !== checksum) {
        throw new Error(`Checksum mismatch for ${relativePath} in ${destinationKind}`);
      }
    }

    saveCopyRecord({
      jobId,
      relativePath,
      destinationKind,
      absolutePath: filePath,
      checksum,
      size: stats.size,
      verifiedAt: new Date().toISOString()
    });
  }

  if (manifest && manifest.size !== files.length) {
    throw new Error(`Destination ${destinationKind} file count does not match the project manifest.`);
  }

  addJobEvent(jobId, destinationKind, `Checksummed ${files.length} files in ${destinationRoot}.`);
}

async function walkFiles(root: string): Promise<string[]> {
  const entries = await fsp.readdir(root, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    if (ignoredVolumeEntries.has(entry.name)) {
      continue;
    }

    const absolutePath = path.join(root, entry.name);
    try {
      if (entry.isDirectory()) {
        files.push(...(await walkFiles(absolutePath)));
      } else if (entry.isFile()) {
        files.push(absolutePath);
      }
    } catch (error) {
      if (isIgnorableFsError(error)) {
        continue;
      }
      throw error;
    }
  }

  return files;
}

async function syncSingleSelection(sourceRoot: string, destinationRoot: string, selectedPath: string): Promise<void> {
  const absoluteSourcePath = path.join(sourceRoot, selectedPath);
  const fileName = path.basename(selectedPath);
  const stats = await fsp.stat(absoluteSourcePath);

  if (stats.isDirectory()) {
    const destinationPath = path.join(destinationRoot, fileName);
    await fsp.mkdir(destinationPath, { recursive: true });
    await runRsync(["-a", appendSlash(absoluteSourcePath), appendSlash(destinationPath)]);
    return;
  }

  await runRsync(["-a", absoluteSourcePath, appendSlash(destinationRoot)]);
}

async function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);

    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

async function runRsync(args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("rsync", args, { stdio: "pipe" });
    let stderr = "";

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(stderr || `rsync exited with code ${code}`));
    });
  });
}

function appendSlash(input: string): string {
  return input.endsWith(path.sep) ? input : `${input}${path.sep}`;
}

function isIgnorableFsError(error: unknown): boolean {
  return error instanceof Error && "code" in error && (
    error.code === "ENOENT" ||
    error.code === "EPERM" ||
    error.code === "EACCES"
  );
}

function getProjectByIdForJob(jobId: string) {
  const job = getJobOrThrow(jobId);
  const project = getProjectById(job.projectId);
  if (!project) {
    throw new Error(`Project not found for job ${jobId}`);
  }
  return project;
}

function getDestinationRoot(jobId: string, destinationBase: string, destinationKind: DestinationKind): string {
  if (destinationKind === "project") {
    return destinationBase;
  }

  const project = getProjectByIdForJob(jobId);
  return path.join(destinationBase, project.slug);
}

function getJobOrThrow(jobId: string) {
  const job = getJobById(jobId);
  if (!job) {
    throw new Error(`Job not found: ${jobId}`);
  }
  return job;
}
