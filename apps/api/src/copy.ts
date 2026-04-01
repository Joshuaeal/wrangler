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
  ".fseventsd",
  ".DS_Store"
]);

export async function runJob(jobId: string): Promise<void> {
  const project = getProjectByIdForJob(jobId);
  const selectedSources = getSelectedSources(jobId);
  const destinations = getDestinationSettings();
  const totalSelections = selectedSources.reduce((sum, source) => sum + source.entries.length, 0);
  const sourcePlan = await buildSourceTransferPlan(selectedSources);
  const sourceBytesTotal = [...sourcePlan.values()].reduce((sum, item) => sum + item.bytes, 0);

  clearCopyRecords(jobId);

  updateJobStatus(jobId, "scanning", { summary: "Scanning selected files" });
  addJobEvent(jobId, "scanning", `Scanning ${totalSelections} selected paths from ${selectedSources.length} source volume(s).`);

  const projectRoot = assertInsideRoot(destinations.projectRoot, path.join(destinations.projectRoot, project.slug));
  await fsp.mkdir(projectRoot, { recursive: true });

  updateJobStatus(jobId, "copyingToProject", { summary: "Copying source files into the project folder" });
  for (const source of selectedSources) {
    await syncSelectedPaths(jobId, source, projectRoot, "project", sourcePlan, sourceBytesTotal);
  }

  updateJobStatus(jobId, "hashingProject", { summary: "Generating checksums for the project copy" });
  await checksumDestination(jobId, projectRoot, "project", true);

  const enabledDestinations = [
    { kind: "destA" as const, label: "Destination A", root: destinations.destinationA, enabled: true },
    { kind: "destB" as const, label: "Destination B", root: destinations.destinationB, enabled: destinations.destinationBEnabled },
    { kind: "destC" as const, label: "Destination C", root: destinations.destinationC, enabled: destinations.destinationCEnabled }
  ].filter((destination) => destination.enabled);

  for (const destination of enabledDestinations) {
    const destinationRoot = getDestinationRoot(jobId, destination.root, destination.kind);
    const destinationPlan = await collectFileStats(projectRoot);
    const destinationBytesTotal = destinationPlan.reduce((sum, item) => sum + item.size, 0);
    updateJobStatus(jobId, "copyingToDestinations", {
      summary: `Copying to ${destination.label}: 0 B / ${formatTransferSize(destinationBytesTotal)}`
    });
    await syncDirectory(jobId, projectRoot, destination.root, destination.kind, destinationBytesTotal, destination.label, destinationRoot);

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
  destinationKind: DestinationKind,
  sourcePlan: Map<string, { bytes: number; files: number }>,
  sourceBytesTotal: number
): Promise<void> {
  let copiedCount = 0;
  let copiedBytes = 0;

  for (const entry of source.entries) {
    if (shouldIgnoreEntry(path.basename(entry.sourcePath))) {
      addJobEvent(jobId, destinationKind, `Skipped hidden system file ${entry.sourcePath}.`);
      continue;
    }

    const targetRoot = assertInsideRoot(destinationRoot, path.join(destinationRoot, entry.targetPath || "."));
    await fsp.mkdir(targetRoot, { recursive: true });
    try {
      const planKey = `${source.volumeId}:${entry.sourcePath}`;
      const planned = sourcePlan.get(planKey) ?? { bytes: 0, files: 0 };
      updateJobStatus(jobId, "copyingToProject", {
        summary: `Copying to project: ${formatTransferSize(copiedBytes)} / ${formatTransferSize(sourceBytesTotal)} | ${entry.sourcePath}`
      });
      await syncSingleSelection(source.sourceRoot ?? "", targetRoot, entry.sourcePath);
      copiedBytes += planned.bytes;
      updateJobStatus(jobId, "copyingToProject", {
        summary: `Copying to project: ${formatTransferSize(copiedBytes)} / ${formatTransferSize(sourceBytesTotal)} | ${entry.sourcePath}`
      });
    } catch (error) {
      if (isIgnorableFsError(error)) {
        addJobEvent(jobId, destinationKind, `Skipped inaccessible source item ${entry.sourcePath}.`);
        continue;
      }
      throw error;
    }
    copiedCount += 1;
  }

  addJobEvent(jobId, destinationKind, `Copied ${copiedCount} selected source item(s) into ${destinationRoot}.`);
}

export async function syncDirectory(
  jobId: string,
  sourceRoot: string,
  destinationBase: string,
  destinationKind: DestinationKind,
  totalBytes: number,
  destinationLabel: string,
  destinationRoot: string
): Promise<void> {
  const project = getProjectByIdForJob(jobId);
  const jobDestinationRoot = path.join(destinationBase, project.slug);
  await fsp.mkdir(jobDestinationRoot, { recursive: true });

  await runRsync(["-a", "--info=progress2", appendSlash(sourceRoot), appendSlash(jobDestinationRoot)], (progressBytes) => {
    updateJobStatus(jobId, "copyingToDestinations", {
      summary: `Copying to ${destinationLabel}: ${formatTransferSize(progressBytes)} / ${formatTransferSize(totalBytes)}`
    });
  });
  updateJobStatus(jobId, "copyingToDestinations", {
    summary: `Copying to ${destinationLabel}: ${formatTransferSize(totalBytes)} / ${formatTransferSize(totalBytes)}`
  });
  addJobEvent(jobId, destinationKind, `Mirrored ${sourceRoot} into ${destinationRoot}.`);
}

export async function checksumDestination(
  jobId: string,
  destinationBase: string,
  destinationKind: DestinationKind,
  overwrite: boolean
): Promise<void> {
  const destinationRoot = getDestinationRoot(jobId, destinationBase, destinationKind);
  const files = await collectFileStats(destinationRoot);
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

  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  let processedBytes = 0;

  for (const file of files) {
    const relativePath = path.relative(destinationRoot, file.path);
    updateJobStatus(jobId, destinationKind === "project" ? "hashingProject" : "verifyingDestinations", {
      summary: `${destinationKind === "project" ? "Checksumming project" : `Verifying ${destinationKind}`}: ${formatTransferSize(processedBytes)} / ${formatTransferSize(totalBytes)} | ${relativePath}`
    });
    const checksum = await sha256File(file.path);

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
      absolutePath: file.path,
      checksum,
      size: file.size,
      verifiedAt: new Date().toISOString()
    });
    processedBytes += file.size;
  }

  if (manifest && manifest.size !== files.length) {
    throw new Error(`Destination ${destinationKind} file count does not match the project manifest.`);
  }

  addJobEvent(jobId, destinationKind, `Checksummed ${files.length} files in ${destinationRoot}.`);
}

async function collectFileStats(root: string): Promise<Array<{ path: string; size: number }>> {
  const entries = await fsp.readdir(root, { withFileTypes: true });
  const files: Array<{ path: string; size: number }> = [];

  for (const entry of entries) {
    if (shouldIgnoreEntry(entry.name)) {
      continue;
    }

    const absolutePath = path.join(root, entry.name);
    try {
      if (entry.isDirectory()) {
        files.push(...(await collectFileStats(absolutePath)));
      } else if (entry.isFile()) {
        const stats = await fsp.stat(absolutePath);
        files.push({ path: absolutePath, size: stats.size });
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

async function runRsync(args: string[], onProgress?: (bytes: number) => void): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("rsync", args, { stdio: "pipe" });
    let stderr = "";

    const parseProgress = (chunk: Buffer) => {
      if (!onProgress) {
        return;
      }

      const lines = chunk
        .toString()
        .split(/\r|\n/)
        .map((line) => line.trim());

      for (const line of lines) {
        const match = line.match(/^([\d,]+)\s+\d+%/);
        if (!match) {
          continue;
        }
        onProgress(Number(match[1].replace(/,/g, "")));
      }
    };

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      parseProgress(chunk);
    });

    child.stdout.on("data", (chunk) => {
      parseProgress(chunk);
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

function shouldIgnoreEntry(name: string): boolean {
  return ignoredVolumeEntries.has(name) || name.startsWith("._");
}

async function buildSourceTransferPlan(sources: SourceSelection[]): Promise<Map<string, { bytes: number; files: number }>> {
  const plan = new Map<string, { bytes: number; files: number }>();

  for (const source of sources) {
    for (const entry of source.entries) {
      const absoluteSourcePath = path.join(source.sourceRoot ?? "", entry.sourcePath);
      try {
        const stats = await fsp.stat(absoluteSourcePath);
        if (stats.isDirectory()) {
          const files = await collectFileStats(absoluteSourcePath);
          plan.set(`${source.volumeId}:${entry.sourcePath}`, {
            bytes: files.reduce((sum, file) => sum + file.size, 0),
            files: files.length
          });
          continue;
        }

        plan.set(`${source.volumeId}:${entry.sourcePath}`, { bytes: stats.size, files: 1 });
      } catch (error) {
        if (isIgnorableFsError(error)) {
          plan.set(`${source.volumeId}:${entry.sourcePath}`, { bytes: 0, files: 0 });
          continue;
        }
        throw error;
      }
    }
  }

  return plan;
}

function formatTransferSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const precision = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(precision)} ${units[unitIndex]}`;
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
