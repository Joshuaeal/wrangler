import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { nanoid } from "nanoid";
import type { CopyRecord, FileEntry, Job, JobEvent, JobStatus, Project, SourceSelection } from "@wrangler/shared";
import { config } from "./config.js";

fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });

const db = new Database(config.databasePath);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    path TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    volume_id TEXT NOT NULL,
    source_root TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT,
    error TEXT,
    summary TEXT
  );

  CREATE TABLE IF NOT EXISTS job_selected_paths (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    volume_id TEXT NOT NULL,
    source_root TEXT NOT NULL,
    relative_path TEXT NOT NULL,
    target_path TEXT NOT NULL DEFAULT '.'
  );

  CREATE TABLE IF NOT EXISTS job_events (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    stage TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS copy_records (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    relative_path TEXT NOT NULL,
    destination_kind TEXT NOT NULL,
    absolute_path TEXT NOT NULL,
    checksum TEXT,
    size INTEGER NOT NULL,
    verified_at TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
`);

runMigrations();

function now(): string {
  return new Date().toISOString();
}

function runMigrations(): void {
  ensureColumn("job_selected_paths", "volume_id", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("job_selected_paths", "source_root", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("job_selected_paths", "target_path", "TEXT NOT NULL DEFAULT '.'");
}

function ensureColumn(tableName: string, columnName: string, columnDefinition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  if (columns.some((column) => column.name === columnName)) {
    return;
  }

  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition}`);
}

export function createProject(input: { name: string; slug: string; path: string }): Project {
  const createdAt = now();
  const project = {
    id: nanoid(),
    name: input.name,
    slug: input.slug,
    path: input.path,
    createdAt
  };

  db.prepare("INSERT INTO projects (id, name, slug, path, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(project.id, project.name, project.slug, project.path, project.createdAt);

  return project;
}

export function listProjects(): Project[] {
  return db.prepare("SELECT id, name, slug, path, created_at FROM projects ORDER BY created_at DESC")
    .all()
    .map((row: any) => ({
      id: row.id,
      name: row.name,
      slug: row.slug,
      path: row.path,
      createdAt: row.created_at
    }));
}

export function getProjectById(projectId: string): Project | null {
  const row = db.prepare("SELECT id, name, slug, path, created_at FROM projects WHERE id = ?").get(projectId) as any;
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    path: row.path,
    createdAt: row.created_at
  };
}

export function deleteAllProjects(): void {
  const transaction = db.transaction(() => {
    db.prepare("DELETE FROM job_selected_paths WHERE job_id IN (SELECT id FROM jobs)").run();
    db.prepare("DELETE FROM job_events WHERE job_id IN (SELECT id FROM jobs)").run();
    db.prepare("DELETE FROM copy_records WHERE job_id IN (SELECT id FROM jobs)").run();
    db.prepare("DELETE FROM jobs").run();
    db.prepare("DELETE FROM projects").run();
  });

  transaction();
}

export function createJob(input: { projectId: string; sources: SourceSelection[] }): Job {
  const createdAt = now();
  const primarySource = input.sources[0];
  const job: Job = {
    id: nanoid(),
    projectId: input.projectId,
    volumeId: input.sources.length > 1 ? "multiple" : primarySource.volumeId,
    sourceRoot: input.sources.length > 1 ? "multiple" : primarySource.sourceRoot ?? "",
    status: "queued",
    createdAt,
    updatedAt: createdAt,
    startedAt: null,
    completedAt: null,
    error: null,
    summary: null
  };

  const transaction = db.transaction(() => {
    db.prepare(`
      INSERT INTO jobs (id, project_id, volume_id, source_root, status, created_at, updated_at, started_at, completed_at, error, summary)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      job.id,
      job.projectId,
      job.volumeId,
      job.sourceRoot,
      job.status,
      job.createdAt,
      job.updatedAt,
      job.startedAt,
      job.completedAt,
      job.error,
      job.summary
    );

    const statement = db.prepare(
      "INSERT INTO job_selected_paths (id, job_id, volume_id, source_root, relative_path, target_path) VALUES (?, ?, ?, ?, ?, ?)"
    );
    for (const source of input.sources) {
      for (const entry of source.entries) {
        statement.run(nanoid(), job.id, source.volumeId, source.sourceRoot ?? "", entry.sourcePath, entry.targetPath);
      }
    }
  });

  transaction();
  const totalSelections = input.sources.reduce((sum, source) => sum + source.entries.length, 0);
  addJobEvent(job.id, "queued", `Queued ingest for ${totalSelections} selections across ${input.sources.length} source volume(s).`);
  return job;
}

export function listJobs(): Job[] {
  return db.prepare(`
    SELECT id, project_id, volume_id, source_root, status, created_at, updated_at, started_at, completed_at, error, summary
    FROM jobs
    ORDER BY created_at DESC
  `).all().map(mapJobRow);
}

export function getJobById(jobId: string): Job | null {
  const row = db.prepare(`
    SELECT id, project_id, volume_id, source_root, status, created_at, updated_at, started_at, completed_at, error, summary
    FROM jobs WHERE id = ?
  `).get(jobId) as any;

  return row ? mapJobRow(row) : null;
}

export function deleteJob(jobId: string): void {
  const job = getJobById(jobId);
  if (!job) {
    return;
  }

  const deletableStatuses: JobStatus[] = ["queued", "completed", "failed", "cancelled"];
  if (!deletableStatuses.includes(job.status)) {
    throw new Error(`Cannot delete job in status ${job.status}`);
  }

  const transaction = db.transaction(() => {
    db.prepare("DELETE FROM job_selected_paths WHERE job_id = ?").run(jobId);
    db.prepare("DELETE FROM job_events WHERE job_id = ?").run(jobId);
    db.prepare("DELETE FROM copy_records WHERE job_id = ?").run(jobId);
    db.prepare("DELETE FROM jobs WHERE id = ?").run(jobId);
  });

  transaction();
}

export function updateJobStatus(jobId: string, status: JobStatus, patch: { error?: string | null; summary?: string | null } = {}): void {
  const updatedAt = now();
  const current = getJobById(jobId);
  if (!current) {
    throw new Error(`Job not found: ${jobId}`);
  }

  const startedAt = current.startedAt ?? (status !== "queued" ? updatedAt : null);
  const completedAt = ["completed", "failed", "cancelled"].includes(status) ? updatedAt : null;

  db.prepare(`
    UPDATE jobs
    SET status = ?, updated_at = ?, started_at = ?, completed_at = ?, error = ?, summary = ?
    WHERE id = ?
  `).run(
    status,
    updatedAt,
    startedAt,
    completedAt,
    patch.error ?? current.error,
    patch.summary ?? current.summary,
    jobId
  );
}

export function getQueuedJob(): Job | null {
  const row = db.prepare(`
    SELECT id, project_id, volume_id, source_root, status, created_at, updated_at, started_at, completed_at, error, summary
    FROM jobs
    WHERE status = 'queued'
    ORDER BY created_at ASC
    LIMIT 1
  `).get() as any;

  return row ? mapJobRow(row) : null;
}

export function getSelectedSources(jobId: string): SourceSelection[] {
  const rows = db.prepare(
    "SELECT volume_id, source_root, relative_path, target_path FROM job_selected_paths WHERE job_id = ? ORDER BY volume_id ASC, relative_path ASC"
  ).all(jobId) as any[];

  const grouped = new Map<string, SourceSelection>();
  for (const row of rows) {
    const key = `${row.volume_id}:${row.source_root}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.entries.push({
        sourcePath: row.relative_path,
        targetPath: row.target_path
      });
      continue;
    }

    grouped.set(key, {
      volumeId: row.volume_id,
      sourceRoot: row.source_root,
      entries: [{
        sourcePath: row.relative_path,
        targetPath: row.target_path
      }]
    });
  }

  return [...grouped.values()];
}

export function addJobEvent(jobId: string, stage: string, message: string): JobEvent {
  const event: JobEvent = {
    id: nanoid(),
    jobId,
    stage,
    message,
    createdAt: now()
  };

  db.prepare("INSERT INTO job_events (id, job_id, stage, message, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(event.id, event.jobId, event.stage, event.message, event.createdAt);

  return event;
}

export function listJobEvents(jobId: string): JobEvent[] {
  return db.prepare("SELECT id, job_id, stage, message, created_at FROM job_events WHERE job_id = ? ORDER BY created_at ASC")
    .all(jobId)
    .map((row: any) => ({
      id: row.id,
      jobId: row.job_id,
      stage: row.stage,
      message: row.message,
      createdAt: row.created_at
    }));
}

export function saveCopyRecord(record: Omit<CopyRecord, "id" | "createdAt">): CopyRecord {
  const saved: CopyRecord = {
    ...record,
    id: nanoid(),
    createdAt: now()
  };

  db.prepare(`
    INSERT INTO copy_records (id, job_id, relative_path, destination_kind, absolute_path, checksum, size, verified_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    saved.id,
    saved.jobId,
    saved.relativePath,
    saved.destinationKind,
    saved.absolutePath,
    saved.checksum,
    saved.size,
    saved.verifiedAt,
    saved.createdAt
  );

  return saved;
}

export function clearCopyRecords(jobId: string): void {
  db.prepare("DELETE FROM copy_records WHERE job_id = ?").run(jobId);
}

export function clearCopyRecordsForDestination(jobId: string, destinationKind: string): void {
  db.prepare("DELETE FROM copy_records WHERE job_id = ? AND destination_kind = ?").run(jobId, destinationKind);
}

export function listCopyRecords(jobId: string): CopyRecord[] {
  return db.prepare(`
    SELECT id, job_id, relative_path, destination_kind, absolute_path, checksum, size, verified_at, created_at
    FROM copy_records
    WHERE job_id = ?
    ORDER BY relative_path ASC
  `).all(jobId).map((row: any) => ({
    id: row.id,
    jobId: row.job_id,
    relativePath: row.relative_path,
    destinationKind: row.destination_kind,
    absolutePath: row.absolute_path,
    checksum: row.checksum,
    size: row.size,
    verifiedAt: row.verified_at,
    createdAt: row.created_at
  }));
}

export function listFilesForJob(jobId: string): FileEntry[] {
  return listCopyRecords(jobId)
    .filter((record) => record.destinationKind === "project")
    .map((record) => ({
      path: record.absolutePath,
      relativePath: record.relativePath,
      kind: "file",
      size: record.size,
      modifiedAt: record.createdAt
    }));
}

export function hasUsers(): boolean {
  const row = db.prepare("SELECT COUNT(*) as count FROM users").get() as { count: number };
  return row.count > 0;
}

export function createInitialUser(input: { username: string; password: string }): { id: string; username: string } {
  if (hasUsers()) {
    throw new Error("An account has already been created.");
  }

  const username = input.username.trim();
  if (!username) {
    throw new Error("Username is required.");
  }
  if (input.password.length < 8) {
    throw new Error("Password must be at least 8 characters.");
  }

  const user = {
    id: nanoid(),
    username,
    passwordHash: hashPassword(input.password),
    createdAt: now()
  };

  db.prepare("INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)")
    .run(user.id, user.username, user.passwordHash, user.createdAt);

  return { id: user.id, username: user.username };
}

export function verifyUserCredentials(username: string, password: string): { id: string; username: string } | null {
  const row = db.prepare("SELECT id, username, password_hash FROM users WHERE username = ?").get(username.trim()) as
    | { id: string; username: string; password_hash: string }
    | undefined;

  if (!row || !verifyPassword(password, row.password_hash)) {
    return null;
  }

  return { id: row.id, username: row.username };
}

export function createSession(userId: string, durationDays = 30): { token: string; expiresAt: string } {
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + durationDays * 24 * 60 * 60 * 1000).toISOString();

  db.prepare("INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)")
    .run(nanoid(), userId, hashToken(token), now(), expiresAt);

  return { token, expiresAt };
}

export function getUserBySessionToken(token: string): { id: string; username: string } | null {
  const row = db.prepare(`
    SELECT users.id, users.username, sessions.expires_at
    FROM sessions
    JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ?
  `).get(hashToken(token)) as
    | { id: string; username: string; expires_at: string }
    | undefined;

  if (!row) {
    return null;
  }

  if (new Date(row.expires_at).getTime() <= Date.now()) {
    deleteSession(token);
    return null;
  }

  return { id: row.id, username: row.username };
}

export function deleteSession(token: string): void {
  db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashToken(token));
}

export function deleteExpiredSessions(): void {
  db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now());
}

function mapJobRow(row: any): Job {
  return {
    id: row.id,
    projectId: row.project_id,
    volumeId: row.volume_id,
    sourceRoot: row.source_root,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    error: row.error,
    summary: row.summary
  };
}

function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const derivedKey = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${derivedKey}`;
}

function verifyPassword(password: string, storedHash: string): boolean {
  const [salt, expected] = storedHash.split(":");
  if (!salt || !expected) {
    return false;
  }

  const actual = crypto.scryptSync(password, salt, 64);
  const expectedBuffer = Buffer.from(expected, "hex");
  if (actual.length !== expectedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(actual, expectedBuffer);
}

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}
