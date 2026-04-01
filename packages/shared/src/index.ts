import { z } from "zod";

export const jobStatuses = [
  "queued",
  "scanning",
  "copyingToProject",
  "hashingProject",
  "copyingToDestinations",
  "verifyingDestinations",
  "completed",
  "failed",
  "cancelled"
] as const;

export type JobStatus = (typeof jobStatuses)[number];

export const volumeSchema = z.object({
  id: z.string(),
  name: z.string(),
  mountPath: z.string(),
  deviceIdentifier: z.string().nullable(),
  sizeBytes: z.number().nullable(),
  removable: z.boolean(),
  writable: z.boolean(),
  fileSystem: z.string().nullable(),
  insertedAt: z.string(),
  lastSeenAt: z.string()
});

export type Volume = z.infer<typeof volumeSchema>;

export const projectSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  path: z.string(),
  createdAt: z.string()
});

export type Project = z.infer<typeof projectSchema>;

export const fileEntrySchema = z.object({
  path: z.string(),
  relativePath: z.string(),
  kind: z.enum(["file", "directory"]),
  size: z.number(),
  modifiedAt: z.string()
});

export type FileEntry = z.infer<typeof fileEntrySchema>;

export const sourceSelectionSchema = z.object({
  sourcePath: z.string(),
  targetPath: z.string().default(".")
});

export type SelectedSourceItem = z.infer<typeof sourceSelectionSchema>;

export const sourceGroupSchema = z.object({
  volumeId: z.string(),
  sourceRoot: z.string().optional().default(""),
  entries: z.array(sourceSelectionSchema).min(1)
});

export type SourceSelection = z.infer<typeof sourceGroupSchema>;

export const ingestRequestSchema = z.object({
  projectId: z.string(),
  sources: z.array(sourceGroupSchema).min(1)
});

export type IngestRequest = z.infer<typeof ingestRequestSchema>;

export const jobSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  volumeId: z.string(),
  sourceRoot: z.string(),
  status: z.enum(jobStatuses),
  createdAt: z.string(),
  updatedAt: z.string(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  error: z.string().nullable(),
  summary: z.string().nullable()
});

export type Job = z.infer<typeof jobSchema>;

export const jobEventSchema = z.object({
  id: z.string(),
  jobId: z.string(),
  stage: z.string(),
  message: z.string(),
  createdAt: z.string()
});

export type JobEvent = z.infer<typeof jobEventSchema>;

export const copyRecordSchema = z.object({
  id: z.string(),
  jobId: z.string(),
  relativePath: z.string(),
  destinationKind: z.enum(["project", "destA", "destB", "destC", "destD"]),
  absolutePath: z.string(),
  checksum: z.string().nullable(),
  size: z.number(),
  verifiedAt: z.string().nullable(),
  createdAt: z.string()
});

export type CopyRecord = z.infer<typeof copyRecordSchema>;

export const browserRootSchema = z.enum(["project", "destA", "destB", "destC", "destD"]);
export type BrowserRoot = z.infer<typeof browserRootSchema>;

export function slugifyProjectName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}
